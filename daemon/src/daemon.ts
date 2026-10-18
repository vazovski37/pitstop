/**
 * The daemon process: the stream client plus a local HTTP API on 127.0.0.1 for the agent side
 * (the MCP tools and the safe-point hook in mcp/). Design doc sections 8.3 and 10.
 *
 *   GET  /status                       applied LSN, head, open intent, pending entries, agent attached
 *   POST /safe-point                   apply pending entries now; returns what was applied and notes for the agent
 *   POST /intents {text, symbols?}     declare an intent through the server; remembered for heartbeats and the commit
 *   POST /commit {intent}              commit @; 200 accepted, 409 with the server's rejection verbatim
 *   GET  /why?path=                    the entries that touched a file, latest first (from GET /log)
 *   GET  /callers?symbol=              the entries that read or changed a symbol (from GET /log)
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
import { Changeset, DEFAULT_REPO, type Author, type Intent, type SymbolId } from "@pitstop/protocol";
import { commit, CommitRejected } from "./commit.js";
import { serverHeaders, streamUrl } from "./config.js";
import { declareIntent } from "./intents.js";
import type { Applier } from "./jj.js";
import { Presence, type PresenceIntent } from "./presence.js";
import { readState, STATE_DIR, stateDir } from "./state.js";
import { StreamClient, type Applied, type Warning } from "./stream.js";
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

export class Daemon {
  readonly stream: StreamClient;
  /** This worktree's presence and its copy of the repository's document (presence.ts). */
  readonly presence: Presence;
  private http: Server | undefined;
  private attachedUntil = 0;
  private warnings: Warning[] = [];
  private readonly intents = new Map<string, Intent>();
  private declared: Intent | undefined;
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
      },
      onIntent: (i) => {
        if (i.status === "open") this.intents.set(i.id, i);
        else this.intents.delete(i.id);
      },
      onSubscribed: () => void this.presence.publish(true),
      onPresence: (m) => this.presence.receive(m.repo, m.entries),
      onHeartbeat: () => void this.presence.keepalive(),
      onApplied: () => this.presence.bump(),
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
    return this.port;
  }

  async close(): Promise<void> {
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

  async declare(text: string, symbols: SymbolId[] = []): Promise<Intent> {
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

  /** The entries that touched a path, latest first. */
  async why(path: string, limit = 5): Promise<WhyEntry[]> {
    const entries = await this.log();
    return entries
      .filter((e) => e.files.some((f) => f.path === path || f.fromPath === path))
      .sort((a, b) => b.lsn - a.lsn)
      .slice(0, limit)
      .map((e) => ({
        lsn: e.lsn,
        intent: e.intent,
        agent: e.author.agent,
        op: e.files.find((f) => f.path === path || f.fromPath === path)?.op ?? "modify",
        createdAt: e.createdAt,
        repairs: e.repairs.map((r) => r.summary),
      }));
  }

  /** The entries that read a symbol (its callers in the log's eyes) and the ones that changed it. */
  async callers(symbol: SymbolId): Promise<{ readers: Ref[]; writers: Ref[] }> {
    const entries = await this.log();
    const ref = (e: Changeset): Ref => ({ lsn: e.lsn, intent: e.intent, agent: e.author.agent, files: e.files.map((f) => f.path) });
    return {
      readers: entries.filter((e) => e.readSet.includes(symbol)).map(ref),
      writers: entries.filter((e) => e.writeSet.includes(symbol) || e.sigWriteSet.includes(symbol)).map(ref),
    };
  }

  /** One line per thing the agent should know after a safe point. */
  private async notes(applied: Applied[]): Promise<string[]> {
    const notes: string[] = [];
    const mine = this.warnings.filter((w) => w.agent === this.opts.author.agent);
    this.warnings = [];
    for (const w of mine) notes.push(`warning: ${w.message}`);
    if (applied.length === 0) return notes;

    const editing = new Set((await this.opts.applier.diffAgainstMain()).map((f) => f.path));
    this.presence.setFiles(editing); // presence's next publish uses this diff instead of running its own
    let sets: SymbolSets | undefined;
    if (editing.size > 0) {
      const after = await this.opts.applier.treeFiles("@");
      if (hasTsProject(after)) sets = symbolSets(await this.opts.applier.treeFiles("main"), after, this.opts.worktree);
    }
    for (const { changeset: e, result } of applied) {
      const changed = new Set<SymbolId>([...e.writeSet, ...e.sigWriteSet]);
      const signature = new Set(e.sigWriteSet);
      const written = sets?.writeSet.filter((s) => changed.has(s)) ?? [];
      const read = sets?.readSet.filter((s) => changed.has(s) && !written.includes(s)) ?? [];
      const touched = e.files.map((f) => f.path).filter((p) => editing.has(p));
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
  agent: string;
  op: string;
  createdAt: string;
  repairs: string[];
}

export interface Ref {
  lsn: number;
  intent: string;
  agent: string;
  files: string[];
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
