/**
 * The website, one page, no framework (web/CLAUDE.md): sign in, your repositories, a
 * repository's live view, its members and invites, the prompt that sets up a developer's Claude,
 * and personal tokens. Routes live in the hash (#/, #/r/<owner>/<name>[/members|/setup],
 * #/account). The live view subscribes to the server's stream for one repository from LSN 0, so
 * the whole log replays and then stays live. Only types come from @pitstop/protocol: nothing from
 * node_modules reaches the browser.
 */
import type { Changeset, ClientMessage, Intent, Repo, ServerMessage } from "@pitstop/protocol";

/** `DEFAULT_REPO` in the protocol; a value import would pull zod into the page. */
const DEFAULT_REPO = "local/default";
const TOKEN_KEY = "pitstop.token";
const RECONNECT_MS = 2_000;
/** How often the worktrees are re-read while the stream is up; every entry re-reads them too. */
const WORKTREES_MS = 3_000;
const MAX_EVENTS = 200;

/**
 * One connected worktree, from `GET /repos/:owner/:name/worktrees` (`WorktreesResponse` in
 * server/src/app.ts: a server query, not a protocol message). `agent` is there while the
 * worktree has an open intent; between tasks the heartbeat names nobody.
 */
interface Worktree {
  appliedLsn: number;
  intentId?: string;
  agent?: string;
}

type EventKind = "entry" | "repair" | "skew" | "intent" | "warning" | "info";
interface Event {
  at: Date;
  kind: EventKind;
  text: string;
  lsn?: number;
}

const state = {
  repo: DEFAULT_REPO,
  head: null as number | null,
  entries: new Map<number, Changeset>(),
  intents: new Map<string, Intent>(),
  worktrees: [] as Worktree[],
  events: [] as Event[],
  selected: null as number | null,
  /** Entries that landed while the page was watching: they get the landing animation. */
  live: new Set<number>(),
  /** Where the current subscription started and what head was then: the replay in between is silent. */
  subscribedFrom: 0,
  headAtSubscribe: 0,
};

let token = localStorage.getItem(TOKEN_KEY) ?? "";
let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;

// --- DOM helpers ---------------------------------------------------------------------------------

type Child = string | Node | null | undefined | false;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`the page has no #${id}`);
  return node as T;
}

/** An element with attributes and children; strings become text nodes, so nothing is ever parsed as HTML. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

const plural = (n: number, word: string, words = `${word}s`): string => `${n} ${n === 1 ? word : words}`;

// --- the API -------------------------------------------------------------------------------------

const authHeaders = (): Record<string, string> => (token === "" ? {} : { authorization: `Bearer ${token}` });

/** A GET as JSON, or nothing. */
async function api<T>(path: string): Promise<T | undefined> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) return undefined;
  return (await res.json()) as T;
}

/** Any request; the session cookie rides along on its own. The body is JSON when there is one. */
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T | undefined }> {
  const headers: Record<string, string> = { ...authHeaders(), ...(body === undefined ? {} : { "content-type": "application/json" }) };
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let parsed: T | undefined;
  try {
    parsed = text === "" ? undefined : (JSON.parse(text) as T);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed };
}

const messageOf = (body: unknown, fallback: string): string =>
  typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : fallback;

/** Who is looking: a signed-in user (session cookie or personal token), the administrator's token, or nobody. */
interface Me {
  id: string;
  login: string;
  name?: string;
}
const session = { me: undefined as Me | undefined, accounts: false };
const signedIn = (): boolean => session.me !== undefined || token !== "";

// --- the stream ----------------------------------------------------------------------------------

const lastLsn = (): number => Math.max(0, ...state.entries.keys());

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function setConnected(on: boolean): void {
  const pill = $("conn");
  pill.textContent = on ? "live" : "offline";
  pill.className = `pill ${on ? "on" : "off"}`;
}

