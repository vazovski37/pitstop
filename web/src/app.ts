/**
 * The website, one page, no framework (web/CLAUDE.md): sign in, your repositories, a
 * repository's live view, its members and invites, the prompt that sets up a developer's Claude,
 * and personal tokens. Routes live in the hash (#/, #/r/<owner>/<name>[/members|/setup],
 * #/account). The live view subscribes to the server's stream for one repository from LSN 0, so
 * the whole log replays and then stays live. Only types come from @pitstop/protocol: nothing from
 * node_modules reaches the browser.
 */
import type { Changeset, ClientMessage, Intent, PresenceDoc, PresenceEntry, Repo, ServerMessage } from "@pitstop/protocol";

/** `DEFAULT_REPO` in the protocol; a value import would pull zod into the page. */
const DEFAULT_REPO = "local/default";
const TOKEN_KEY = "pitstop.token";
const RECONNECT_MS = 2_000;
/** How often the worktrees are re-read while the stream is up; every entry re-reads them too. */
const WORKTREES_MS = 3_000;
const MAX_EVENTS = 200;
/** Presence entries older than this are hidden (daemons refresh theirs with every heartbeat); the server's PRESENCE_TTL_MS. */
const PRESENCE_TTL_MS = 2 * 60_000;
/** How often "Who's here" is redrawn without news, so ages move on and old entries fade out. */
const PRESENCE_REDRAW_MS = 2_000;

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

type EventKind = "entry" | "repair" | "skew" | "intent" | "warning" | "presence" | "info";
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
  /** The repository's presence document, merged here like on every daemon and the server. */
  presence: {} as PresenceDoc,
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
  ws.onclose = (ev) => {
    if (socket !== ws) return; // replaced on purpose
    setConnected(false);
    if (ev.code === 1008) {
      // Refused (no access, or access taken away): say why instead of retrying forever.
      $("conn").textContent = "no access";
      $("conn").title = ev.reason;
      socket = undefined;
      return;
    }
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
      if (message.repo === state.repo) {
        addEvent("warning", `for ${message.agent}: ${message.message}`);
        if (message.kind === "dependency_changed") void countConflicts(state.repo);
      }
      break;
    case "presence":
      if (message.repo === state.repo) onPresence(message.entries);
      break;
  }
}

// --- presence: who is here (design doc 9.5) ------------------------------------------------------

/**
 * The presence CRDT's merge, `applyPresence` from packages/protocol/src/presence.ts, copied: the
 * page cannot import runtime code from the protocol package (no bundler, and a value import would
 * pull zod into the browser), so these few lines live here too and must stay the same. Per
 * replica, the entry with the greater stamp wins; stamps are `<wall>.<counter>.<replica>` with
 * fixed-width numbers, so string order is clock order. Any order of updates, duplicates
 * included, ends in the same document.
 */
function applyPresence(doc: PresenceDoc, entry: PresenceEntry): PresenceDoc {
  const current = doc[entry.replica];
  if (current !== undefined && !(entry.stamp > current.stamp)) return doc;
  return { ...doc, [entry.replica]: entry };
}

/** The wall-clock milliseconds a stamp carries. */
const wallOf = (entry: PresenceEntry): number => Number(entry.stamp.split(".")[0]);

/**
 * "Now" for ages: this browser's clock, or the newest stamp seen when that is ahead (a clock
 * behind the daemons' would otherwise show every entry as written in the future).
 */
const presenceNow = (): number => Math.max(Date.now(), ...Object.values(state.presence).map(wallOf));

/** The entries to show: not departed, written within the TTL; by agent, then replica. */
function livePresence(): PresenceEntry[] {
  const now = presenceNow();
  return Object.values(state.presence)
    .filter((e) => e.state !== "gone" && now - wallOf(e) <= PRESENCE_TTL_MS)
    .sort((a, b) => a.author.agent.localeCompare(b.author.agent) || a.replica.localeCompare(b.replica));
}

function onPresence(entries: PresenceEntry[]): void {
  for (const entry of entries) {
    if (entry.repo !== state.repo) continue;
    const before = state.presence[entry.replica];
    state.presence = applyPresence(state.presence, entry);
    if (state.presence[entry.replica] !== entry) continue; // stale or a duplicate: nothing new
    const who = `${entry.author.agent} (${entry.author.developer})`;
    const wasHere = before !== undefined && before.state !== "gone";
    if (entry.state === "gone" && wasHere) addEvent("presence", `${who} left`);
    else if (entry.state !== "gone" && !wasHere && Date.now() - wallOf(entry) <= PRESENCE_TTL_MS) {
      addEvent("presence", `${who} is here${entry.intent === undefined ? "" : `, working on "${entry.intent}"`}`);
    }
  }
  renderPresence();
}

