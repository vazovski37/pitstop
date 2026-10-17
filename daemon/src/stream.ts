import WebSocket from "ws";
import { ServerMessage, type Changeset, type ClientMessage } from "@pitstop/protocol";
import type { Applier } from "./jj.js";
import { describe } from "./messages.js";
import { readState, writeState } from "./state.js";

export interface StreamOptions {
  /** The server's `/stream` endpoint, `ws://` or `wss://`. */
  url: string;
  /** `PITSTOP_TOKEN`, sent as `Authorization: Bearer`. */
  token?: string;
  worktree: string;
  applier: Applier;
  log?: (line: string) => void;
  /** Delay before reconnecting after the socket closes; 0 never reconnects. */
  reconnectMs?: number;
  /** Interval of the `heartbeat` that reports the applied LSN; 0 sends one only after each apply. */
  heartbeatMs?: number;
  onApplied?: (lsn: number) => void;
  onGap?: (expected: number, got: number) => void;
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
  private draining = false;
  private closed = false;
  private applied = 0;
  private gaps = 0;
  private heartbeat: NodeJS.Timeout | undefined;

  constructor(private readonly opts: StreamOptions) {}

  get appliedLsn(): number {
    return this.applied;
  }

  async start(): Promise<void> {
    this.applied = (await readState(this.opts.worktree)).appliedLsn;
    this.connect();
    const every = this.opts.heartbeatMs ?? 30_000;
    if (every > 0) {
      this.heartbeat = setInterval(() => this.send({ type: "heartbeat", appliedLsn: this.applied }), every);
    }
  }

  close(): void {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
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
        this.log(describe(message));
        this.subscribe();
        break;
      case "entry":
        this.queue.push(message.changeset);
        void this.drain();
        break;
      default:
        this.log(describe(message));
    }
  }

  private subscribe(): void {
    this.queue = [];
    this.send({ type: "subscribe", fromLsn: this.applied });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const changeset = this.queue.shift();
        if (changeset === undefined) return;
        // `pitstop commit` runs in its own process and may have applied its own entry meanwhile.
        const state = await readState(this.opts.worktree);
        if (state.appliedLsn > this.applied) this.applied = state.appliedLsn;
        if (changeset.lsn <= this.applied) continue;
        if (changeset.lsn !== this.applied + 1) {
          this.opts.onGap?.(this.applied + 1, changeset.lsn);
          if (++this.gaps >= GAP_RETRIES) throw new GapError(this.applied + 1, changeset.lsn);
          this.log(`gap: expected #${this.applied + 1}, got #${changeset.lsn}; subscribing again`);
          this.subscribe();
          return;
        }
        // Unfinished work in @ began at or before the current applied LSN: the server must check
        // its reads from there, not from the LSN this entry moves the worktree to.
        const readBaseLsn =
          state.readBaseLsn ?? ((await this.opts.applier.hasChanges()) ? this.applied : undefined);
        const result = await this.opts.applier.apply(changeset);
        this.gaps = 0;
        this.applied = changeset.lsn;
        await writeState(this.opts.worktree, {
          appliedLsn: this.applied,
          ...(readBaseLsn === undefined ? {} : { readBaseLsn }),
        });
        const note = result.conflicted.length === 0 ? "" : ` (conflicts in ${result.conflicted.join(", ")})`;
        this.log(`applied #${changeset.lsn} ${changeset.intent}${note}`);
        this.send({ type: "heartbeat", appliedLsn: this.applied });
        this.opts.onApplied?.(changeset.lsn);
      }
    } catch (err) {
      const what = err instanceof GapError ? "gave up" : "apply failed";
      this.log(`${what}, stopped at #${this.applied}: ${err instanceof Error ? err.message : String(err)}`);
      this.queue = [];
      this.close();
      this.opts.onError?.(err);
    } finally {
      this.draining = false;
    }
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