/** Stops following a repository: the page moved elsewhere. */
function disconnect(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const old = socket;
  socket = undefined;
  old?.close();
  setConnected(false);
}

function connect(): void {
  disconnect();

  const url = new URL("/stream", location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token !== "") url.searchParams.set("token", token);
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    setConnected(true);
    state.subscribedFrom = lastLsn();
    send({ type: "subscribe", repo: state.repo, fromLsn: state.subscribedFrom });
  };
  ws.onmessage = (ev) => handle(JSON.parse(String(ev.data)) as ServerMessage);
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (socket !== ws) return; // replaced on purpose
    setConnected(false);
    // What the worktrees had applied is as stale as the rest of the page now: shown again on reconnect.
    state.worktrees = [];
    renderWorktrees();
    reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
  };
}

/**
 * Re-reads the connected worktrees of the current repository. Their applied LSNs reach the server
 * through heartbeats, not the stream, so the page asks: every WORKTREES_MS while the socket is up,
 * on `head` after a subscribe, and after every entry that lands. One request at a time.
 */
let readingWorktrees = false;
async function pollWorktrees(): Promise<void> {
  if (readingWorktrees || socket?.readyState !== WebSocket.OPEN) return;
  readingWorktrees = true;
  const repo = state.repo;
  try {
    const res = await api<{ headLsn: number; worktrees: Worktree[] }>(`/repos/${repo}/worktrees`);
    if (res === undefined || repo !== state.repo) return;
    state.worktrees = res.worktrees;
    renderWorktrees();
  } finally {
    readingWorktrees = false;
  }
}

function handle(message: ServerMessage): void {
  switch (message.type) {
    case "hello":
      if ($("version").textContent === "") $("version").textContent = message.serverVersion.slice(0, 7);
      break;
    case "head":
      if (message.repo !== state.repo) break;
      state.headAtSubscribe = message.headLsn;
      if (state.head === null || message.headLsn > state.head) state.head = message.headLsn;
      renderHead();
      void pollWorktrees();
      break;
    case "entry":
      onEntry(message.changeset);
      break;
    case "intent":
      onIntent(message.intent);
      break;
    case "warning":
      if (message.repo === state.repo) addEvent("warning", `for ${message.agent}: ${message.message}`);
      break;
  }
}

/** The validator's note on an entry that landed with write skew (PITSTOP_VALIDATE=warn), if any. */
const skewOf = (cs: Changeset): string | undefined => (cs.checks.details?.startsWith("write skew") ? cs.checks.details : undefined);

function onEntry(cs: Changeset): void {
  if (cs.repo !== state.repo) return;
  const fresh = !state.entries.has(cs.lsn);
  state.entries.set(cs.lsn, cs);
  if (state.head === null || cs.lsn > state.head) state.head = cs.lsn;
  // The first subscription replays the whole log: one line for all of it, not one per entry.
  const replay = state.subscribedFrom === 0 && cs.lsn <= state.headAtSubscribe;
  if (fresh && !replay) {
    state.live.add(cs.lsn);
    addEvent("entry", `#${cs.lsn} landed: "${cs.intent}" by ${cs.author.agent}, ${plural(cs.files.length, "file")}`, cs.lsn);
    for (const r of cs.repairs) addEvent("repair", `#${cs.lsn} repaired against #${r.againstLsn} (${r.kind}): ${r.summary}`, cs.lsn);
    const skew = skewOf(cs);
    if (skew !== undefined) addEvent("skew", `#${cs.lsn} ${skew}`, cs.lsn);
  } else if (replay && cs.lsn === state.headAtSubscribe) {
    addEvent("info", `replayed ${plural(state.entries.size, "entry", "entries")} up to #${cs.lsn}`);
  }
  renderHead();
  renderLog();
  // The head moved, so every worktree is behind until its daemon applies: show who has caught up.
  // A replay is hundreds of entries at once; the `head` message already read the worktrees for it.
  if (!replay) void pollWorktrees();
  else renderWorktrees();
  if (state.selected === cs.lsn) renderDetail();
}

