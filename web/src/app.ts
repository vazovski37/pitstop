/**
 * The live view: one page, no framework (web/CLAUDE.md). It subscribes to the server's stream
 * for one repository from LSN 0, so the whole log replays and then stays live; the rest of the
 * API is read once at start. Only types come from @pitstop/protocol: nothing from node_modules
 * reaches the browser.
 */
import type { Changeset, ClientMessage, Intent, Repo, ServerMessage } from "@pitstop/protocol";

/** `DEFAULT_REPO` in the protocol; a value import would pull zod into the page. */
const DEFAULT_REPO = "local/default";
const TOKEN_KEY = "pitstop.token";
const RECONNECT_MS = 2_000;
const MAX_EVENTS = 200;

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

/** A GET as JSON, or nothing. `unauthorized` remembers a 401 for the caller to act on. */
let unauthorized = false;
async function api<T>(path: string): Promise<T | undefined> {
  const res = await fetch(path, { headers: authHeaders() });
  unauthorized = res.status === 401;
  if (!res.ok) return undefined;
  return (await res.json()) as T;
}

async function whoAmI(): Promise<void> {
  const who = $("who");
  who.replaceChildren();
  // Anonymous is fine on an open server: /me answers 401 there too, so this alone shows no field.
  const me = await api<{ login: string }>("/me");
  if (me !== undefined) {
    who.append(`signed in as ${me.login}`);
    return;
  }
  who.append(el("a", { href: "/auth/github" }, "sign in with GitHub"));
  if (token !== "") who.append(" · token set");
}

async function loadRepos(): Promise<void> {
  const repos = (await api<Repo[]>("/repos")) ?? [];
  // The data is guarded: the server wants a token (or the sign-in above).
  $("token-form").hidden = !unauthorized;
  const wanted = decodeURIComponent(location.hash.slice(1)) || state.repo;
  const ids = repos.map((r) => r.id);
  // The one in the URL, or the default, even when the list could not be read.
  if (!ids.includes(wanted)) ids.unshift(wanted);
  const select = $<HTMLSelectElement>("repo");
  select.replaceChildren(...ids.map((id) => el("option", { value: id }, id)));
  select.value = wanted;
  state.repo = wanted;
}

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

function connect(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const old = socket;
  socket = undefined;
  old?.close();

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
    reconnectTimer = window.setTimeout(connect, RECONNECT_MS);
  };
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

// --- start ---------------------------------------------------------------------------------------

function reset(): void {
  state.head = null;
  state.entries.clear();
  state.intents.clear();
  state.events = [];
  state.selected = null;
  state.live.clear();
  renderHead();
  renderLog();
  renderDetail();
  renderIntents();
  renderEvents();
}

async function load(): Promise<void> {
  const version = await api<{ version: string }>("/version");
  $("version").textContent = version === undefined ? "" : version.version.slice(0, 7);
  await whoAmI();
  await loadRepos();
  reset();
  connect();
}

function setup(): void {
  $<HTMLSelectElement>("repo").addEventListener("change", (ev) => {
    state.repo = (ev.target as HTMLSelectElement).value;
    location.hash = encodeURIComponent(state.repo);
    reset();
    connect();
  });
  $<HTMLFormElement>("token-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const input = $<HTMLInputElement>("token");
    token = input.value.trim();
    input.value = "";
    localStorage.setItem(TOKEN_KEY, token);
    void load();
  });
  $("close").addEventListener("click", () => select(null));
  window.setInterval(renderIntents, 5_000);
  void load();
}

setup();
