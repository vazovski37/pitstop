import WebSocket from "ws";
import { ServerMessage, type Changeset, type ClientMessage, type Intent } from "@pitstop/protocol";
import type { Applier, ApplyResult } from "./jj.js";
import { describe } from "./messages.js";
import { readState, withWorktreeLock, writeState } from "./state.js";

export type Warning = Extract<ServerMessage, { type: "warning" }>;

export interface StreamOptions {
  /** The server's `/stream` endpoint, `ws://` or `wss://`. */
  url: string;
  /** `PITSTOP_TOKEN`, sent as `Authorization: Bearer`. */
  token?: string;
  /** The repository to follow; absent means the server's default one. */
  repo?: string;
  worktree: string;
  applier: Applier;
  log?: (line: string) => void;
  /** Delay before reconnecting after the socket closes; 0 never reconnects. */
  reconnectMs?: number;
  /** Interval of the `heartbeat` that reports the applied LSN and the open intent; 0 sends one only after each apply. */
  heartbeatMs?: number;
  /**
   * While it returns true, entries wait in the queue instead of being applied as they arrive;
   * `applyPending()` applies them. The daemon holds while a coding agent is attached and applies
   * at its safe points (daemon.ts).
   */
  hold?: () => boolean;
  onApplied?: (lsn: number) => void;
  onGap?: (expected: number, got: number) => void;
  onWarning?: (warning: Warning) => void;
  onIntent?: (intent: Intent) => void;
  /** An apply failed, or the log keeps skipping the next LSN: the daemon has stopped and closed the connection. */
  onError?: (err: unknown) => void;
}

/** Consecutive gaps at the same LSN before the daemon gives up; the server's replay never has gaps by design. */
export const GAP_RETRIES = 3;

export class GapError extends Error {
  constructor(readonly expected: number, readonly got: number) {
    super(`the log has no entry #${expected} (got #${got} ${GAP_RETRIES} times); this worktree's state and the server's log disagree`);
  }
}

/** One entry applied by `applyPending()`, with what the apply produced. */
export interface Applied {
  changeset: Changeset;
  result: ApplyResult;
}

/**
 * The daemon's side of `GET /stream` (design doc section 8.2).
 *
 * After `hello` it subscribes from the worktree's applied LSN and applies entries strictly in
 * order, one at a time. An entry at or below the applied LSN is a replay and is skipped. An entry
 * further ahead than the next LSN is a gap: the queue is dropped and the subscription restarts
 * from the applied LSN. An apply that fails stops the daemon, as daemon/CLAUDE.md requires.
 */