function onIntent(intent: Intent): void {
  if (intent.repo !== state.repo) return;
  const known = state.intents.has(intent.id);
  if (intent.status === "open") {
    state.intents.set(intent.id, intent);
    if (!known) addEvent("intent", `${intent.author.agent} intends: "${intent.text}"`);
  } else {
    state.intents.delete(intent.id);
    if (known) addEvent("intent", `${intent.author.agent}'s intent ${intent.status}: "${intent.text}"`);
  }
  renderIntents();
}

// --- rendering -----------------------------------------------------------------------------------

function renderHead(): void {
  $("head").textContent = state.head === null ? "head —" : `head #${state.head}`;
}

function badges(cs: Changeset): HTMLElement {
  const box = el("span", { class: "badges" });
  if (cs.repairs.length > 0) box.append(el("span", { class: "badge repair" }, "repaired"));
  if (skewOf(cs) !== undefined) box.append(el("span", { class: "badge warn" }, "write skew"));
  if (cs.sigWriteSet.length > 0) box.append(el("span", { class: "badge warn" }, plural(cs.sigWriteSet.length, "signature")));
  if (cs.checks.typecheck !== "skipped") {
    box.append(el("span", { class: `badge ${cs.checks.typecheck === "pass" ? "ok" : "bad"}` }, `tsc ${cs.checks.typecheck}`));
  }
  return box;
}

function row(cs: Changeset): HTMLElement {
  const classes = [cs.lsn === state.selected ? "selected" : "", state.live.has(cs.lsn) ? "live" : ""].join(" ").trim();
  const li = el(
    "li",
    { class: classes },
    el("span", { class: "lsn" }, `#${cs.lsn}`),
    el("span", { class: "intent", title: cs.intent }, cs.intent),
    badges(cs),
    el(
      "span",
      { class: "meta" },
      el("span", { class: "agent" }, cs.author.agent),
      el("span", {}, cs.author.developer),
      el("span", {}, plural(cs.files.length, "file")),
      el("span", {}, `base #${cs.baseLsn}`),
      el("span", {}, timeAgo(cs.createdAt)),
    ),
    ...cs.repairs.map((r) => el("span", { class: "repair-line" }, `repaired against #${r.againstLsn} (${r.kind}): ${r.summary}`)),
  );
  li.addEventListener("click", () => select(cs.lsn));
  return li;
}

function renderLog(): void {
  const sorted = [...state.entries.values()].sort((a, b) => b.lsn - a.lsn);
  $("count").textContent = sorted.length === 0 ? "" : plural(sorted.length, "entry", "entries");
  $("empty").hidden = sorted.length > 0;
  $("log").replaceChildren(...sorted.map(row));
}

const symbols = (list: string[]): HTMLElement =>
  list.length === 0 ? el("span", { class: "dim" }, "none") : el("div", { class: "symbols" }, list.join(", "));

function renderDetail(): void {
  const panel = $("detail");
  const cs = state.selected === null ? undefined : state.entries.get(state.selected);
  if (cs === undefined) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("detail-title").textContent = `#${cs.lsn} ${cs.intent}`;
  const files = cs.files.map((f) => el("div", {}, el("span", { class: "op" }, f.op), f.fromPath === undefined ? f.path : `${f.fromPath} → ${f.path}`));
  const repairs = cs.repairs.map((r) => el("div", {}, `against #${r.againstLsn} (${r.kind}): ${r.summary}`));
  const checks = `typecheck ${cs.checks.typecheck} · tests ${cs.checks.tests} · adr ${cs.checks.adr}`;
  $("detail-body").replaceChildren(
    el(
      "dl",
      {},
      el("dt", {}, "by"),
      el("dd", {}, `${cs.author.agent} (${cs.author.developer})`),
      el("dt", {}, "base"),
      el("dd", {}, `#${cs.baseLsn}`),
      el("dt", {}, "at"),
      el("dd", {}, new Date(cs.createdAt).toLocaleString()),
      el("dt", {}, "files"),
      el("dd", {}, ...files),
      el("dt", {}, "writes"),
      el("dd", {}, symbols(cs.writeSet)),
      el("dt", {}, "signatures"),
      el("dd", {}, symbols(cs.sigWriteSet)),
      el("dt", {}, "reads"),
      el("dd", {}, symbols(cs.readSet)),
      cs.repairs.length > 0 ? el("dt", {}, "repairs") : null,
      cs.repairs.length > 0 ? el("dd", {}, ...repairs) : null,
      el("dt", {}, "checks"),
      el("dd", {}, checks, cs.checks.details === undefined ? null : el("pre", {}, cs.checks.details)),
    ),
  );
}

