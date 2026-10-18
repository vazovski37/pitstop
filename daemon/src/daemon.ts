/**
 * The daemon process: the stream client plus a local HTTP API on 127.0.0.1 for the agent side
 * (the MCP tools and the safe-point hook in mcp/). Design doc sections 8.3 and 10.
 *
 *   GET  /status                       applied LSN, head, open intent, pending entries, agent attached
 *   POST /safe-point                   apply pending entries now; returns what was applied and notes for the agent
 *   POST /intents {text, symbols?}     declare an intent through the server; remembered for heartbeats and the commit;
 *                                      the answer carries the brain in brief (ADRs, leases on the declared symbols)
 *   POST /commit {intent}              commit @; 200 accepted, 409 with the server's rejection verbatim
 *   GET  /brain                        the repository's brain: version, ADRs, leases, open intents (one line each)
 *   POST /lease {symbol, reason?, ttlSeconds?, release?}
 *                                      take (or release) a lease on one symbol for the open intent; 409 when another
 *                                      agent holds it, 200 with the status otherwise (held, released, not_held, invalid)
 *   GET  /history?symbol=              every change to a symbol, with intents (the server's query API)
 *   GET  /why?path=                    the entries that touched a file, latest first (the server's query API)
 *   GET  /callers?symbol=              the entries that read a symbol, and those that changed it (the server's query API)
 *   GET  /presence                     who is working in the repository right now (presence.ts)
 *
 * The port is written to .pitstop/daemon.json so the tools find it. Safe points: once an agent has
 * posted one, entries wait for the next safe point instead of landing mid-tool; a daemon that has
 * seen none for `attachMs` applies as they arrive, as in Phase 1.
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { z } from "zod";
import { Changeset, DEFAULT_REPO, type Author, type Intent, type Lease, type SymbolId } from "@pitstop/protocol";
import {
  adrLine,
  brainBrief,
  brainLines,
  clock,
  fetchBrain,
  fetchLeases,
  holdsLease,
  LEASE_TTL_SECONDS,
  releaseLease,
  symbolCallers,
  symbolHistory,
  takeLease,
  whyPath,
  type History,
  type LeaseAnswer,
  type ServerAccess,
} from "./brain.js";
import { commit, CommitRejected } from "./commit.js";
import { serverHeaders, streamUrl } from "./config.js";
import { declareIntent } from "./intents.js";
import type { Applier } from "./jj.js";
import { Presence, type PresenceIntent } from "./presence.js";
import { readState, STATE_DIR, stateDir } from "./state.js";
import { StreamClient, type Applied, type BrainChange, type Warning } from "./stream.js";
import { hasTsProject, symbolSets, type SymbolSets } from "./symbols.js";

export const DAEMON_FILE = "daemon.json";

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
}

export const daemonInfoPath = (worktree: string): string => join(worktree, STATE_DIR, DAEMON_FILE);

/** Where the worktree's daemon listens, or undefined when none wrote the file. */
export async function readDaemonInfo(worktree: string): Promise<DaemonInfo | undefined> {
  try {
    const raw = JSON.parse(await readFile(daemonInfoPath(worktree), "utf8")) as Partial<DaemonInfo>;
    if (typeof raw.port === "number" && typeof raw.pid === "number") {
      return { port: raw.port, pid: raw.pid, startedAt: String(raw.startedAt ?? "") };
    }
  } catch {
    // no daemon
  }
  return undefined;
}

export interface DaemonOptions {
  serverUrl: string;
  token?: string;
  /** The repository on the server; absent means its default one. */
  repo?: string;
  worktree: string;
  applier: Applier;
  author: Author;
  log?: (line: string) => void;
  /** Local API port; 0 (default) picks a free one. */
  port?: number;
  /** How long after a safe point the agent counts as attached; default ten minutes. */
  attachMs?: number;
  reconnectMs?: number;
  heartbeatMs?: number;
  /** Minimum time between two diffs of the unfinished edits for presence at safe points (presence.ts). */
  presenceFilesMs?: number;
  /**
   * How often this agent's leases are looked at and, when past half their time, renewed by asking
   * the server again (only a holder's request renews a lease); default 20 s, 0 never.
   */
  leaseRenewMs?: number;
  fetch?: typeof fetch;
  onError?: (err: unknown) => void;
}