export class StreamClient {
  private socket: WebSocket | undefined;
  private queue: Changeset[] = [];
  /** Drains run one after another; a safe point waits for the apply in progress instead of missing it. */
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private applied = 0;
  private head: number | undefined;
  private gaps = 0;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly opts: StreamOptions) {}

  get appliedLsn(): number {
    return this.applied;
  }

  /** The log's head as last reported by the server, or undefined before `hello`. */
  get headLsn(): number | undefined {
    return this.head;
  }

  /** Entries received and not yet applied. */
  get pending(): number {
    return this.queue.length;
  }

  async start(): Promise<void> {
    this.applied = (await readState(this.opts.worktree)).appliedLsn;
    this.connect();
    const every = this.opts.heartbeatMs ?? 30_000;
    if (every > 0) this.heartbeat = setInterval(() => void this.sendHeartbeat(), every);
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
  }

  /** Applies every queued entry even while `hold` says to wait (a safe point), in order. */
  async applyPending(): Promise<Applied[]> {
    const applied: Applied[] = [];
    await this.drain(true, applied);
    return applied;
  }

  private connect(): void {
    const headers = this.opts.token === undefined ? {} : { authorization: `Bearer ${this.opts.token}` };
    const socket = new WebSocket(this.opts.url, { headers });
    this.socket = socket;
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("error", (err) => this.log(`stream error: ${err.message}`));
    socket.on("close", (code, reason) => {
      this.log(`stream closed (${code}${reason.length ? ` ${reason.toString()}` : ""})`);
      const delay = this.opts.reconnectMs ?? 2_000;
      if (!this.closed && delay > 0) setTimeout(() => this.connect(), delay).unref();
    });
  }

  private onMessage(text: string): void {
    const parsed = ServerMessage.safeParse(tryJson(text));
    if (!parsed.success) {
      this.log("ignored a message that is not a ServerMessage");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "hello":
        this.head = message.headLsn;
        this.log(describe(message));
        this.subscribe();
        break;
      case "head":
        // Answers the subscribe. A head below the applied LSN means this worktree's state and the
        // server's log disagree; the entries that follow (or do not) decide what happens next.
        this.head = message.headLsn;
        this.log(describe(message));
        if (message.headLsn < this.applied) {
          this.log(`this worktree is at #${this.applied}, ahead of the log; was the state file copied?`);
        }
        break;
      case "entry":
        this.head = Math.max(this.head ?? 0, message.changeset.lsn);
        this.queue.push(message.changeset);
        void this.drain();
        break;
      case "warning":
        this.log(describe(message));
        this.opts.onWarning?.(message);
        break;
      case "intent":
        this.log(describe(message));
        this.opts.onIntent?.(message.intent);
        break;
    }
  }

  private subscribe(): void {
    this.queue = [];
    this.send({ type: "subscribe", ...(this.opts.repo === undefined ? {} : { repo: this.opts.repo }), fromLsn: this.applied });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async sendHeartbeat(): Promise<void> {
    const { intentId } = await readState(this.opts.worktree).catch(() => ({ intentId: undefined }));
    this.send({ type: "heartbeat", appliedLsn: this.applied, ...(intentId === undefined ? {} : { intentId }) });
  }

  private drain(force = false, applied?: Applied[]): Promise<void> {
    const run = this.chain.then(() => this.drainNow(force, applied));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async drainNow(force: boolean, applied?: Applied[]): Promise<void> {
    try {
      for (;;) {
        if (this.closed) return;
        if (!force && this.opts.hold?.()) return;
        const changeset = this.queue.shift();
        if (changeset === undefined) return;
        // On a gap, applyOne has dropped the queue and subscribed again; the replay that follows
        // lands in the queue while this loop runs, so it just carries on.
        const outcome = await withWorktreeLock(this.opts.worktree, () => this.applyOne(changeset));
        if (outcome !== "skipped" && outcome !== "gap") applied?.push({ changeset, result: outcome });
      }
    } catch (err) {
      const what = err instanceof GapError ? "gave up" : "apply failed";
      this.log(`${what}, stopped at #${this.applied}: ${err instanceof Error ? err.message : String(err)}`);
      this.queue = [];
      this.close();
      this.opts.onError?.(err);
    }
  }

  /** One entry, under the worktree lock. */
  private async applyOne(changeset: Changeset): Promise<"skipped" | "gap" | ApplyResult> {
    // `pitstop commit` runs in its own process and may have applied this very entry meanwhile.
    const state = await readState(this.opts.worktree);
    if (state.appliedLsn > this.applied) this.applied = state.appliedLsn;
    if (changeset.lsn <= this.applied) return "skipped";
    if (changeset.lsn !== this.applied + 1) {
      this.opts.onGap?.(this.applied + 1, changeset.lsn);
      if (++this.gaps >= GAP_RETRIES) throw new GapError(this.applied + 1, changeset.lsn);
      this.log(`gap: expected #${this.applied + 1}, got #${changeset.lsn}; subscribing again`);
      this.subscribe();
      return "gap";
    }
    // Unfinished work in @ began at or before the current applied LSN: the server must check
    // its reads from there, not from the LSN this entry moves the worktree to.
    const readBaseLsn = state.readBaseLsn ?? ((await this.opts.applier.hasChanges()) ? this.applied : undefined);
    const result = await this.opts.applier.apply(changeset);
    this.gaps = 0;
    this.applied = changeset.lsn;
    await writeState(this.opts.worktree, {
      ...state,
      appliedLsn: this.applied,
      ...(readBaseLsn === undefined ? {} : { readBaseLsn }),
    });
    const where = result.conflictedFiles.length > 0 ? result.conflictedFiles : result.conflicted;
    const merged = result.resolved.length === 0 ? "" : ` (Mergiraf resolved ${result.resolved.join(", ")})`;
    const note = where.length === 0 ? "" : ` (conflicts in ${where.join(", ")})`;
    this.log(`applied #${changeset.lsn} ${changeset.intent}${merged}${note}`);
    this.send({
      type: "heartbeat",
      appliedLsn: this.applied,
      ...(state.intentId === undefined ? {} : { intentId: state.intentId }),
    });
    this.opts.onApplied?.(changeset.lsn);
    return result;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