function select(lsn: number | null): void {
  state.selected = state.selected === lsn ? null : lsn;
  renderLog();
  renderDetail();
}

function renderIntents(): void {
  const open = [...state.intents.values()].sort((a, b) => a.baseLsn - b.baseLsn);
  $("intent-count").textContent = open.length === 0 ? "" : String(open.length);
  $("no-intents").hidden = open.length > 0;
  $("intents").replaceChildren(
    ...open.map((i) =>
      el(
        "li",
        {},
        el("div", {}, el("span", { class: "agent" }, i.author.agent), ` ${i.text}`),
        el("div", { class: "symbols" }, i.declaredSymbols.length === 0 ? "no symbols declared" : i.declaredSymbols.join(", ")),
        el("div", { class: "dim" }, `from #${i.baseLsn} · ${timeAgo(i.heartbeatAt)}`),
      ),
    ),
  );
}

/** `agent-b · applied #3 of #4`, one line per connected worktree, with a red mark on one behind the head. */
function renderWorktrees(): void {
  const head = state.head ?? 0;
  // Named ones first, by name; the nameless (no open intent) after them, the furthest behind first.
  const list = [...state.worktrees].sort((a, b) => {
    if ((a.agent === undefined) !== (b.agent === undefined)) return a.agent === undefined ? 1 : -1;
    return (a.agent ?? "").localeCompare(b.agent ?? "") || a.appliedLsn - b.appliedLsn;
  });
  $("worktree-count").textContent = list.length === 0 ? "" : String(list.length);
  $("no-worktrees").hidden = list.length > 0;
  $("worktrees").replaceChildren(
    ...list.map((w) => {
      const behind = Math.max(0, head - w.appliedLsn);
      return el(
        "li",
        { class: behind > 0 ? "behind" : "", title: behind > 0 ? `${plural(behind, "entry", "entries")} behind the head` : "at the head" },
        el("span", { class: `mark ${behind > 0 ? "behind" : "ok"}` }, "●"),
        w.agent === undefined ? el("span", { class: "dim" }, "worktree") : el("span", { class: "agent" }, w.agent),
        el("span", {}, `· applied #${w.appliedLsn} of #${head}`),
        behind > 0 ? el("span", { class: "lag" }, `${behind} behind`) : null,
      );
    }),
  );
}

function addEvent(kind: EventKind, text: string, lsn?: number): void {
  state.events.unshift({ at: new Date(), kind, text, ...(lsn === undefined ? {} : { lsn }) });
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
  renderEvents();
}

function renderEvents(): void {
  $("events").replaceChildren(
    ...state.events.map((e) => {
      const li = el("li", { class: e.kind }, el("span", { class: "at" }, e.at.toLocaleTimeString()), el("span", {}, e.text));
      const lsn = e.lsn;
      if (lsn !== undefined) {
        li.style.cursor = "pointer";
        li.addEventListener("click", () => select(lsn));
      }
      return li;
    }),
  );
}

// --- the live view's lifecycle -------------------------------------------------------------------

