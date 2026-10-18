/**
 * The website, one page, no framework (web/CLAUDE.md): sign in, your repositories, a
 * repository's live view, its members and invites, the prompt that sets up a developer's Claude,
 * and personal tokens. Routes live in the hash (#/, #/r/<owner>/<name>[/members|/setup],
 * #/account). The live view subscribes to the server's stream for one repository from LSN 0, so
 * the whole log replays and then stays live. Only types come from @pitstop/protocol: nothing from
 * node_modules reaches the browser.
 */
import type { Adr, AdrRule, Changeset, ClientMessage, Intent, Lease, PresenceDoc, PresenceEntry, Repo, ServerMessage } from "@pitstop/protocol";

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
/** At most this many entries in the page's copy of the document (the server keeps as many); the oldest tombstones go first. */
const PRESENCE_MAX_ENTRIES = 500;

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

type EventKind = "entry" | "repair" | "skew" | "intent" | "warning" | "presence" | "brain" | "lease" | "info";
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
    case "brain":
      if (message.repo === state.repo) {
        addEvent("brain", `ADR-${message.adr.number} ${message.adr.status}: ${message.adr.title} (brain v${message.version})`);
        setBrainVersion(message.version);
        if (showing(state.repo, "brain")) void renderBrain(state.repo);
      }
      break;
    case "lease":
      if (message.lease.repo === state.repo) {
        const l = message.lease;
        addEvent("lease", `${l.holder.agent} ${l.status === "held" ? "leased" : l.status === "released" ? "released" : "lost (expired)"} ${l.symbol}${l.reason ? `: ${l.reason}` : ""}`);
        if (showing(state.repo, "brain")) void renderBrain(state.repo);
      }
      break;
  }
}

// --- presence: who is here (design doc 9.5) ------------------------------------------------------

/**
 * The presence CRDT's merge, `applyPresence` from packages/protocol/src/presence.ts, copied: the
 * page cannot import runtime code from the protocol package (no bundler, and a value import would
 * pull zod into the browser), so these few lines live here too and must stay the same. Per
 * replica, the entry with the greater stamp wins; stamps are `<wall>.<counter>.<replica>` with
 * fixed-width numbers, so string order is clock order; equal stamps (two writers sharing a
 * replica id) fall back to the canonical form, as in the protocol. Any order of updates,
 * duplicates included, ends in the same document.
 */