/**
 * One colour per agent name, the same on every screen: FNV-1a, then the golden angle, so names
 * that differ in one letter (agent-a, agent-b) still land far apart on the colour wheel.
 */
function agentColour(agent: string): string {
  let hash = 2_166_136_261;
  for (const ch of agent) hash = Math.imul(hash ^ ch.charCodeAt(0), 16_777_619) >>> 0;
  return `hsl(${Math.round((hash * 137.508) % 360)} 75% 68%)`;
}

const ageText = (ms: number): string => (ms < 5_000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);

/**
 * "Who's here": one line per live worktree, the agent in its colour, its developer, working or
 * idle, its intent, the files it has unfinished edits in (a file two worktrees are both in is
 * highlighted), and how far it has applied the log. Older entries fade as they near the TTL.
 */
function renderPresence(): void {
  const live = livePresence();
  const now = presenceNow();
  const head = state.head ?? 0;
  const inFile = new Map<string, string[]>();
  for (const e of live) for (const f of e.files) inFile.set(f, [...(inFile.get(f) ?? []), e.author.agent]);
  $("presence-count").textContent = live.length === 0 ? "" : String(live.length);
  $("no-presence").hidden = live.length > 0;
  $("presence").replaceChildren(
    ...live.map((e) => {
      const age = Math.max(0, now - wallOf(e));
      const behind = Math.max(0, head - e.appliedLsn);
      const colour = agentColour(e.author.agent);
      const chips = e.files.map((f) => {
        const others = (inFile.get(f) ?? []).filter((a) => a !== e.author.agent);
        const shared = (inFile.get(f)?.length ?? 0) > 1;
        return el("span", { class: shared ? "chip hot" : "chip", title: shared ? `also here: ${others.join(", ") || "another worktree"}` : f }, f);
      });
      return el(
        "li",
        { class: e.state, style: `opacity: ${(1 - 0.6 * Math.min(1, age / PRESENCE_TTL_MS)).toFixed(2)}`, title: `${e.replica} · ${ageText(age)}` },
        el(
          "div",
          { class: "who" },
          el("span", { class: `dot ${e.state}`, style: `background: ${colour}` }),
          el("span", { class: "agent", style: `color: ${colour}` }, e.author.agent),
          el("span", { class: "dim" }, e.author.developer),
          el("span", { class: `state ${e.state}` }, e.state),
          el("span", { class: `applied ${behind > 0 ? "behind" : ""}`, title: behind > 0 ? `${plural(behind, "entry", "entries")} behind the head` : "at the head" }, `applied #${e.appliedLsn} of #${head}`),
        ),
        e.intent === undefined ? null : el("div", { class: "task" }, e.intent),
        chips.length === 0 ? null : el("div", { class: "chips" }, ...chips),
        e.symbols.length === 0 ? null : el("div", { class: "symbols" }, e.symbols.join(", ")),
      );
    }),
  );
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
  renderPresence();
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
  state.presence = {};
  state.events = [];
  state.selected = null;
  state.live.clear();
  renderHead();
  renderLog();
  renderDetail();
  renderPresence();
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

type Tab = "live" | "conflicts" | "members" | "setup";
type Route = { view: "home" } | { view: "account" } | { view: "repo"; repo: string; tab: Tab };

function parseRoute(hash: string): Route {
  const raw = decodeURIComponent(hash.replace(/^#/, ""));
  if (raw === "" || raw === "/") return { view: "home" };
  if (raw === "/account") return { view: "account" };
  // Before routes, the hash held only the repository: #owner/name.
  const parts = (raw.startsWith("/r/") ? raw.slice(3) : raw.replace(/^\//, "")).split("/");
  const [owner, name, tab] = parts;
  if (owner && name) return { view: "repo", repo: `${owner}/${name}`, tab: tab === "members" || tab === "setup" || tab === "conflicts" ? tab : "live" };
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
    for (const tab of ["live", "conflicts", "members", "setup"] as const) {
      const link = $<HTMLAnchorElement>(`tab-${tab}`);
      link.href = repoHref(route.repo, tab);
      link.className = tab === route.tab ? "active" : "";
    }
    $("pane-live").hidden = route.tab !== "live";
    $("pane-conflicts").hidden = route.tab !== "conflicts";
    $("pane-members").hidden = route.tab !== "members";
    $("pane-setup").hidden = route.tab !== "setup";
    follow(route.repo);
    if (route.tab === "conflicts") void renderConflicts(route.repo);
    else void countConflicts(route.repo);
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

// --- conflicts: commits waiting for the repository's resolver ------------------------------------

interface ParkedRow {
  id: string;
  status: "open" | "accepted" | "sent_back";
  intent: string;
  author: { developer: string; agent: string };
  files: { path: string; op: string; fromPath?: string; content?: string }[];
  skew: string;
  conflictsWith: number[];
  headLsn: number;
  createdAt: string;
  note?: string;
  decidedBy?: string;
  landedLsn?: number;
  decidedAt?: string;
}

/** Whether the person looking decides on this repository's conflicts: a resolver, else an owner, or the administrator. */
async function decides(repo: string): Promise<boolean> {
  if (session.me === undefined) return token !== "";
  const members = await api<MemberRow[]>(`/repos/${repo}/members`);
  if (members === undefined) return false;
  const active = members.filter((m) => m.pending !== true);
  const resolvers = active.filter((m) => m.resolver === true);
  const deciders = resolvers.length > 0 ? resolvers : active.filter((m) => m.role === "owner");
  const me = session.me.login.toLowerCase();
  return deciders.some((m) => m.login.toLowerCase() === me);
}

async function countConflicts(repo: string): Promise<void> {
  const list = (await api<ParkedRow[]>(`/repos/${repo}/parked`)) ?? [];
  const open = list.filter((p) => p.status === "open").length;
  const badge = $("conflict-count");
  badge.textContent = String(open);
  badge.hidden = open === 0;
}

async function renderConflicts(repo: string): Promise<void> {
  const res = await call<ParkedRow[]>("GET", `/repos/${repo}/parked`);
  if (res.status !== 200 || res.body === undefined) {
    $("conflicts").replaceChildren();
    say("conflicts-msg", messageOf(res.body, `the server answered ${res.status}`), false);
    return;
  }
  const list = res.body;
  const canDecide = await decides(repo);
  $("no-conflicts").hidden = list.length > 0;
  const open = list.filter((p) => p.status === "open").length;
  $("conflict-count").textContent = String(open);
  $("conflict-count").hidden = open === 0;
  $("conflicts").replaceChildren(...list.map((p) => conflictCard(repo, p, canDecide)));
}

function conflictCard(repo: string, p: ParkedRow, canDecide: boolean): HTMLElement {
  const status =
    p.status === "open"
      ? el("span", { class: "badge warn" }, "waiting")
      : p.status === "accepted"
        ? el("span", { class: "badge repair" }, `let through by ${p.decidedBy ?? "?"}${p.landedLsn === undefined ? "" : ` as #${p.landedLsn}`}`)
        : el("span", { class: "badge" }, `sent back by ${p.decidedBy ?? "?"}`);
  const files = p.files.map((f) =>
    el(
      "details",
      {},
      el("summary", {}, `${f.op} ${f.fromPath === undefined ? f.path : `${f.fromPath} → ${f.path}`}`),
      f.content === undefined ? el("p", { class: "dim" }, "no content") : el("pre", {}, f.content),
    ),
  );
  const card = el(
    "li",
    { class: p.status === "open" ? "open" : "" },
    el("div", { class: "head" }, el("strong", { class: "grow" }, p.intent), status),
    el("div", { class: "dim" }, `${p.author.agent} (${p.author.developer}) · ${timeAgo(p.createdAt)} · ${p.id} · head was #${p.headLsn}`),
    el("div", { class: "skew" }, `Write skew: ${p.skew}`),
    ...files,
    p.note === undefined ? null : el("p", {}, el("span", { class: "dim" }, "note: "), p.note),
  );
  if (p.status === "open" && canDecide) {
    const note = el("textarea", { placeholder: "A note for the author when you send it back: what to change" });
    const accept = el("button", { type: "button" }, "Let it through");
    const back = el("button", { type: "button" }, "Send back");
    accept.addEventListener("click", () => void decide(repo, p.id, "accept"));
    back.addEventListener("click", () => void decide(repo, p.id, "send-back", note.value));
    card.append(note, el("div", { class: "stack" }, accept, back));
  } else if (p.status === "open") {
    card.append(el("p", { class: "dim" }, "Waiting for this repository's resolver."));
  }
  return card;
}

async function decide(repo: string, id: string, action: "accept" | "send-back", note?: string): Promise<void> {
  const res = await call<ParkedRow>("POST", `/repos/${repo}/parked/${id}/${action}`, action === "send-back" ? { note: note ?? "" } : undefined);
  if (res.status >= 300) say("conflicts-msg", messageOf(res.body, `the server answered ${res.status}`), false);
  else say("conflicts-msg", action === "accept" ? `${id} landed${res.body?.landedLsn === undefined ? "" : ` as #${res.body.landedLsn}`}` : `${id} sent back to its author`, true);
  await renderConflicts(repo);
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
  window.setInterval(renderPresence, PRESENCE_REDRAW_MS);
  window.setInterval(() => void pollWorktrees(), WORKTREES_MS);
  void start();
}

setup();