function reset(): void {
  state.head = null;
  state.entries.clear();
  state.intents.clear();
  state.worktrees = [];
  state.events = [];
  state.selected = null;
  state.live.clear();
  renderHead();
  renderLog();
  renderDetail();
  renderIntents();
  renderWorktrees();
  renderEvents();
}

/** Follows `repo` live, unless the page already does. */
function follow(repo: string): void {
  if (state.repo === repo && socket !== undefined) return;
  state.repo = repo;
  reset();
  connect();
}

// --- routes --------------------------------------------------------------------------------------

type Tab = "live" | "members" | "setup";
type Route = { view: "home" } | { view: "account" } | { view: "repo"; repo: string; tab: Tab };

function parseRoute(hash: string): Route {
  const raw = decodeURIComponent(hash.replace(/^#/, ""));
  if (raw === "" || raw === "/") return { view: "home" };
  if (raw === "/account") return { view: "account" };
  // Before routes, the hash held only the repository: #owner/name.
  const parts = (raw.startsWith("/r/") ? raw.slice(3) : raw.replace(/^\//, "")).split("/");
  const [owner, name, tab] = parts;
  if (owner && name) return { view: "repo", repo: `${owner}/${name}`, tab: tab === "members" || tab === "setup" ? tab : "live" };
  return { view: "home" };
}

const repoHref = (repo: string, tab: Tab = "live"): string => `#/r/${repo}${tab === "live" ? "" : `/${tab}`}`;

function show(route: Route): void {
  for (const id of ["view-home", "view-repo", "view-account"]) $(id).hidden = true;
  const inRepo = route.view === "repo";
  for (const id of ["repo-title", "head", "conn"]) $(id).hidden = !inRepo;
  if (route.view !== "repo") disconnect();
  if (route.view === "home") {
    $("view-home").hidden = false;
    void renderHome();
  } else if (route.view === "account") {
    $("view-account").hidden = false;
    void renderAccount();
  } else {
    $("view-repo").hidden = false;
    $("repo-title").textContent = route.repo;
    for (const tab of ["live", "members", "setup"] as const) {
      const link = $<HTMLAnchorElement>(`tab-${tab}`);
      link.href = repoHref(route.repo, tab);
      link.className = tab === route.tab ? "active" : "";
    }
    $("pane-live").hidden = route.tab !== "live";
    $("pane-members").hidden = route.tab !== "members";
    $("pane-setup").hidden = route.tab !== "setup";
    follow(route.repo);
    if (route.tab === "members") void renderMembers(route.repo);
    if (route.tab === "setup") void renderSetup(route.repo);
  }
}

// --- who is looking ------------------------------------------------------------------------------

async function loadSession(): Promise<void> {
  const version = await api<{ version: string; accounts?: boolean }>("/version");
  $("version").textContent = version === undefined ? "" : version.version.slice(0, 7);
  session.accounts = version?.accounts === true;
  session.me = await api<Me>("/me");
  const who = $("who");
  who.replaceChildren();
  if (session.me !== undefined) {
    who.append(el("a", { href: "#/account" }, session.me.login));
  } else if (token !== "") {
    const forget = el("a", { href: "#/" }, "forget token");
    forget.addEventListener("click", () => {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      void start();
    });
    who.append("server token · ", forget);
  } else if (session.accounts) {
    who.append(el("a", { href: "/auth/github" }, "Sign in with GitHub"));
  }
  $("nav-account").hidden = session.me === undefined;
  // Without sign-in the server takes its shared token; with sign-in the page never asks for it.
  $("token-form").hidden = session.accounts || signedIn();
}

// --- home: your repositories ---------------------------------------------------------------------

async function renderHome(): Promise<void> {
  $("home-out").hidden = signedIn();
  $("home-in").hidden = !signedIn();
  $("home-token-hint").hidden = session.accounts;
  if (!signedIn()) return;
  $("new-owner").textContent = session.me === undefined ? "" : `${session.me.login.toLowerCase()}/`;
  $<HTMLInputElement>("new-name").placeholder = session.me === undefined ? "owner/name" : "name";
  const repos = (await api<Repo[]>("/repos")) ?? [];
  $("no-repos").hidden = repos.length > 0;
  $("repos").replaceChildren(
    ...repos.map((r) =>
      el(
        "li",
        {},
        el("a", { href: repoHref(r.id), class: "grow" }, r.id),
        el("span", { class: "dim" }, r.headLsn === 0 ? "empty" : `head #${r.headLsn}`),
        el("a", { href: repoHref(r.id, "members") }, "members"),
        el("a", { href: repoHref(r.id, "setup") }, "set up Claude"),
      ),
    ),
  );
}

async function createRepo(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const input = $<HTMLInputElement>("new-name");
  const name = input.value.trim().toLowerCase();
  const id = session.me === undefined ? name : `${session.me.login.toLowerCase()}/${name}`;
  const res = await call<Repo>("POST", "/repos", { id });
  if (res.status === 201 || res.status === 200) {
    input.value = "";
    say("new-repo-msg", res.status === 201 ? `${id} created` : `${id} exists`, true);
    location.hash = repoHref(id, "setup");
    return;
  }
  say("new-repo-msg", messageOf(res.body, `the server answered ${res.status}`), false);
}

// --- members and invites -------------------------------------------------------------------------

interface MemberRow {
  login: string;
  role: "owner" | "writer" | "reader";
  resolver?: boolean;
  pending?: boolean;
}

function say(id: string, text: string, ok: boolean): void {
  const msg = $(id);
  msg.className = `msg ${ok ? "ok" : "error"}`;
  msg.textContent = text;
}

async function renderMembers(repo: string): Promise<void> {
  const res = await call<MemberRow[]>("GET", `/repos/${repo}/members`);
  if (res.status !== 200 || res.body === undefined) {
    $("members").replaceChildren();
    say("members-msg", messageOf(res.body, res.status === 401 ? "sign in to see this repository" : `the server answered ${res.status}`), false);
    $("invite-box").hidden = true;
    return;
  }
  const rows = res.body;
  const myLogin = session.me?.login.toLowerCase();
  const mine = rows.find((m) => m.pending !== true && m.login.toLowerCase() === myLogin);
  // A signed-in user manages as an owner; the administrator's token manages everything.
  const canManage = session.me === undefined ? token !== "" : mine?.role === "owner";
  $("invite-box").hidden = !canManage;
  const put = async (login: string, body: { role: string; resolver?: boolean }): Promise<void> => {
    const r = await call("PUT", `/repos/${repo}/members/${encodeURIComponent(login)}`, body);
    if (r.status >= 300) say("members-msg", messageOf(r.body, `the server answered ${r.status}`), false);
    else say("members-msg", `${login} updated`, true);
    await renderMembers(repo);
  };
  $("members").replaceChildren(
    ...rows.map((m) => {
      const self = m.login.toLowerCase() === myLogin;
      const role = el("select", {}, ...(["owner", "writer", "reader"] as const).map((r) => el("option", r === m.role ? { value: r, selected: "" } : { value: r }, r)));
      role.disabled = !canManage || m.pending === true;
      role.addEventListener("change", () => void put(m.login, { role: role.value }));
      const resolver = el("input", { type: "checkbox", title: "resolver: decides on conflicts" });
      resolver.checked = m.resolver === true;
      resolver.disabled = !canManage || m.pending === true;
      resolver.addEventListener("change", () => void put(m.login, { role: m.role, resolver: resolver.checked }));
      const remove = el("button", { type: "button" }, self ? "Leave" : m.pending === true ? "Withdraw" : "Remove");
      remove.hidden = !(canManage || self);
      remove.addEventListener("click", () => void removeMember(repo, m.login, self));
      return el(
        "li",
        {},
        el("span", { class: "grow" }, m.login, self ? el("span", { class: "dim" }, " (you)") : null),
        m.pending === true ? el("span", { class: "badge warn" }, "invited") : null,
        role,
        el("label", { class: "inline" }, resolver, " resolver"),
        remove,
      );
    }),
  );
}

async function removeMember(repo: string, login: string, self: boolean): Promise<void> {
  const r = await call("DELETE", `/repos/${repo}/members/${encodeURIComponent(login)}`);
  if (r.status >= 300) {
    say("members-msg", messageOf(r.body, `the server answered ${r.status}`), false);
    return;
  }
  if (self) {
    location.hash = "#/";
    return;
  }
  say("members-msg", `${login} removed`, true);
  await renderMembers(repo);
}

async function invite(ev: SubmitEvent, repo: string): Promise<void> {
  ev.preventDefault();
  const login = $<HTMLInputElement>("invite-login").value.trim();
  const role = $<HTMLSelectElement>("invite-role").value;
  const res = await call<MemberRow>("PUT", `/repos/${repo}/members/${encodeURIComponent(login)}`, { role });
  if (res.status === 202) say("members-msg", `${login} invited as ${role}: they join when they first sign in at ${location.origin}`, true);
  else if (res.status < 300) say("members-msg", `${login} added as ${role}`, true);
  else say("members-msg", messageOf(res.body, `the server answered ${res.status}`), false);
  $<HTMLInputElement>("invite-login").value = "";
  await renderMembers(repo);
}

// --- the prompt that sets up a developer's Claude ------------------------------------------------

/** What the developer pastes into Claude Code: install, connect a checkout, wire the tools, start the daemon. */
function promptText(repo: string, secret: string, empty: boolean): string {
  const server = location.origin;
  const where = empty
    ? "This repository is empty, so it starts from code I already have. Ask me where my project is (a git checkout on the branch main), go to that folder, and run:"
    : "Ask me where the checkout should go (on Windows keep the path short, like C:\\code), go to that folder, and run:";
  return [
    `Set up Pitstop for the repository ${repo} on this computer.`,
    "",
    `Pitstop is version control built for coding agents: the server at ${server} keeps the history, and a small background daemon keeps a local checkout in sync. From now on we commit through Pitstop's tools, not git.`,
    "",
    "1. Make sure Node.js 22 or newer, git and jj (Jujutsu) are installed, and install what is missing:",
    "   - Windows: winget install OpenJS.NodeJS.LTS, then winget install Git.Git, then winget install jj-vcs.jj",
    "   - macOS: brew install node git jj",
    "   - Linux: Node.js and git from the package manager; jj from https://github.com/jj-vcs/jj/releases",
    `2. Install the Pitstop client: npm install -g ${server}/pitstop-cli.tgz`,
    `3. ${where}`,
    `   pitstop setup ${server} ${repo} --token ${secret}`,
    "4. Read the CLAUDE.local.md that setup writes in the checkout and follow it from now on. Then tell me to open Claude Code in that checkout, so the pitstop tools load.",
    "",
    "The token is mine: keep it out of files you commit and out of anything you share.",
  ].join("\n");
}

async function renderSetup(repo: string): Promise<void> {
  $("setup-repo").textContent = repo;
  $("prompt-box").hidden = true;
  say("setup-msg", "", true);
  const info = await call<Repo>("GET", `/repos/${repo}`);
  const button = $<HTMLButtonElement>("make-prompt");
  if (info.status !== 200 || info.body === undefined) {
    $("setup-state").textContent = "";
    button.hidden = true;
    say("setup-msg", messageOf(info.body, info.status === 401 ? "sign in to set up this repository" : `the server answered ${info.status}`), false);
    return;
  }
  const empty = info.body.headLsn === 0;
  $("setup-state").textContent = empty
    ? "This repository is empty: the first setup imports the code from your existing checkout."
    : `This repository has ${plural(info.body.headLsn, "entry", "entries")}: setup builds a fresh checkout from them.`;
  button.hidden = false;
  button.onclick = () => void makePrompt(repo, empty);
}

async function makePrompt(repo: string, empty: boolean): Promise<void> {
  if (session.me === undefined) {
    // The administrator's shared token must never travel in a prompt.
    showPrompt(promptText(repo, "<your personal token: sign in, then Account>", empty));
    say("setup-msg", "Sign in with GitHub to get a personal token for this prompt.", false);
    return;
  }
  const made = await call<{ secret: string }>("POST", "/tokens", { name: `claude ${repo}`.slice(0, 80) });
  if (made.status !== 201 || made.body === undefined) {
    say("setup-msg", messageOf(made.body, `the server answered ${made.status}`), false);
    return;
  }
  showPrompt(promptText(repo, made.body.secret, empty));
  say("setup-msg", "A new token was made for this prompt; revoke it under Account when that computer is gone.", true);
}

function showPrompt(text: string): void {
  $("prompt").textContent = text;
  $("prompt-box").hidden = false;
}

// --- account: personal tokens --------------------------------------------------------------------

interface TokenRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

async function renderAccount(): Promise<void> {
  $("new-token-box").hidden = true;
  if (session.me === undefined) {
    $("account-who").textContent = "Not signed in.";
    $("tokens").replaceChildren();
    return;
  }
  $("account-who").textContent = `Signed in as ${session.me.login}${session.me.name ? ` (${session.me.name})` : ""}.`;
  const tokens = (await api<TokenRow[]>("/tokens")) ?? [];
  $("tokens").replaceChildren(
    ...tokens.map((t) => {
      const revoke = el("button", { type: "button" }, "Revoke");
      revoke.hidden = t.revokedAt !== undefined;
      revoke.addEventListener("click", () => void revokeToken(t.id));
      const status = t.revokedAt !== undefined ? "revoked" : t.lastUsedAt !== undefined ? `used ${timeAgo(t.lastUsedAt)}` : `made ${timeAgo(t.createdAt)}`;
      return el("li", {}, el("span", { class: "grow" }, t.name), el("span", { class: "dim" }, status), revoke);
    }),
  );
}

async function revokeToken(id: string): Promise<void> {
  await call("DELETE", `/tokens/${id}`);
  await renderAccount();
}

async function createToken(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const input = $<HTMLInputElement>("new-token-name");
  const made = await call<{ secret: string }>("POST", "/tokens", { name: input.value.trim() });
  if (made.status !== 201 || made.body === undefined) return;
  input.value = "";
  await renderAccount();
  $("new-token-secret").textContent = made.body.secret;
  $("new-token-box").hidden = false;
}

// --- start ---------------------------------------------------------------------------------------

async function start(): Promise<void> {
  await loadSession();
  show(parseRoute(location.hash));
}

async function signOut(): Promise<void> {
  await call("POST", "/auth/logout");
  location.hash = "#/";
  await start();
}

function setup(): void {
  $<HTMLFormElement>("token-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $<HTMLInputElement>("token");
    token = input.value.trim();
    input.value = "";
    localStorage.setItem(TOKEN_KEY, token);
    void start();
  });
  $<HTMLFormElement>("new-repo").addEventListener("submit", (ev) => void createRepo(ev));
  $<HTMLFormElement>("invite").addEventListener("submit", (ev) => {
    const route = parseRoute(location.hash);
    if (route.view === "repo") void invite(ev, route.repo);
  });
  $<HTMLFormElement>("new-token").addEventListener("submit", (ev) => void createToken(ev));
  $("copy-prompt").addEventListener("click", () => void navigator.clipboard.writeText($("prompt").textContent ?? ""));
  $("sign-out").addEventListener("click", () => void signOut());
  $("close").addEventListener("click", () => select(null));
  window.addEventListener("hashchange", () => show(parseRoute(location.hash)));
  window.setInterval(renderIntents, 5_000);
  window.setInterval(() => void pollWorktrees(), WORKTREES_MS);
  void start();
}

setup();