function canonicalPresence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPresence).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalPresence(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function applyPresence(doc: PresenceDoc, entry: PresenceEntry): PresenceDoc {
  const current = doc[entry.replica];
  if (current !== undefined) {
    const wins = entry.stamp !== current.stamp ? entry.stamp > current.stamp : canonicalPresence(entry) > canonicalPresence(current);
    if (!wins) return doc;
  }
  return { ...doc, [entry.replica]: entry };
}

/** The wall-clock milliseconds a stamp carries. */
const wallOf = (entry: PresenceEntry): number => Number(entry.stamp.split(".")[0]);

/**
 * "Now" for ages: this browser's clock, or the newest stamp seen when that is ahead (a clock
 * behind the daemons' would otherwise show every entry as written in the future).
 */
const presenceNow = (): number => {
  let top = Date.now();
  for (const e of Object.values(state.presence)) top = Math.max(top, wallOf(e)); // a loop: spreading a large document overflows the stack
  return top;
};

/**
 * Keeps the page's copy under PRESENCE_MAX_ENTRIES, as the server keeps its own: tombstones
 * first, then the oldest. Only a flood of replicas gets here; views hide such entries soon anyway.
 */
function prunePresence(): void {
  const all = Object.values(state.presence);
  if (all.length <= PRESENCE_MAX_ENTRIES) return;
  const order = [...all].sort((a, b) => Number(b.state === "gone") - Number(a.state === "gone") || (a.stamp < b.stamp ? -1 : 1));
  const drop = new Set(order.slice(0, all.length - PRESENCE_MAX_ENTRIES).map((e) => e.replica));
  state.presence = Object.fromEntries(all.filter((e) => !drop.has(e.replica)).map((e) => [e.replica, e]));
}

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
  prunePresence();
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

/** How faded a row is and what its tooltip says, from the entry's age. */
function presenceAge(e: PresenceEntry, now: number): { opacity: string; title: string } {
  const age = Math.max(0, now - wallOf(e));
  return { opacity: (1 - 0.6 * Math.min(1, age / PRESENCE_TTL_MS)).toFixed(2), title: `${e.replica} · ${ageText(age)}` };
}

/** What the rows of "Who's here" last showed, ages aside: while it stays the same, a redraw only moves the ages on. */
let presenceShown = "";

/**
 * "Who's here": one line per live worktree, the agent in its colour, its developer, working or
 * idle, its intent, the files it has unfinished edits in (a file two worktrees are both in is
 * highlighted), and how far it has applied the log. Older entries fade as they near the TTL.
 * The rows are rebuilt only when what they say changed (not for a keepalive or the 2 s tick), so
 * tooltips stay open, the pulse runs on and the fade is a transition.
 */
function renderPresence(): void {
  const live = livePresence();
  const now = presenceNow();
  const head = state.head ?? 0;
  const shown = JSON.stringify([head, live.map((e) => [e.replica, e.author, e.state, e.intent, e.files, e.symbols, e.appliedLsn])]);
  if (shown === presenceShown) {
    const byReplica = new Map(live.map((e) => [e.replica, e]));
    for (const row of $("presence").querySelectorAll<HTMLLIElement>("li[data-replica]")) {
      const e = byReplica.get(row.dataset.replica ?? "");
      if (e === undefined) continue;
      const { opacity, title } = presenceAge(e, now);
      row.style.opacity = opacity;
      row.title = title;
    }
    return;
  }
  presenceShown = shown;
  const inFile = new Map<string, string[]>();
  for (const e of live) for (const f of e.files) inFile.set(f, [...(inFile.get(f) ?? []), e.author.agent]);
  $("presence-count").textContent = live.length === 0 ? "" : String(live.length);
  $("no-presence").hidden = live.length > 0;
  $("presence").replaceChildren(
    ...live.map((e) => {
      const { opacity, title } = presenceAge(e, now);
      const behind = Math.max(0, head - e.appliedLsn);
      const colour = agentColour(e.author.agent);
      const chips = e.files.map((f) => {
        const others = (inFile.get(f) ?? []).filter((a) => a !== e.author.agent);
        const shared = (inFile.get(f)?.length ?? 0) > 1;
        return el("span", { class: shared ? "chip hot" : "chip", title: shared ? `also here: ${others.join(", ") || "another worktree"}` : f }, f);
      });
      return el(
        "li",
        { class: e.state, "data-replica": e.replica, style: `opacity: ${opacity}`, title },
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
  renderOnboarding();
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

// --- design-system helpers: colour by name, avatars, icons, toasts, dialogs, loading --------------

/**
 * The hues a name can get: clear of the semantic ones (ok ≈150, warn ≈40, bad ≈0, repair ≈265,
 * accent ≈233), so an agent never reads as a status. The landing diagram in index.html uses the
 * same hues for agent-a, agent-b and agent-c (185, 310, 95).
 */
const NAME_HUES = [205, 310, 70, 330, 220, 290, 185, 95];

/** A stable hue for a name, so an agent or a person keeps one colour everywhere on the page. */
function hueOf(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return NAME_HUES[(h >>> 0) % NAME_HUES.length] ?? 205;
}

/** Two letters for a login: the initials of its parts (`giorgi-papidze` → GP), else its first two letters. */
function initials(login: string): string {
  const parts = login.split(/[-_.\s]+/).filter((p) => p !== "");
  const letters = parts.length > 1 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : login.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return (letters === "" ? "?" : letters).toUpperCase();
}

const avatar = (login: string, size = ""): HTMLElement =>
  el("span", { class: `avatar ${size}`.trim(), style: `--h: ${hueOf(login.toLowerCase())}`, "aria-hidden": "true" }, initials(login));

const agentChip = (agent: string): HTMLElement => el("span", { class: "agent", style: `--h: ${hueOf(agent)}`, "data-hue": String(hueOf(agent)), title: `agent ${agent}` }, agent);

/** Agents the live view renders get their colour here, so its render functions stay as they are. */
function paintAgents(root: ParentNode): void {
  for (const node of root.querySelectorAll<HTMLElement>(".agent")) {
    if (node.dataset.hue !== undefined) continue;
    const hue = hueOf(node.textContent ?? "");
    node.dataset.hue = String(hue);
    node.style.setProperty("--h", String(hue));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
/** A line icon on a 24-unit grid; strokes come from the stylesheet. */
function icon(paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
const ICON_WARN = ["M12 3.5 2.5 20h19L12 3.5Z", "M12 10v4.2", "M12 17.2v.1"];
const ICON_KEY = ["M5 11h14v10H5z", "M8 11V7.5a4 4 0 0 1 8 0V11"];

/** A short note in the corner, read out by screen readers (#toasts is an aria-live region). */
function toast(text: string, kind: "ok" | "error" | "info" = "info"): void {
  const box = $("toasts");
  const node = el(
    "div",
    { class: `toast ${kind}` },
    el("span", { class: "toast-icon", "aria-hidden": "true" }, kind === "ok" ? "✓" : kind === "error" ? "!" : "i"),
    el("span", { class: "toast-text" }, text),
  );
  box.append(node);
  while (box.children.length > 4) box.firstElementChild?.remove();
  window.setTimeout(
    () => {
      node.classList.add("leaving");
      window.setTimeout(() => node.remove(), 220);
    },
    kind === "error" ? 7_000 : 4_000,
  );
}

/** Asks before something that cannot be undone from here; resolves true on the confirm button. */
function confirmAction(title: string, body: string, ok: string): Promise<boolean> {
  const dialog = $<HTMLDialogElement>("confirm-dialog");
  if (typeof dialog.showModal !== "function") return Promise.resolve(window.confirm(`${title}\n\n${body}`));
  $("confirm-title").textContent = title;
  $("confirm-body").textContent = body;
  $("confirm-ok").textContent = ok;
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.showModal();
  });
}

/** Runs `work` with the button showing it is busy, so a double click cannot send twice. */
async function busy<T>(button: HTMLButtonElement | null, work: () => Promise<T>): Promise<T> {
  if (button !== null) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  try {
    return await work();
  } finally {
    if (button !== null) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }
}

/** Copies `text` and says so; falls back to a hidden textarea where the clipboard API is missing (plain http). */
async function copy(text: string, what: string, then = ""): Promise<void> {
  let done = false;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch {
    const area = el("textarea", { readonly: "", style: "position: fixed; top: 0; left: 0; opacity: 0" });
    area.value = text;
    document.body.append(area);
    area.select();
    try {
      done = document.execCommand("copy");
    } catch {
      done = false;
    }
    area.remove();
  }
  if (done) toast(`${what} copied.${then === "" ? "" : ` ${then}`}`, "ok");
  else toast(`Could not reach the clipboard: select the ${what.toLowerCase()} and copy it by hand.`, "error");
}

const loadingRow = (text: string): HTMLElement => el("li", { class: "loading" }, el("span", { class: "spinner", "aria-hidden": "true" }), text);

const skeletonCards = (n: number): HTMLElement[] =>
  Array.from({ length: n }, () =>
    el(
      "li",
      { class: "skeleton-card", "aria-hidden": "true" },
      el("div", { class: "skeleton skeleton-line", style: "width: 55%; height: 18px" }),
      el("div", { class: "skeleton skeleton-line", style: "width: 35%" }),
      el("div", { class: "skeleton skeleton-line", style: "width: 80%; margin-top: 34px" }),
    ),
  );

/** "3d ago" with the exact time on hover. */
const when = (iso: string): HTMLElement => el("time", { datetime: iso, title: new Date(iso).toLocaleString() }, timeAgo(iso));

// --- routes --------------------------------------------------------------------------------------

type Tab = "live" | "conflicts" | "brain" | "members" | "setup";
type Route = { view: "home" } | { view: "account" } | { view: "repo"; repo: string; tab: Tab };

function parseRoute(hash: string): Route {
  const raw = decodeURIComponent(hash.replace(/^#/, ""));
  if (raw === "" || raw === "/") return { view: "home" };
  if (raw === "/account") return { view: "account" };
  // Before routes, the hash held only the repository: #owner/name.
  const parts = (raw.startsWith("/r/") ? raw.slice(3) : raw.replace(/^\//, "")).split("/");
  const [owner, name, tab] = parts;
  if (owner && name) return { view: "repo", repo: `${owner}/${name}`, tab: tab === "members" || tab === "setup" || tab === "conflicts" || tab === "brain" ? tab : "live" };
  return { view: "home" };
}

const repoHref = (repo: string, tab: Tab = "live"): string => `#/r/${repo}${tab === "live" ? "" : `/${tab}`}`;

/** The page being shown; async renders check it before writing, in case the person moved on. */
let current: Route = { view: "home" };
const showing = (repo: string, tab?: Tab): boolean => current.view === "repo" && current.repo === repo && (tab === undefined || current.tab === tab);

function show(route: Route): void {
  // Every page and tab starts at the top.
  if (JSON.stringify(route) !== JSON.stringify(current)) window.scrollTo(0, 0);
  current = route;
  for (const id of ["view-home", "view-repo", "view-account"]) $(id).hidden = true;
  $("nav-repos").classList.toggle("active", route.view !== "account");
  $("nav-account").classList.toggle("active", route.view === "account");
  if (route.view !== "repo") disconnect();
  if (route.view === "home") {
    document.title = "Pitstop";
    $("view-home").hidden = false;
    void renderHome();
  } else if (route.view === "account") {
    document.title = "Account · Pitstop";
    $("view-account").hidden = false;
    void renderAccount();
  } else {
    document.title = `${route.repo} · Pitstop`;
    $("view-repo").hidden = false;
    $("repo-title").textContent = route.repo;
    for (const tab of ["live", "conflicts", "brain", "members", "setup"] as const) {
      const link = $<HTMLAnchorElement>(`tab-${tab}`);
      link.href = repoHref(route.repo, tab);
      link.className = tab === route.tab ? "active" : "";
      if (tab === route.tab) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    $<HTMLAnchorElement>("ob-setup-link").href = repoHref(route.repo, "setup");
    $<HTMLAnchorElement>("ob-invite-link").href = repoHref(route.repo, "members");
    $<HTMLAnchorElement>("ob-resolver-link").href = repoHref(route.repo, "members");
    $("pane-live").hidden = route.tab !== "live";
    $("pane-conflicts").hidden = route.tab !== "conflicts";
    $("pane-brain").hidden = route.tab !== "brain";
    $("pane-members").hidden = route.tab !== "members";
    $("pane-setup").hidden = route.tab !== "setup";
    follow(route.repo);
    void loadRepoMembers(route.repo);
    renderOnboarding();
    if (route.tab === "conflicts") void renderConflicts(route.repo);
    else void countConflicts(route.repo);
    if (route.tab === "brain") void renderBrain(route.repo);
    else void loadBrainVersion(route.repo);
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
    who.append(el("a", { href: "#/account", class: "who-user", title: "Your account and tokens" }, avatar(session.me.login, "avatar-sm"), el("span", { class: "who-name" }, session.me.login)));
  } else if (token !== "") {
    const forget = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Forget token");
    forget.addEventListener("click", () => {
      token = "";
      localStorage.removeItem(TOKEN_KEY);
      location.hash = "#/";
      toast("The server token is gone from this browser.", "info");
      void start();
    });
    who.append(el("span", { class: "badge accent" }, "server token"), forget);
  } else if (session.accounts) {
    who.append(el("a", { href: "/auth/github", class: "btn btn-primary btn-sm" }, "Sign in with GitHub"));
  }
  $("nav-account").hidden = session.me === undefined;
  $("nav-repos").hidden = !signedIn();
  // Without sign-in the server takes its shared token; with sign-in the page never asks for it.
  $("token-form").hidden = session.accounts || signedIn();
}

// --- home: your repositories ---------------------------------------------------------------------

async function renderHome(): Promise<void> {
  $("home-out").hidden = signedIn();
  $("home-in").hidden = !signedIn();
  $("home-token-hint").hidden = session.accounts;
  $("sign-in-hero").hidden = !session.accounts;
  if (!signedIn()) return;
  $("new-owner").textContent = session.me === undefined ? "" : `${session.me.login.toLowerCase()}/`;
  $<HTMLInputElement>("new-name").placeholder = session.me === undefined ? "owner/name" : "name";
  const list = $("repos");
  if (list.childElementCount === 0) list.replaceChildren(...skeletonCards(3));
  $("no-repos").hidden = true;
  const repos = (await api<Repo[]>("/repos")) ?? [];
  if (current.view !== "home") return;
  $("no-repos").hidden = repos.length > 0;
  list.replaceChildren(...repos.map(repoCard));
  void decorateRepoCards(repos);
}

function repoCard(r: Repo): HTMLElement {
  const [owner = "", name = r.id] = r.id.split("/");
  return el(
    "li",
    { class: "repo-card", "data-repo": r.id },
    el(
      "div",
      { class: "repo-card-top" },
      el("a", { class: "repo-name", href: repoHref(r.id) }, el("span", { class: "owner" }, `${owner} / `), name),
      el("span", { class: "repo-role" }),
    ),
    el(
      "div",
      { class: "repo-stats" },
      r.headLsn === 0 ? el("span", { class: "badge" }, "empty") : el("span", {}, "head ", el("span", { class: "mono" }, `#${r.headLsn}`)),
      el("span", { class: "repo-members" }),
      el("span", {}, "created ", when(r.createdAt)),
    ),
    el(
      "div",
      { class: "repo-links" },
      el("a", { href: repoHref(r.id) }, "Live"),
      el("a", { href: repoHref(r.id, "conflicts") }, "Conflicts"),
      el("a", { href: repoHref(r.id, "members") }, "Members"),
      el("a", { href: repoHref(r.id, "setup") }, "Set up Claude"),
    ),
  );
}

/** Fills in each card's role, member count and waiting conflicts once those answers arrive. */
async function decorateRepoCards(repos: Repo[]): Promise<void> {
  const myLogin = session.me?.login.toLowerCase();
  await Promise.all(
    repos.map(async (r) => {
      const [members, parked] = await Promise.all([api<MemberRow[]>(`/repos/${r.id}/members`), api<ParkedRow[]>(`/repos/${r.id}/parked`)]);
      const card = $("repos").querySelector<HTMLElement>(`[data-repo="${CSS.escape(r.id)}"]`);
      if (card === null) return;
      const role = card.querySelector(".repo-role");
      const mine = members?.find((m) => m.pending !== true && m.login.toLowerCase() === myLogin);
      const label = session.me === undefined ? "administrator" : mine === undefined ? (members === undefined ? undefined : "public") : mine.role;
      if (role !== null && label !== undefined) {
        role.replaceChildren(el("span", { class: `badge ${label === "owner" ? "accent" : ""}`.trim() }, label), mine?.resolver === true ? el("span", { class: "badge ok" }, "resolver") : "");
        role.className = "repo-role badges";
      }
      const count = members?.filter((m) => m.pending !== true).length;
      if (count !== undefined) card.querySelector(".repo-members")?.replaceChildren(plural(count, "member"));
      const waiting = parked?.filter((p) => p.status === "open").length ?? 0;
      if (waiting > 0) card.querySelector(".repo-stats")?.prepend(el("a", { class: "badge warn", href: repoHref(r.id, "conflicts"), style: "position: relative; z-index: 1" }, `${waiting} waiting`));
    }),
  );
}

async function createRepo(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const input = $<HTMLInputElement>("new-name");
  const name = input.value.trim().toLowerCase();
  if (name === "") return;
  const id = session.me === undefined ? name : `${session.me.login.toLowerCase()}/${name}`;
  await busy(ev.submitter instanceof HTMLButtonElement ? ev.submitter : null, async () => {
    const res = await call<Repo>("POST", "/repos", { id });
    if (res.status === 201 || res.status === 200) {
      input.value = "";
      say("new-repo-msg", "", true);
      toast(res.status === 201 ? `${id} is ready. Next: set up Claude.` : `${id} already exists; opening it.`, "ok");
      location.hash = repoHref(id, "setup");
      return;
    }
    say("new-repo-msg", messageOf(res.body, `the server answered ${res.status}`), false);
  });
}

// --- members and invites -------------------------------------------------------------------------

interface MemberRow {
  login: string;
  role: "owner" | "writer" | "reader";
  resolver?: boolean;
  pending?: boolean;
}

/** A line about the state of a page (no access, a failed load); results of actions go to toasts. */
function say(id: string, text: string, ok: boolean): void {
  const msg = $(id);
  msg.className = `msg ${ok ? "ok" : "error"}`;
  msg.textContent = text;
}

/** The current repository's members, for the onboarding checklist. */
const repoMeta = { repo: "", members: undefined as MemberRow[] | undefined };

async function loadRepoMembers(repo: string): Promise<void> {
  const members = await api<MemberRow[]>(`/repos/${repo}/members`);
  if (!showing(repo)) return;
  repoMeta.repo = repo;
  repoMeta.members = members;
  renderOnboarding();
}

/**
 * The three first steps on a new repository: set up Claude (the log has entries, or a worktree is
 * connected), invite a teammate, mark the resolver. Shown on the Live tab to a signed-in account
 * until the repository has entries and more than one member. The administrator's shared token
 * never sees it: on a server without sign-in nobody could ever accept an invite.
 */
function renderOnboarding(): void {
  const box = $("onboarding");
  const members = repoMeta.repo === state.repo ? repoMeta.members : undefined;
  if (session.me === undefined || !showing(state.repo, "live") || members === undefined || state.head === null) {
    box.hidden = true;
    return;
  }
  const entries = state.head > 0;
  const others = members.length > 1;
  if (entries && others) {
    box.hidden = true;
    return;
  }
  const steps: [string, boolean][] = [
    ["ob-setup", entries || state.worktrees.length > 0],
    ["ob-invite", others],
    ["ob-resolver", members.some((m) => m.resolver === true)],
  ];
  for (const [id, done] of steps) $(id).classList.toggle("done", done);
  $("onboarding-progress").textContent = `${steps.filter(([, done]) => done).length} of 3`;
  box.hidden = false;
}

const ROLE_HELP: Record<MemberRow["role"], string> = {
  owner: "Manages members, commits, decides when no resolver is marked",
  writer: "Commits through their agents",
  reader: "Watches the log",
};

let membersShown = "";

async function renderMembers(repo: string): Promise<void> {
  if (membersShown !== repo) {
    $("members").replaceChildren(loadingRow("Loading members…"));
    $("invite-box").hidden = true;
    membersShown = repo;
  }
  say("members-msg", "", true);
  const res = await call<MemberRow[]>("GET", `/repos/${repo}/members`);
  if (!showing(repo)) return;
  if (res.status !== 200 || res.body === undefined) {
    $("members").replaceChildren();
    say("members-msg", messageOf(res.body, res.status === 401 ? "Sign in to see this repository." : `the server answered ${res.status}`), false);
    $("invite-box").hidden = true;
    return;
  }
  const rows = res.body;
  repoMeta.repo = repo;
  repoMeta.members = rows;
  const myLogin = session.me?.login.toLowerCase();
  const mine = rows.find((m) => m.pending !== true && m.login.toLowerCase() === myLogin);
  // A signed-in user manages as an owner; the administrator's token manages everything.
  const canManage = session.me === undefined ? token !== "" : mine?.role === "owner";
  $("invite-box").hidden = !canManage;
  const put = async (login: string, body: { role: string; resolver?: boolean }, done: string): Promise<void> => {
    const r = await call("PUT", `/repos/${repo}/members/${encodeURIComponent(login)}`, body);
    if (r.status >= 300) toast(messageOf(r.body, `the server answered ${r.status}`), "error");
    else toast(done, "ok");
    await renderMembers(repo);
  };
  // The list is rebuilt after every change: keep keyboard focus on the same control (found by its label).
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && $("members").contains(active) ? active.getAttribute("aria-label") : null;
  $("members").replaceChildren(
    ...rows.map((m) => {
      const self = m.pending !== true && m.login.toLowerCase() === myLogin;
      const pending = m.pending === true;
      const role = el(
        "select",
        { class: "select member-role", "aria-label": `Role of ${m.login}` },
        ...(["owner", "writer", "reader"] as const).map((r) => el("option", r === m.role ? { value: r, selected: "" } : { value: r }, r[0]?.toUpperCase() + r.slice(1))),
      );
      role.disabled = !canManage || pending;
      role.addEventListener("change", () => void put(m.login, { role: role.value }, `${m.login} is now ${role.value === "owner" ? "an" : "a"} ${role.value}.`));
      const resolver = el("input", { type: "checkbox", role: "switch", "aria-label": `${m.login} decides on conflicts` });
      resolver.checked = m.resolver === true;
      resolver.disabled = !canManage || pending;
      resolver.addEventListener("change", () =>
        void put(m.login, { role: m.role, resolver: resolver.checked }, resolver.checked ? `${m.login} now decides on conflicts.` : `${m.login} no longer decides on conflicts.`),
      );
      const removeLabel = self ? `Leave ${repo}` : pending ? `Withdraw the invite for ${m.login}` : `Remove ${m.login}`;
      const remove = el("button", { type: "button", class: "btn btn-ghost btn-sm member-remove", "aria-label": removeLabel }, self ? "Leave" : pending ? "Withdraw" : "Remove");
      remove.addEventListener("click", () => void removeMember(repo, m.login, self, pending));
      return el(
        "li",
        { class: pending ? "pending" : "" },
        avatar(m.login),
        el(
          "div",
          { class: "member-name" },
          el("span", { class: "login" }, m.login),
          self ? el("span", { class: "badge accent" }, "you") : null,
          pending ? el("span", { class: "badge warn" }, "invited") : null,
          m.resolver === true ? el("span", { class: "badge ok" }, "resolver") : null,
          el("span", { class: "member-sub" }, pending ? "Joins the first time they sign in here" : ROLE_HELP[m.role]),
        ),
        role,
        el("label", { class: "switch", title: "A resolver decides when a commit would break what another change relied on" }, resolver, "Resolver"),
        canManage || self ? remove : el("span", { class: "member-remove" }),
      );
    }),
  );
  if (focused !== null) {
    // A removed member's row is gone: the first control of the list takes the focus instead.
    const same = $("members").querySelector<HTMLElement>(`[aria-label="${CSS.escape(focused)}"]`);
    (same ?? $("members").querySelector<HTMLElement>("select:not(:disabled), input:not(:disabled), button"))?.focus();
  }
  renderOnboarding();
}

async function removeMember(repo: string, login: string, self: boolean, pending: boolean): Promise<void> {
  const ask = self
    ? confirmAction(`Leave ${repo}?`, "You lose access to this repository until an owner invites you again.", "Leave")
    : pending
      ? confirmAction(`Withdraw the invite for ${login}?`, `They will not join ${repo} when they sign in.`, "Withdraw invite")
      : confirmAction(`Remove ${login} from ${repo}?`, "They lose access at once, and their checkout stops receiving entries.", "Remove");
  if (!(await ask)) return;
  const r = await call("DELETE", `/repos/${repo}/members/${encodeURIComponent(login)}`);
  if (r.status >= 300) {
    toast(messageOf(r.body, `the server answered ${r.status}`), "error");
    return;
  }
  if (self) {
    toast(`You left ${repo}.`, "info");
    location.hash = "#/";
    return;
  }
  toast(pending ? `The invite for ${login} is withdrawn.` : `${login} is removed from ${repo}.`, "ok");
  await renderMembers(repo);
}

async function invite(ev: SubmitEvent, repo: string): Promise<void> {
  ev.preventDefault();
  const input = $<HTMLInputElement>("invite-login");
  const login = input.value.trim().replace(/^@/, "");
  const role = $<HTMLSelectElement>("invite-role").value;
  if (login === "") return;
  await busy(ev.submitter instanceof HTMLButtonElement ? ev.submitter : null, async () => {
    const res = await call<MemberRow>("PUT", `/repos/${repo}/members/${encodeURIComponent(login)}`, { role });
    if (res.status === 202) toast(`${login} is invited as ${role}. They join the first time they sign in at ${location.origin}.`, "ok");
    else if (res.status < 300) toast(`${login} is added as ${role}.`, "ok");
    else {
      toast(messageOf(res.body, `the server answered ${res.status}`), "error");
      return;
    }
    input.value = "";
    await renderMembers(repo);
  });
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

/**
 * The Set up Claude texts in full (what the Copy buttons copy) and the personal token in them. On
 * screen the token is masked unless the person asks to see it, so a screen recording or a shared
 * screen does not publish a working token.
 */
const setupText = { prompt: "", manual: "", secret: "", revealed: false };

const masked = (text: string): string =>
  setupText.secret === "" || setupText.revealed ? text : text.split(setupText.secret).join(`${setupText.secret.slice(0, 8)}…`);

function renderSetupText(): void {
  $("prompt").textContent = masked(setupText.prompt);
  $("manual-cmds").textContent = masked(setupText.manual);
  for (const id of ["reveal-prompt", "reveal-manual"]) {
    const button = $(id);
    button.hidden = setupText.secret === "";
    button.textContent = setupText.revealed ? "Hide token" : "Show token";
  }
}

/** The same setup for someone who prefers a terminal: install the client, then `pitstop setup`. */
function renderManual(repo: string, secret?: string): void {
  const server = location.origin;
  setupText.manual = [`npm install -g ${server}/pitstop-cli.tgz`, `pitstop setup ${server} ${repo} --token ${secret ?? "<your personal token>"}`].join("\n");
  renderSetupText();
}

async function renderSetup(repo: string): Promise<void> {
  $("setup-repo").textContent = repo;
  $("prompt-box").hidden = true;
  $("prompt-warning").hidden = true;
  setupText.prompt = "";
  setupText.secret = "";
  setupText.revealed = false;
  say("setup-msg", "", true);
  renderManual(repo);
  const button = $<HTMLButtonElement>("make-prompt");
  button.textContent = "Create a token and write the prompt";
  $("setup-state").textContent = "";
  const info = await call<Repo>("GET", `/repos/${repo}`);
  if (!showing(repo, "setup")) return;
  if (info.status !== 200 || info.body === undefined) {
    button.hidden = true;
    say("setup-msg", messageOf(info.body, info.status === 401 ? "Sign in to set up this repository." : `the server answered ${info.status}`), false);
    return;
  }
  const empty = info.body.headLsn === 0;
  $("setup-state").textContent = empty
    ? "This repository is empty: the first setup imports the code from your existing checkout as entry #1."
    : `This repository has ${plural(info.body.headLsn, "entry", "entries")}: setup builds a fresh checkout from them and keeps it in sync.`;
  button.hidden = false;
  button.onclick = () => void busy(button, () => makePrompt(repo, empty));
}

async function makePrompt(repo: string, empty: boolean): Promise<void> {
  if (session.me === undefined) {
    // The administrator's shared token must never travel in a prompt.
    setupText.secret = "";
    $("prompt-warning").hidden = true;
    showPrompt(promptText(repo, "<your personal token: sign in, then Account>", empty));
    say("setup-msg", "Sign in with GitHub to get a personal token for this prompt.", false);
    return;
  }
  const made = await call<{ secret: string }>("POST", "/tokens", { name: `claude ${repo}`.slice(0, 80) });
  if (made.status !== 201 || made.body === undefined) {
    toast(messageOf(made.body, `the server answered ${made.status}`), "error");
    return;
  }
  setupText.secret = made.body.secret;
  setupText.revealed = false;
  showPrompt(promptText(repo, made.body.secret, empty));
  renderManual(repo, made.body.secret);
  $("prompt-warning").hidden = false;
  say("setup-msg", "", true);
  $("make-prompt").textContent = "Create another token";
  toast("A personal token was made and the prompt is ready. Copy it into Claude Code.", "ok");
}

function showPrompt(text: string): void {
  setupText.prompt = text;
  renderSetupText();
  $("prompt-box").hidden = false;
}

// --- conflicts: commits waiting for the resolver ------------------------------------------------

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

/** Who decides on this repository's conflicts (its resolvers, else its owners), and whether that includes the person looking. */
async function deciders(repo: string): Promise<{ me: boolean; who: string[] }> {
  const members = await api<MemberRow[]>(`/repos/${repo}/members`);
  if (members === undefined) return { me: session.me === undefined && token !== "", who: [] };
  const active = members.filter((m) => m.pending !== true);
  const resolvers = active.filter((m) => m.resolver === true);
  const list = resolvers.length > 0 ? resolvers : active.filter((m) => m.role === "owner");
  const who = list.map((m) => m.login);
  if (session.me === undefined) return { me: token !== "", who };
  const me = session.me.login.toLowerCase();
  return { me: who.some((login) => login.toLowerCase() === me), who };
}

function setConflictCount(open: number): void {
  const badge = $("conflict-count");
  badge.textContent = String(open);
  badge.hidden = open === 0;
}

async function countConflicts(repo: string): Promise<void> {
  const list = (await api<ParkedRow[]>(`/repos/${repo}/parked`)) ?? [];
  if (!showing(repo)) return;
  setConflictCount(list.filter((p) => p.status === "open").length);
}

let conflictsShown = "";
/** What the list showed last (ids and statuses): a refresh that changes nothing leaves the page, and any note being typed, alone. */
let conflictsKey = "";

async function renderConflicts(repo: string, quiet = false): Promise<void> {
  if (conflictsShown !== repo) {
    $("conflicts").replaceChildren(loadingRow("Loading conflicts…"));
    $("no-conflicts").hidden = true;
    conflictsShown = repo;
    conflictsKey = "";
  }
  const res = await call<ParkedRow[]>("GET", `/repos/${repo}/parked`);
  if (!showing(repo, "conflicts")) return;
  if (res.status !== 200 || res.body === undefined) {
    $("conflicts").replaceChildren();
    say("conflicts-msg", messageOf(res.body, res.status === 401 ? "Sign in to see this repository." : `the server answered ${res.status}`), false);
    return;
  }
  say("conflicts-msg", "", true);
  const list = res.body;
  const decide = await deciders(repo);
  if (!showing(repo, "conflicts")) return;
  const key = JSON.stringify([decide, list.map((p) => [p.id, p.status])]);
  setConflictCount(list.filter((p) => p.status === "open").length);
  if (quiet && key === conflictsKey) return;
  conflictsKey = key;
  // Notes being typed survive a refresh, and so do the focus and the cursor in the one being typed.
  const notes = new Map<string, string>();
  for (const area of $("conflicts").querySelectorAll<HTMLTextAreaElement>("textarea[data-id]")) notes.set(area.dataset.id ?? "", area.value);
  const active = document.activeElement;
  const typing = active instanceof HTMLTextAreaElement && active.dataset.id !== undefined ? { id: active.dataset.id, start: active.selectionStart, end: active.selectionEnd } : undefined;
  // "Nothing is waiting" whenever nothing is open; decided ones stay listed under it.
  $("no-conflicts").hidden = list.some((p) => p.status === "open");
  $("conflicts").replaceChildren(...list.map((p) => conflictCard(repo, p, decide, notes.get(p.id) ?? "")));
  if (typing !== undefined) {
    const area = $("conflicts").querySelector<HTMLTextAreaElement>(`textarea[data-id="${CSS.escape(typing.id)}"]`);
    area?.focus();
    area?.setSelectionRange(typing.start, typing.end);
  }
}

/** `#1 changed src/auth/session.ts#getCurrentUser (signature)` in plain words, one sentence per changed symbol. */
function skewSentences(skew: string): HTMLElement[] {
  return skew.split("; ").map((part) => {
    const m = /^#(\d+) changed (.+?)( \(signature\))?$/.exec(part.trim());
    if (m === null) return el("p", {}, part);
    const [, lsn = "", symbol = "", signature] = m;
    const hash = symbol.lastIndexOf("#");
    const file = hash > 0 ? symbol.slice(0, hash) : symbol;
    const name = hash > 0 ? symbol.slice(hash + 1) : "";
    return el(
      "p",
      {},
      "Entry ",
      el("strong", { class: "mono" }, `#${lsn}`),
      " changed ",
      signature === undefined ? "" : "the signature of ",
      name === "" ? el("code", {}, file) : el("code", {}, name),
      name === "" ? "" : " in ",
      name === "" ? "" : el("code", {}, file),
      ".",
    );
  });
}

function fileView(f: ParkedRow["files"][number]): HTMLElement {
  const op = ["add", "modify", "delete", "rename"].includes(f.op) ? f.op : "";
  return el(
    "details",
    { class: "file" },
    el("summary", {}, el("span", { class: `file-op ${op}`.trim() }, f.op), el("span", { class: "path" }, f.fromPath === undefined ? f.path : `${f.fromPath} → ${f.path}`)),
    f.content === undefined ? el("p", { class: "no-content" }, "No content (the file is deleted or moved).") : el("pre", {}, f.content),
  );
}

function conflictCard(repo: string, p: ParkedRow, decide: { me: boolean; who: string[] }, note: string): HTMLElement {
  const status =
    p.status === "open"
      ? el("span", { class: "badge warn" }, "Waiting for a decision")
      : p.status === "accepted"
        ? el("span", { class: "badge ok" }, `Let through by ${p.decidedBy ?? "?"}${p.landedLsn === undefined ? "" : ` as #${p.landedLsn}`}`)
        : el("span", { class: "badge" }, `Sent back by ${p.decidedBy ?? "?"}`);
  const card = el(
    "li",
    { class: `conflict ${p.status === "open" ? "open" : ""}`.trim(), "data-id": p.id },
    el("div", { class: "conflict-head" }, el("h3", { class: "conflict-intent" }, p.intent), status),
    el(
      "div",
      { class: "conflict-meta" },
      agentChip(p.author.agent),
      el("span", {}, `for ${p.author.developer}`),
      when(p.createdAt),
      el("span", { class: "mono", title: "Its id on the server" }, p.id),
    ),
    el(
      "div",
      { class: "conflict-body" },
      el(
        "div",
        { class: "skew-box" },
        icon(ICON_WARN),
        el(
          "div",
          {},
          el("h3", {}, "Write skew: something it relied on changed underneath it"),
          ...skewSentences(p.skew),
          el("p", {}, `This commit's agent read that code before the change landed (the log was at #${p.headLsn} when it tried to land), so its files may still rely on the old version. Git would have merged it without a word.`),
        ),
      ),
      el("div", { class: "files" }, el("span", { class: "files-label" }, plural(p.files.length, "file")), ...p.files.map(fileView)),
      p.note === undefined ? null : el("p", { class: "note" }, el("span", { class: "note-label" }, `Note from ${p.decidedBy ?? "the resolver"}`), p.note),
    ),
  );
  if (p.status === "open" && decide.me) {
    const noteId = `note-${p.id}`;
    const area = el("textarea", { id: noteId, "data-id": p.id, placeholder: "What should the agent change? For example: guard the null user before reading lastSeen." });
    area.value = note;
    const accept = el("button", { type: "button", class: "btn btn-ok" }, "Let it through");
    const back = el("button", { type: "button", class: "btn btn-secondary" }, "Send back with a note");
    accept.addEventListener("click", () => void busy(accept, () => decideOn(repo, p, "accept")));
    back.addEventListener("click", () => void busy(back, () => decideOn(repo, p, "send-back", area.value)));
    card.append(
      el(
        "div",
        { class: "decide" },
        el("div", { class: "field" }, el("label", { class: "field-label", for: noteId }, "Note for its author (sent with Send back)"), area),
        el(
          "div",
          { class: "decide-actions" },
          el("div", { class: "decide-option" }, accept, el("p", {}, "Lands it as it is, as the next entry in the log, with your name on the decision. Every checkout receives it.")),
          el("div", { class: "decide-option" }, back, el("p", {}, "Closes it and sends your note to its author. Their agent re-reads what changed, adapts, and commits again.")),
        ),
      ),
    );
  } else if (p.status === "open") {
    const who = decide.who.length === 0 ? "this repository's resolver" : decide.who.join(", ");
    card.append(el("p", { class: "waiting-note" }, el("span", { class: "spinner", "aria-hidden": "true" }), `Waiting for ${who} to decide.`));
  }
  return card;
}

async function decideOn(repo: string, p: ParkedRow, action: "accept" | "send-back", note?: string): Promise<void> {
  const res = await call<ParkedRow>("POST", `/repos/${repo}/parked/${p.id}/${action}`, action === "send-back" ? { note: note ?? "" } : undefined);
  if (res.status >= 300) toast(messageOf(res.body, `the server answered ${res.status}`), "error");
  else if (action === "accept") toast(`"${p.intent}" landed${res.body?.landedLsn === undefined ? "" : ` as #${res.body.landedLsn}`}. Every checkout receives it now.`, "ok");
  else toast(`"${p.intent}" went back to ${p.author.developer}; their agent adapts and commits again.`, "ok");
  await renderConflicts(repo);
  // The buttons are gone with the decision: keep keyboard focus on the card, which now shows the outcome.
  if (document.activeElement === null || document.activeElement === document.body) {
    const card = $("conflicts").querySelector<HTMLElement>(`li[data-id="${CSS.escape(p.id)}"]`);
    if (card !== null) {
      card.tabIndex = -1;
      card.focus();
    }
  }
}

// --- brain: ADRs, the brain version, re-check, leases (design doc 9) ----------------------------

interface BrainView {
  version: number;
  adrs: Adr[];
  leases: Lease[];
}

interface RecheckView {
  head: number;
  version: number;
  checkedFiles: number;
  violations: { adr: number; title: string; rule: string; file: string; line: number; detail?: string }[];
  queue: { lsn: number; intent: string; author: { developer: string; agent: string }; brainVersion: number; files: string[]; adrs: number[] }[];
}

/** A rule in a sentence, as the people reading the ADR say it. */
function ruleText(rule: AdrRule): string {
  switch (rule.kind) {
    case "forbid_import":
      return `${rule.files} may not import ${rule.target}`;
    case "forbid_call":
      return `${rule.files} may not call ${rule.call}()`;
    case "forbid_pattern":
      return `${rule.files} may not contain /${rule.pattern}/${rule.message ? `: ${rule.message}` : ""}`;
    case "ai_review":
      return `a model reviews ${rule.files} (advice only): ${rule.question}`;
  }
}

const RULE_KINDS: { kind: AdrRule["kind"]; label: string; value: string }[] = [
  { kind: "forbid_import", label: "may not import", value: "src/db/**" },
  { kind: "forbid_call", label: "may not call", value: "db.query" },
  { kind: "forbid_pattern", label: "may not contain", value: "console\\.log\\(" },
  { kind: "ai_review", label: "a model reviews", value: "Does this keep expired sessions out?" },
];

/** The brain version on the tab and in the pane's title. */
function setBrainVersion(version: number): void {
  $("brain-version").textContent = `v${version}`;
  $("brain-version").hidden = false;
  $("brain-title-version").textContent = `v${version}`;
}

async function loadBrainVersion(repo: string): Promise<void> {
  const brain = await api<BrainView>(`/repos/${repo}/brain`);
  if (brain !== undefined && showing(repo)) setBrainVersion(brain.version);
}

/** Owners decide on ADRs (and release anyone's lease); the administrator's token may too. */
async function ownsRepo(repo: string): Promise<boolean> {
  if (session.me === undefined) return token !== "";
  const me = session.me.login.toLowerCase();
  const members = (await api<MemberRow[]>(`/repos/${repo}/members`)) ?? [];
  return members.some((m) => m.pending !== true && m.role === "owner" && m.login.toLowerCase() === me);
}

async function renderBrain(repo: string): Promise<void> {
  const [brain, owner] = await Promise.all([api<BrainView>(`/repos/${repo}/brain`), ownsRepo(repo)]);
  if (!showing(repo, "brain")) return;
  if (brain === undefined) {
    $("adrs").replaceChildren();
    $("no-adrs").hidden = false;
    return;
  }
  setBrainVersion(brain.version);
  // Accepted first, then proposed, then the past; newest first within each.
  const rank = { accepted: 0, proposed: 1, superseded: 2, rejected: 3 } as const;
  const adrs = [...brain.adrs].sort((a, b) => rank[a.status] - rank[b.status] || b.number - a.number);
  $("no-adrs").hidden = adrs.length > 0;
  $("adrs").replaceChildren(...adrs.map((a) => adrCard(repo, a, owner)));
  $("no-leases").hidden = brain.leases.length > 0;
  $("leases").replaceChildren(...brain.leases.map((l) => leaseRow(repo, l, owner)));
}

function adrCard(repo: string, a: Adr, owner: boolean): HTMLElement {
  const badgeClass = { accepted: "ok", proposed: "warn", superseded: "", rejected: "bad" }[a.status];
  const actions = el("div", { class: "adr-actions" });
  if (owner && a.status === "proposed") {
    const accept = el("button", { type: "button", class: "btn btn-ok btn-sm" }, "Accept");
    const reject = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Reject");
    accept.addEventListener("click", () => void decideAdr(repo, a, "accept"));
    reject.addEventListener("click", () => void decideAdr(repo, a, "reject"));
    actions.append(accept, reject);
  }
  if (owner && a.status === "accepted") {
    const supersede = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Supersede");
    supersede.addEventListener("click", () => void decideAdr(repo, a, "supersede"));
    actions.append(supersede);
  }
  return el(
    "li",
    { class: `adr ${a.status}` },
    el("div", { class: "adr-head" }, el("span", { class: "adr-number" }, `ADR-${a.number}`), el("h3", { class: "adr-title" }, a.title), el("span", { class: `badge ${badgeClass}`.trim() }, a.status)),
    el("p", { class: "adr-decision" }, a.decision),
    a.reason === "" ? null : el("p", { class: "adr-reason" }, a.reason),
    a.rules.length === 0
      ? el("p", { class: "adr-reason" }, "Text only: agents read it, no rule is checked.")
      : el("ul", { class: "adr-rules" }, ...a.rules.map((r) => el("li", {}, el("span", { class: "rule-kind" }, r.kind), el("span", {}, ruleText(r))))),
    el(
      "div",
      { class: "adr-meta" },
      el("span", {}, `proposed by ${a.createdBy}`),
      when(a.createdAt),
      a.decidedBy === undefined ? null : el("span", {}, `${a.status} by ${a.decidedBy}`),
      a.version === 0 ? null : el("span", { class: "mono" }, `brain v${a.version}`),
    ),
    actions.childElementCount === 0 ? null : actions,
  );
}

async function decideAdr(repo: string, a: Adr, action: "accept" | "reject" | "supersede"): Promise<void> {
  if (action !== "accept") {
    const ok = await confirmAction(
      action === "reject" ? `Reject ADR-${a.number}?` : `Supersede ADR-${a.number}?`,
      action === "reject" ? "It stays in the record as rejected; its rules are never checked." : "Its rules stop being checked from the next brain version on; changes that passed it keep the version they passed.",
      action === "reject" ? "Reject" : "Supersede",
    );
    if (!ok) return;
  }
  const res = await call<{ version: number; adr: Adr }>("POST", `/repos/${repo}/adrs/${a.number}/${action}`);
  if (res.status >= 300 || res.body === undefined) {
    toast(messageOf(res.body, `the server answered ${res.status}`), "error");
    return;
  }
  toast(`ADR-${a.number} ${res.body.adr.status}: brain v${res.body.version}`, "ok");
  await renderBrain(repo);
}

function leaseRow(repo: string, l: Lease, owner: boolean): HTMLElement {
  const mine = session.me !== undefined && l.holder.developer.toLowerCase() === session.me.login.toLowerCase();
  const left = Math.max(0, Math.round((new Date(l.expiresAt).getTime() - Date.now()) / 60_000));
  const row = el(
    "li",
    {},
    el("span", { class: "mono" }, l.symbol),
    el("span", {}, agentChip(l.holder.agent), ` ${l.holder.developer} · expires in ${left} min`),
    l.reason === "" ? null : el("span", { class: "field-hint" }, l.reason),
  );
  if (owner || mine) {
    const release = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Release");
    release.addEventListener("click", () => void releaseLease(repo, l.symbol));
    row.append(release);
  }
  return row;
}

async function releaseLease(repo: string, symbol: string): Promise<void> {
  const res = await call("DELETE", `/repos/${repo}/leases?symbol=${encodeURIComponent(symbol)}`);
  if (res.status >= 300) toast(messageOf(res.body, `the server answered ${res.status}`), "error");
  else toast(`${symbol} released`, "ok");
  await renderBrain(repo);
}

/** One row of the rules builder: kind, the files it covers, and its target/call/pattern/question. */
function ruleRow(kind: AdrRule["kind"] = "forbid_import"): HTMLElement {
  const select = el("select", { class: "select input-sm", "aria-label": "Rule kind" }, ...RULE_KINDS.map((k) => el("option", k.kind === kind ? { value: k.kind, selected: "" } : { value: k.kind }, k.label)));
  const files = el("input", { class: "input input-sm", "aria-label": "Files (glob)", placeholder: "src/pages/**", value: "src/pages/**" });
  const value = el("input", { class: "input input-sm", "aria-label": "Target", placeholder: RULE_KINDS[0]?.value ?? "" });
  const remove = el("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-label": "Remove this rule" }, "×");
  const hint = (): void => {
    value.placeholder = RULE_KINDS.find((k) => k.kind === select.value)?.value ?? "";
  };
  select.addEventListener("change", hint);
  hint();
  const row = el("div", { class: "rule-row" }, select, files, value, remove);
  remove.addEventListener("click", () => row.remove());
  return row;
}

function rulesFromForm(): AdrRule[] {
  return [...$("adr-rules").querySelectorAll<HTMLElement>(".rule-row")].flatMap((row): AdrRule[] => {
    const [select, files, value] = [row.querySelector("select"), ...row.querySelectorAll("input")] as [HTMLSelectElement, HTMLInputElement, HTMLInputElement];
    const f = files.value.trim();
    const v = value.value.trim();
    if (f === "" || v === "") return [];
    switch (select.value) {
      case "forbid_import":
        return [{ kind: "forbid_import", files: f, target: v }];
      case "forbid_call":
        return [{ kind: "forbid_call", files: f, call: v }];
      case "forbid_pattern":
        return [{ kind: "forbid_pattern", files: f, pattern: v }];
      default:
        return [{ kind: "ai_review", files: f, question: v }];
    }
  });
}

async function proposeAdr(ev: SubmitEvent, repo: string): Promise<void> {
  ev.preventDefault();
  const body = {
    title: $<HTMLInputElement>("adr-title").value.trim(),
    decision: $<HTMLTextAreaElement>("adr-decision").value.trim(),
    reason: $<HTMLTextAreaElement>("adr-reason").value.trim(),
    rules: rulesFromForm(),
  };
  const res = await call<Adr>("POST", `/repos/${repo}/adrs`, body);
  if (res.status !== 201 || res.body === undefined) {
    toast(messageOf(res.body, `the server answered ${res.status}`), "error");
    return;
  }
  toast(`ADR-${res.body.number} proposed: an owner accepts it to put it in force`, "ok");
  $<HTMLFormElement>("adr-form").reset();
  $("adr-rules").replaceChildren(ruleRow());
  await renderBrain(repo);
}

async function recheck(repo: string): Promise<void> {
  const out = $("recheck-result");
  out.replaceChildren(el("span", { class: "field-hint" }, "Checking…"));
  const res = await call<RecheckView>("GET", `/repos/${repo}/brain/recheck`);
  if (res.status !== 200 || res.body === undefined) {
    out.replaceChildren(el("span", { class: "field-hint" }, messageOf(res.body, `the server answered ${res.status}`)));
    return;
  }
  const r = res.body;
  const summary = el("p", { class: "field-hint" }, `${plural(r.checkedFiles, "file")} at #${r.head} checked against brain v${r.version}.`);
  if (r.violations.length === 0 && r.queue.length === 0) {
    out.replaceChildren(summary, el("p", { class: "clean" }, "Everything at head follows the accepted rules."));
    return;
  }
  out.replaceChildren(
    summary,
    ...r.violations.map((v) =>
      el("div", { class: "violation" }, el("strong", {}, `ADR-${v.adr} ${v.title}`), el("div", { class: "mono" }, `${v.file}:${v.line}`), el("div", { class: "field-hint" }, v.detail ?? v.rule)),
    ),
    ...r.queue.map((q) =>
      el("div", { class: "queued" }, `#${q.lsn} "${q.intent}" by ${q.author.agent} passed brain v${q.brainVersion}, before ADR-${q.adrs.join(", ADR-")}: ${q.files.join(", ")}`),
    ),
  );
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
  const me = session.me;
  // The secret is shown once: any later render (a revoke, coming back) hides it.
  $("new-token-box").hidden = true;
  $("new-token-secret").textContent = "";
  $("new-token").hidden = me === undefined;
  $("no-tokens").hidden = true;
  const pic = $("account-avatar");
  if (me === undefined) {
    pic.hidden = true;
    $("account-who").textContent = token !== "" ? "Server administrator" : "Not signed in";
    $("account-sub").textContent = token !== "" ? "You use this server's shared token. Personal tokens belong to accounts." : "Sign in with GitHub to make personal tokens.";
    $("sign-out").hidden = true;
    $("tokens").replaceChildren();
    return;
  }
  pic.hidden = false;
  pic.style.setProperty("--h", String(hueOf(me.login.toLowerCase())));
  pic.textContent = initials(me.login);
  $("account-who").textContent = me.login;
  $("account-sub").textContent = me.name ? `${me.name} · signed in with GitHub` : "Signed in with GitHub";
  $("sign-out").hidden = false;
  const list = $("tokens");
  if (list.childElementCount === 0) list.replaceChildren(loadingRow("Loading tokens…"));
  const tokens = (await api<TokenRow[]>("/tokens")) ?? [];
  if (current.view !== "account") return;
  // Active ones first, newest first.
  const sorted = [...tokens].sort((a, b) => Number(a.revokedAt !== undefined) - Number(b.revokedAt !== undefined) || b.createdAt.localeCompare(a.createdAt));
  $("no-tokens").hidden = tokens.length > 0;
  list.replaceChildren(
    ...sorted.map((t) => {
      const revoked = t.revokedAt !== undefined;
      const revoke = el("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Revoke");
      revoke.addEventListener("click", () => void revokeToken(t));
      const dates: Child[] = ["Created ", when(t.createdAt), " · "];
      if (revoked && t.revokedAt !== undefined) dates.push("revoked ", when(t.revokedAt));
      else if (t.lastUsedAt !== undefined) dates.push("last used ", when(t.lastUsedAt));
      else dates.push("never used");
      return el(
        "li",
        { class: revoked ? "revoked" : "" },
        el("span", { class: "token-icon", "aria-hidden": "true" }, icon(ICON_KEY)),
        el(
          "div",
          { class: "token-main" },
          el("div", { class: "token-name" }, t.name, revoked ? el("span", { class: "badge bad" }, "revoked") : el("span", { class: "badge ok" }, "active")),
          el("div", { class: "token-dates" }, ...dates),
        ),
        revoked ? null : revoke,
      );
    }),
  );
}

async function revokeToken(t: TokenRow): Promise<void> {
  if (!(await confirmAction(`Revoke "${t.name}"?`, "Anything that uses it (a daemon, the Pitstop tools on that computer) stops working at once.", "Revoke"))) return;
  const res = await call("DELETE", `/tokens/${t.id}`);
  if (res.status >= 300) toast(messageOf(res.body, `the server answered ${res.status}`), "error");
  else toast(`"${t.name}" is revoked.`, "ok");
  await renderAccount();
}

async function createToken(ev: SubmitEvent): Promise<void> {
  ev.preventDefault();
  const input = $<HTMLInputElement>("new-token-name");
  const name = input.value.trim();
  if (name === "") return;
  await busy(ev.submitter instanceof HTMLButtonElement ? ev.submitter : null, async () => {
    const made = await call<{ secret: string }>("POST", "/tokens", { name });
    if (made.status !== 201 || made.body === undefined) {
      toast(messageOf(made.body, `the server answered ${made.status}`), "error");
      return;
    }
    input.value = "";
    await renderAccount();
    $("new-token-secret").textContent = made.body.secret;
    $("new-token-box").hidden = false;
    toast(`"${name}" is made. Copy it now: it is shown only once.`, "ok");
  });
}

// --- start ---------------------------------------------------------------------------------------

async function start(): Promise<void> {
  await loadSession();
  show(parseRoute(location.hash));
}

async function signOut(): Promise<void> {
  await call("POST", "/auth/logout");
  $("repos").replaceChildren();
  $("tokens").replaceChildren();
  location.hash = "#/";
  toast("Signed out.", "info");
  await start();
}

function setup(): void {
  // The Brain tab: the rules builder starts with one row; propose and re-check act on the repository shown.
  $("adr-rules").replaceChildren(ruleRow());
  $("adr-add-rule").addEventListener("click", () => $("adr-rules").append(ruleRow()));
  $<HTMLFormElement>("adr-form").addEventListener("submit", (ev) => {
    if (current.view === "repo") void proposeAdr(ev, current.repo);
    else ev.preventDefault();
  });
  $("recheck-btn").addEventListener("click", () => {
    if (current.view === "repo") void recheck(current.repo);
  });
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
  // The skip link moves focus to the page's content; following its #content would count as a route.
  $("skip-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    $("content").focus();
  });
  // Copy takes the full text; the screen shows the token masked (setupText).
  $("copy-prompt").addEventListener("click", () => void copy(setupText.prompt, "Prompt", "Paste it into Claude Code."));
  $("copy-manual").addEventListener("click", () => void copy(setupText.manual, "Commands"));
  for (const id of ["reveal-prompt", "reveal-manual"]) {
    $(id).addEventListener("click", () => {
      setupText.revealed = !setupText.revealed;
      renderSetupText();
    });
  }
  $("copy-token").addEventListener("click", () => void copy($("new-token-secret").textContent ?? "", "Token"));
  $("sign-out").addEventListener("click", () => void signOut());
  $("close").addEventListener("click", () => select(null));
  $("see-how").addEventListener("click", () =>
    $("how").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }),
  );
  $("new-repo-jump").addEventListener("click", () => {
    const card = $("new-name").closest(".card");
    card?.scrollIntoView({ block: "nearest" });
    $("new-name").focus();
    card?.classList.remove("flash");
    void (card as HTMLElement | null)?.offsetWidth;
    card?.classList.add("flash");
  });
  const live = $("pane-live");
  // The live view's render functions stay as they are: colour and keyboard access are added here.
  const focusable = (row: HTMLElement): HTMLElement => {
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    return row;
  };
  new MutationObserver(() => {
    paintAgents(live);
    for (const row of live.querySelectorAll<HTMLElement>('#log > li:not([tabindex]), #events > li[style*="pointer"]:not([tabindex])')) focusable(row);
  }).observe(live, { childList: true, subtree: true });
  // Enter or Space on a focused log or event row acts like a click. Selecting rebuilds the log, so
  // the focus goes back to the same entry's new row.
  for (const id of ["log", "events"]) {
    $(id).addEventListener("keydown", (ev) => {
      const row = ev.target;
      if (!(row instanceof HTMLElement) || row.parentElement?.id !== id || row.tabIndex !== 0) return;
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault();
      const lsn = row.querySelector(".lsn")?.textContent;
      row.click();
      if (!row.isConnected && lsn !== undefined) {
        // The observer marks new rows a moment later; this one is needed now.
        for (const next of $("log").querySelectorAll<HTMLElement>(":scope > li")) if (next.querySelector(".lsn")?.textContent === lsn) focusable(next).focus();
      }
    });
  }
  // A landed entry flashes once: once its animation has played it is no longer "live", so a later
  // re-render of the log (a click on another entry) does not replay it on the newest row.
  $("log").addEventListener("animationend", (ev) => {
    if (ev.animationName !== "land" || !(ev.target instanceof Element)) return;
    const lsn = Number(ev.target.closest("li")?.querySelector(".lsn")?.textContent?.slice(1));
    if (Number.isInteger(lsn)) state.live.delete(lsn);
  });
  window.addEventListener("hashchange", () => show(parseRoute(location.hash)));
  window.setInterval(renderIntents, 5_000);
  window.setInterval(renderPresence, PRESENCE_REDRAW_MS);
  window.setInterval(() => void pollWorktrees(), WORKTREES_MS);
  // A conflict parked while the Conflicts tab is open shows up without a reload.
  window.setInterval(() => {
    if (current.view === "repo" && current.tab === "conflicts" && !document.hidden) void renderConflicts(current.repo, true);
  }, 5_000);
  void start();
}

setup();