export interface SafePointResult {
  /** LSNs applied at this safe point, in order. */
  applied: number[];
  /** Entries still waiting (none unless an apply is in progress). */
  pending: number;
  /** One line each, for the agent: entries that touched its work, conflicts, warnings. */
  notes: string[];
}

export interface Status {
  appliedLsn: number;
  headLsn: number | null;
  pending: number;
  attached: boolean;
  intent: { id: string; text: string } | null;
  openIntents: { id: string; agent: string; text: string }[];
  worktree: string;
  repo: string | null;
  pid: number;
}

const IntentBody = z.object({ text: z.string().min(1), symbols: z.array(z.string()).optional() });
const CommitBody = z.object({ intent: z.string().min(1) });
const LeaseBody = z.object({
  symbol: z.string().regex(/^[^#]+#.+$/, "expected path#qualified.name"),
  reason: z.string().optional(),
  ttlSeconds: z.number().int().positive().optional(),
  release: z.boolean().optional(),
});

/** An intent as `POST /intents` answers it: the server's, with the brain in brief for the agent. */
export type DeclaredIntent = Intent & { brief: string[] };

/** What a lease asked for with no open intent is told: a lease lives and ends with an intent. */
export const NO_INTENT_FOR_LEASE = "Declare your intent first (declare_intent), then take the lease; it lives and ends with that intent.";

/** Events kept for the next safe point; a daemon no agent attaches to keeps no more than these. */
const KEPT_EVENTS = 100;
const keepLast = <T>(list: T[]): void => {
  if (list.length > KEPT_EVENTS) list.splice(0, list.length - KEPT_EVENTS);
};

export class Daemon {
  readonly stream: StreamClient;
  /** This worktree's presence and its copy of the repository's document (presence.ts). */
  readonly presence: Presence;
  private http: Server | undefined;
  private attachedUntil = 0;
  private warnings: Warning[] = [];
  /** Brain changes and lease events since the last safe point, for its notes. */
  private brainChanges: BrainChange[] = [];
  private leaseEvents: Lease[] = [];
  /** Intents the server marked stale since the last safe point (one may be this agent's). */
  private staleIntents: string[] = [];
  private readonly intents = new Map<string, Intent>();
  private declared: Intent | undefined;
  /** Leases this agent took through the daemon: the time to live it asked for, so a renewal asks the same. */
  private readonly leaseTtl = new Map<SymbolId, number>();
  /** Symbols this agent released itself: their `released` event is no news to it. */
  private readonly selfReleased = new Set<SymbolId>();
  /** Whether this agent may hold a lease, so the renewal timer asks the server. */
  private mayHoldLeases = false;
  /** Intents this daemon has seen as its own (declared here, or open in the state file). */
  private readonly ownIntents = new Set<string>();
  private renewTimer: NodeJS.Timeout | undefined;
  port = 0;

  constructor(private readonly opts: DaemonOptions) {
    this.stream = new StreamClient({
      url: streamUrl(opts.serverUrl),
      ...(opts.token === undefined ? {} : { token: opts.token }),
      ...(opts.repo === undefined ? {} : { repo: opts.repo }),
      worktree: opts.worktree,
      applier: opts.applier,
      ...(opts.log === undefined ? {} : { log: opts.log }),
      ...(opts.reconnectMs === undefined ? {} : { reconnectMs: opts.reconnectMs }),
      ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }),
      hold: () => this.attached,
      onWarning: (w) => {
        this.warnings.push(w);
        keepLast(this.warnings);
      },
      onIntent: (i) => {
        if (i.status === "open") this.intents.set(i.id, i);
        else this.intents.delete(i.id);
        if (i.status === "stale") {
          this.staleIntents.push(i.id);
          keepLast(this.staleIntents);
        }
      },
      onSubscribed: () => void this.presence.publish(true),
      onPresence: (m) => this.presence.receive(m.repo, m.entries),
      onHeartbeat: () => void this.presence.keepalive(),
      onApplied: () => this.presence.bump(),
      onBrain: (change) => {
        this.brainChanges.push(change);
        keepLast(this.brainChanges);
      },
      onLease: (lease) => {
        this.leaseEvents.push(lease);
        keepLast(this.leaseEvents);
        if (lease.status === "held" && lease.holder.developer === opts.author.developer && lease.holder.agent === opts.author.agent) this.mayHoldLeases = true;
      },
      ...(opts.onError === undefined ? {} : { onError: opts.onError }),
    });
    this.presence = new Presence({
      worktree: opts.worktree,
      repo: opts.repo ?? DEFAULT_REPO,
      author: opts.author,
      applier: opts.applier,
      send: (message) => this.stream.publish(message),
      appliedLsn: () => this.stream.appliedLsn,
      intent: () => this.openIntent(),
      ...(opts.presenceFilesMs === undefined ? {} : { filesMs: opts.presenceFilesMs }),
      ...(opts.log === undefined ? {} : { log: opts.log }),
    });
  }

  /** The worktree's open intent for presence: its id from the state file, its text and symbols from the server. */
  private async openIntent(): Promise<PresenceIntent | undefined> {
    const { intentId } = await readState(this.opts.worktree);
    if (intentId === undefined) return undefined;
    const known = this.declared?.id === intentId ? this.declared : this.intents.get(intentId);
    return { id: intentId, text: known?.text ?? "", symbols: known?.declaredSymbols ?? [] };
  }

  /** True while a coding agent is posting safe points. */
  get attached(): boolean {
    return Date.now() < this.attachedUntil;
  }

  async start(): Promise<number> {
    await this.presence.start();
    await this.stream.start();
    const http = createServer((req, res) => void this.handle(req, res));
    this.http = http;
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.opts.port ?? 0, "127.0.0.1", () => resolve());
    });
    this.port = (http.address() as AddressInfo).port;
    const info: DaemonInfo = { port: this.port, pid: process.pid, startedAt: new Date().toISOString() };
    await stateDir(this.opts.worktree); // a fresh worktree has no .pitstop/ yet
    await writeFile(daemonInfoPath(this.opts.worktree), `${JSON.stringify(info, null, 2)}\n`);
    const renewEvery = this.opts.leaseRenewMs ?? 20_000;
    if (renewEvery > 0) {
      this.renewTimer = setInterval(() => {
        this.renewLeases().catch((err: unknown) => this.opts.log?.(`lease renewal failed: ${err instanceof Error ? err.message : String(err)}`));
      }, renewEvery);
      this.renewTimer.unref();
    }
    return this.port;
  }

  async close(): Promise<void> {
    if (this.renewTimer !== undefined) clearInterval(this.renewTimer);
    this.presence.leave(); // the tombstone goes out before the socket closes
    this.stream.close();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
    await rm(daemonInfoPath(this.opts.worktree), { force: true });
  }

  /** The hook's call: the agent is between tools, so pending entries may land now. */
  async safePoint(): Promise<SafePointResult> {
    this.attachedUntil = Date.now() + (this.opts.attachMs ?? 10 * 60_000);
    const applied = await this.stream.applyPending();
    const notes = await this.notes(applied);
    // Presence: the other agents in the same files (once each), from this worktree's last publish;
    // the new one runs in the background, so the hook never waits on jj and git for presence.
    void this.presence.publish().catch((err) => this.opts.log?.(`presence: publish failed: ${err instanceof Error ? err.message : String(err)}`));
    notes.push(...this.presence.overlapNotes());
    // The read base stays where the work began: the notes see the agent's edits, not what it read
    // before editing, and that read-before-edit is the skew the server checks for. Only a skew
    // refusal moves it (commit.ts), once the server has named what to re-read.
    return { applied: applied.map((a) => a.changeset.lsn), pending: this.stream.pending, notes };
  }

  async status(): Promise<Status> {
    const state = await readState(this.opts.worktree);
    const intent =
      state.intentId === undefined
        ? null
        : { id: state.intentId, text: this.declared?.id === state.intentId ? this.declared.text : (this.intents.get(state.intentId)?.text ?? "") };
    return {
      appliedLsn: this.stream.appliedLsn,
      headLsn: this.stream.headLsn ?? null,
      pending: this.stream.pending,
      attached: this.attached,
      intent,
      openIntents: [...this.intents.values()].map((i) => ({ id: i.id, agent: i.author.agent, text: i.text })),
      worktree: this.opts.worktree,
      repo: this.opts.repo ?? null,
      pid: process.pid,
    };
  }

  /** Where the server's brain and query API are, for brain.ts. */
  private get server(): ServerAccess {
    return {
      serverUrl: this.opts.serverUrl,
      ...(this.opts.token === undefined ? {} : { token: this.opts.token }),
      ...(this.opts.repo === undefined ? {} : { repo: this.opts.repo }),
      ...(this.opts.fetch === undefined ? {} : { fetch: this.opts.fetch }),
    };
  }

  /** Opens the intent, then gives the agent the brain in brief (an unreachable brain leaves it out, never fails the intent). */
  async declare(text: string, symbols: SymbolId[] = []): Promise<DeclaredIntent> {
    const intent = await this.open(text, symbols);
    let brief: string[] = [];
    try {
      brief = brainBrief(await fetchBrain(this.server), intent.declaredSymbols, this.opts.author, intent.id);
    } catch (err) {
      this.opts.log?.(`brain unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { ...intent, brief };
  }

  private async open(text: string, symbols: SymbolId[]): Promise<Intent> {
    const intent = await declareIntent({
      serverUrl: this.opts.serverUrl,
      ...(this.opts.token === undefined ? {} : { token: this.opts.token }),
      ...(this.opts.repo === undefined ? {} : { repo: this.opts.repo }),
      worktree: this.opts.worktree,
      author: this.opts.author,
      text,
      declaredSymbols: symbols,
      ...(this.opts.fetch === undefined ? {} : { fetch: this.opts.fetch }),
      ...(this.opts.log === undefined ? {} : { log: this.opts.log }),
    });
    this.declared = intent;
    this.ownIntents.add(intent.id);
    if (this.ownIntents.size > KEPT_EVENTS) this.ownIntents.delete(this.ownIntents.values().next().value as string);
    await this.presence.publish(true);
    return intent;
  }

  /** Commits @ as the CLI does, closing the declared intent; a rejection comes back as a value. */
  async commit(intent: string): Promise<{ status: "accepted"; changeset: Changeset } | { status: "rejected"; reason: string; message: string; conflictsWith: number[] }> {
    try {
      const changeset = await commit({
        serverUrl: this.opts.serverUrl,
        ...(this.opts.token === undefined ? {} : { token: this.opts.token }),
        ...(this.opts.repo === undefined ? {} : { repo: this.opts.repo }),
        worktree: this.opts.worktree,
        applier: this.opts.applier,
        intent,
        author: this.opts.author,
        ...(this.opts.fetch === undefined ? {} : { fetch: this.opts.fetch }),
        ...(this.opts.log === undefined ? {} : { log: this.opts.log }),
      });
      this.declared = undefined;
      await this.presence.publish(true);
      return { status: "accepted", changeset };
    } catch (err) {
      if (err instanceof CommitRejected) {
        return { status: "rejected", reason: err.reason, message: err.message, conflictsWith: err.conflictsWith };
      }
      throw err;
    }
  }

  /** The log from the server, oldest first. */
  async log(limit = 500): Promise<Changeset[]> {
    const url = new URL("/log", this.opts.serverUrl);
    if (this.opts.repo !== undefined) url.searchParams.set("repo", this.opts.repo);
    url.searchParams.set("fromLsn", "0");
    url.searchParams.set("limit", String(limit));
    const res = await (this.opts.fetch ?? fetch)(url, { headers: serverHeaders(this.opts.token) });
    if (!res.ok) throw new Error(`GET /log answered ${res.status}`);
    return z.array(Changeset).parse(await res.json());
  }

  /** The entries that touched a path, latest first (`GET /repos/:o/:n/why`). */
  async why(path: string, limit = 5): Promise<WhyEntry[]> {
    const answer = await whyPath(this.server, path, limit);
    return answer.entries.map((e) => ({
      lsn: e.lsn,
      intent: e.intent,
      ...(e.intentId === undefined ? {} : { intentId: e.intentId }),
      agent: e.author.agent,
      op: e.op,
      createdAt: e.createdAt,
      brainVersion: e.brainVersion,
      repairs: e.repairs,
    }));
  }

  /**
   * The entries that read a symbol (its callers as far as the log knows: read sets, not a parsed
   * call graph), with what they wrote, and the ones that changed it.
   */
  async callers(symbol: SymbolId): Promise<{ readers: Ref[]; writers: Ref[]; note: string }> {
    const [callers, history] = await Promise.all([symbolCallers(this.server, symbol), symbolHistory(this.server, symbol)]);
    const ref = (e: { lsn: number; intent: string; author: Author; files: { path: string }[] }): Ref => ({
      lsn: e.lsn,
      intent: e.intent,
      agent: e.author.agent,
      files: e.files.map((f) => f.path),
    });
    return {
      readers: callers.callers.map((e) => ({ ...ref(e), wrote: e.wrote })),
      writers: history.history.map(ref),
      note: callers.derivedFrom,
    };
  }

  /** Every change to a symbol, newest first, with the intents behind them; who declared it; its lease. */
  async history(symbol: SymbolId): Promise<History> {
    return symbolHistory(this.server, symbol);
  }

  /** The repository's brain, one line per ADR, lease and open intent. */
  async brain(): Promise<{ version: number; lines: string[] }> {
    const [brain, { intentId }] = await Promise.all([fetchBrain(this.server), readState(this.opts.worktree)]);
    return { version: brain.version, lines: brainLines(brain, this.opts.author, intentId) };
  }

  /**
   * Takes a lease for this agent's open intent, or releases its own. A lease lives and ends with an
   * intent (the daemon renews it while that intent is open, the commit releases it), so with no
   * open intent the answer is `invalid` and says to declare one first.
   */
  async lease(symbol: SymbolId, opts: { reason?: string | undefined; ttlSeconds?: number | undefined; release?: boolean | undefined } = {}): Promise<LeaseAnswer> {
    const { intentId } = await readState(this.opts.worktree);
    if (opts.release === true) {
      const answer = await releaseLease(this.server, symbol, this.opts.author, intentId);
      if (answer.status === "released") {
        this.selfReleased.add(symbol);
        this.leaseTtl.delete(symbol);
      }
      return answer;
    }
    if (intentId === undefined) return { status: "invalid", message: NO_INTENT_FOR_LEASE };
    const answer = await takeLease(this.server, {
      symbol,
      holder: this.opts.author,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
      ...(opts.ttlSeconds === undefined ? {} : { ttlSeconds: opts.ttlSeconds }),
      intentId,
    });
    if (answer.status === "held") {
      this.leaseTtl.set(symbol, opts.ttlSeconds ?? LEASE_TTL_SECONDS);
      this.mayHoldLeases = true;
    }
    return answer;
  }

  /**
   * Renews this agent's leases on its open intent once half their time is gone, by asking the
   * server again: only a holder's own request renews a lease (a heartbeat on the stream, which any
   * reader may send, does not). A crashed daemon renews nothing, so its leases run out (9.3).
   */
  async renewLeases(now = Date.now()): Promise<void> {
    if (!this.mayHoldLeases) return;
    const { intentId } = await readState(this.opts.worktree);
    const me = this.opts.author;
    const mine = intentId === undefined ? [] : (await fetchLeases(this.server)).filter((l) => l.intentId === intentId && holdsLease(l, me, intentId));
    if (mine.length === 0) {
      this.mayHoldLeases = false;
      return;
    }
    for (const lease of mine) {
      const ttl = this.leaseTtl.get(lease.symbol) ?? LEASE_TTL_SECONDS;
      if (Date.parse(lease.expiresAt) - now > (ttl * 1000) / 2) continue;
      const answer = await takeLease(this.server, { symbol: lease.symbol, holder: me, reason: lease.reason, ttlSeconds: ttl, intentId });
      if (answer.status !== "held") this.opts.log?.(`could not renew the lease on ${lease.symbol}: ${answer.message}`);
    }
  }

  /** One line per thing the agent should know after a safe point. */
  private async notes(applied: Applied[]): Promise<string[]> {
    const notes: string[] = [];
    const mine = this.warnings.filter((w) => w.agent === this.opts.author.agent);
    this.warnings = [];
    for (const w of mine) notes.push(`warning: ${w.message}`);
    // This agent's own task, ended by the server: it went quiet too long (its leases went with it).
    const { intentId: open } = await readState(this.opts.worktree);
    const ownStale = this.staleIntents.splice(0).filter((id) => id === open || id === this.declared?.id);
    for (const id of new Set(ownStale)) {
      notes.push(`your intent ${id} was marked stale (no heartbeat for 5 minutes) and its leases were released; declare_intent again before you take a lease`);
    }
    // The brain changed: a rule the next commit answers to, or one that no longer applies.
    for (const { version, adr } of this.brainChanges.splice(0)) {
      if (adr.status === "accepted") notes.push(`brain v${version}: ADR-${adr.number} accepted: ${adrLine(adr).slice(`ADR-${adr.number} `.length)}`);
      else if (adr.status === "superseded") notes.push(`brain v${version}: ADR-${adr.number} superseded: ${adr.title} no longer applies`);
    }
    let editing: Set<string> | undefined;
    const editingNow = async (): Promise<Set<string>> => (editing ??= new Set((await this.opts.applier.diffAgainstMain()).map((f) => f.path)));
    notes.push(...(await this.leaseNotes(editingNow, open, new Set(ownStale))));
    if (applied.length === 0) return notes;

    const editingFiles = await editingNow();
    this.presence.setFiles(editingFiles); // presence's next publish uses this diff instead of running its own
    let sets: SymbolSets | undefined;
    if (editingFiles.size > 0) {
      const after = await this.opts.applier.treeFiles("@");
      if (hasTsProject(after)) sets = symbolSets(await this.opts.applier.treeFiles("main"), after, this.opts.worktree);
    }
    for (const { changeset: e, result } of applied) {
      const changed = new Set<SymbolId>([...e.writeSet, ...e.sigWriteSet]);
      const signature = new Set(e.sigWriteSet);
      const written = sets?.writeSet.filter((s) => changed.has(s)) ?? [];
      const read = sets?.readSet.filter((s) => changed.has(s) && !written.includes(s)) ?? [];
      const touched = e.files.map((f) => f.path).filter((p) => editingFiles.has(p));
      const parts: string[] = [];
      if (written.length > 0) parts.push(`changed ${written.join(", ")}, which you also changed`);
      if (read.length > 0) {
        parts.push(`changed ${read.map((s) => (signature.has(s) ? `${s} (signature)` : s)).join(", ")}, which your change reads`);
      }
      if (touched.length > 0 && parts.length === 0) parts.push(`touched ${touched.join(", ")}, which you are editing`);
      if (parts.length > 0) notes.push(`#${e.lsn} "${e.intent}" ${parts.join("; ")}`);
      if (result.resolved.length > 0) {
        notes.push(`#${e.lsn} conflicted with your edits in ${result.resolved.join(", ")}; Mergiraf merged them by structure, so check those files`);
      }
      if (result.conflictedFiles.length > 0) {
        notes.push(`#${e.lsn} left conflict markers in ${result.conflictedFiles.join(", ")}: resolve them before you commit`);
      } else if (result.conflicted.length > 0) {
        notes.push(`#${e.lsn} left conflicts in your working copy (jj resolve --list): resolve them before you commit`);
      }
    }
    return notes;
  }

  /**
   * Leases other agents took or gave up since the last safe point, on symbols this agent declared
   * or in files it is editing; the last event per symbol. And this agent's own leases that ended
   * without its asking: expired, or released (by an owner) while its intent is still open. Its
   * commit's releases, its own releases and a stale intent's (noted already) are no news.
   */
  private async leaseNotes(editing: () => Promise<Set<string>>, open: string | undefined, stale: Set<string>): Promise<string[]> {
    const me = this.opts.author;
    if (open !== undefined) this.ownIntents.add(open);
    // Ours: our author and one of our intents (the same person's other checkout counts as another agent).
    const ours = (l: Lease) => l.holder.developer === me.developer && l.holder.agent === me.agent && (l.intentId === undefined || this.ownIntents.has(l.intentId));
    const latest = new Map<string, Lease>();
    const own = new Map<string, Lease>();
    for (const lease of this.leaseEvents.splice(0)) {
      if (ours(lease)) own.set(lease.symbol, lease);
      else latest.set(lease.symbol, lease);
    }
    const notes: string[] = [];
    for (const lease of own.values()) {
      if (lease.status === "held") {
        this.selfReleased.delete(lease.symbol);
        continue;
      }
      if (this.selfReleased.delete(lease.symbol)) continue;
      if (lease.intentId !== undefined && stale.has(lease.intentId)) continue;
      if (lease.status === "released" && (lease.intentId === undefined || lease.intentId !== open)) continue;
      this.leaseTtl.delete(lease.symbol);
      notes.push(`your lease on ${lease.symbol} ended (${lease.status}); another agent may take it. Take it again with lease if you still need it`);
    }
    if (latest.size === 0) return notes;
    const declared = new Set(this.declared?.declaredSymbols ?? []);
    const files = await editing();
    for (const lease of latest.values()) {
      const file = lease.symbol.slice(0, lease.symbol.indexOf("#"));
      if (!declared.has(lease.symbol) && !files.has(file)) continue;
      const who = `${lease.holder.agent} (${lease.holder.developer})`;
      notes.push(
        lease.status === "held"
          ? `lease: ${who} holds ${lease.symbol} until ${clock(lease.expiresAt)}${lease.reason ? ` (${lease.reason})` : ""}; a commit of yours that changes it is refused until then, so leave it alone or wait`
          : `lease: ${lease.symbol} is free again (${who}'s lease ${lease.status})`,
      );
    }
    return notes;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/status") return json(res, 200, await this.status());
      if (req.method === "POST" && url.pathname === "/safe-point") return json(res, 200, await this.safePoint());
      if (req.method === "POST" && url.pathname === "/intents") {
        const body = IntentBody.safeParse(await readJson(req));
        if (!body.success) return json(res, 400, { error: "expected {text, symbols?}" });
        return json(res, 201, await this.declare(body.data.text, body.data.symbols ?? []));
      }
      if (req.method === "POST" && url.pathname === "/commit") {
        const body = CommitBody.safeParse(await readJson(req));
        if (!body.success) return json(res, 400, { error: "expected {intent}" });
        const answer = await this.commit(body.data.intent);
        return json(res, answer.status === "accepted" ? 200 : 409, answer);
      }
      if (req.method === "GET" && url.pathname === "/why") {
        const path = url.searchParams.get("path");
        if (!path) return json(res, 400, { error: "expected ?path=" });
        return json(res, 200, await this.why(path));
      }
      if (req.method === "GET" && url.pathname === "/callers") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json(res, 400, { error: "expected ?symbol=" });
        return json(res, 200, await this.callers(symbol));
      }
      if (req.method === "GET" && url.pathname === "/presence") return json(res, 200, this.presence.view());
      if (req.method === "GET" && url.pathname === "/history") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json(res, 400, { error: "expected ?symbol=" });
        return json(res, 200, await this.history(symbol));
      }
      if (req.method === "GET" && url.pathname === "/brain") return json(res, 200, await this.brain());
      if (req.method === "POST" && url.pathname === "/lease") {
        const body = LeaseBody.safeParse(await readJson(req));
        if (!body.success) return json(res, 400, { error: "expected {symbol: path#name, reason?, ttlSeconds?, release?}" });
        const { symbol, ...rest } = body.data;
        const answer = await this.lease(symbol, rest);
        return json(res, answer.status === "leased" ? 409 : 200, answer);
      }
      return json(res, 404, { error: "not_found" });
    } catch (err) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.opts.log?.(`local api ${req.method} ${url.pathname} failed: ${message}`);
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

export interface WhyEntry {
  lsn: number;
  intent: string;
  intentId?: string;
  agent: string;
  op: string;
  createdAt: string;
  /** The brain version the entry was validated against. */
  brainVersion?: number;
  repairs: string[];
}

export interface Ref {
  lsn: number;
  intent: string;
  agent: string;
  files: string[];
  /** For a reader: the symbols its change wrote. */
  wrote?: string[];
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
  });
