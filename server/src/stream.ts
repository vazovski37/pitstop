import type { FastifyBaseLogger } from "fastify";
import type { RawData, WebSocket } from "ws";
import { ClientMessage, type Lsn, type ServerMessage } from "@pitstop/protocol";
import type { Store } from "./store.js";

/** Entries read from the store per delivery round. */
const PAGE = 200;

interface Subscriber {
  socket: WebSocket;
  /** Set by `subscribe`; null until then, so nothing is delivered. */
  lastSentLsn: Lsn | null;
  /** From heartbeats; the live view shows it against the head. */
  appliedLsn: Lsn | null;
  /** One delivery at a time per socket, so entries never interleave. */
  sending: Promise<void>;
}

/**
 * The WebSocket side of the log (design doc section 8.2).
 *
 * Replay and live push are one path: a delivery sends everything after the socket's
 * `lastSentLsn` from the store, in LSN order. `subscribe` starts it; every append
 * triggers it again. So a socket never sees a gap or a duplicate, and a late
 * subscriber catches up from exactly where it left off.
 *
 * Subscribers live in this process, which is why the Container App runs one replica.
 */
export class Stream {
  private readonly subs = new Set<Subscriber>();

  constructor(
    private readonly store: Store,
    private readonly version: string,
    private readonly log?: FastifyBaseLogger,
  ) {}

  /** Wires a new connection: `hello` first, then whatever the daemon asks for. */
  connect(socket: WebSocket): void {
    const sub: Subscriber = { socket, lastSentLsn: null, appliedLsn: null, sending: Promise.resolve() };
    this.subs.add(sub);
    socket.on("close", () => this.subs.delete(sub));
    socket.on("error", (err) => this.log?.warn({ err }, "stream socket error"));
    socket.on("message", (raw) => void this.onMessage(sub, raw));
    sub.sending = this.store
      .headLsn()
      .then((headLsn) => this.send(sub, { type: "hello", serverVersion: this.version, headLsn }))
      .catch((err) => this.fail(sub, err));
  }

  /** Called after every append: each subscribed socket gets what it has not seen yet. */
  notify(): void {
    for (const sub of this.subs) this.deliver(sub);
  }

  /** Pushes a message that is not a log entry (`intent`, `warning`) to every socket. */
  broadcast(message: ServerMessage): void {
    for (const sub of this.subs) this.send(sub, message);
  }

  /** Applied LSN of every connected worktree that reported one. */
  worktrees(): Lsn[] {
    return [...this.subs].flatMap((s) => (s.appliedLsn === null ? [] : [s.appliedLsn]));
  }

  private async onMessage(sub: Subscriber, raw: RawData): Promise<void> {
    const parsed = ClientMessage.safeParse(tryJson(raw.toString()));
    if (!parsed.success) {
      sub.socket.close(1003, "expected a ClientMessage");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "subscribe":
        sub.lastSentLsn = message.fromLsn;
        this.deliver(sub);
        break;
      case "heartbeat":
        if (message.appliedLsn !== undefined) sub.appliedLsn = message.appliedLsn;
        if (message.intentId !== undefined) await this.store.heartbeat(message.intentId);
        break;
    }
  }

  private deliver(sub: Subscriber): void {
    sub.sending = sub.sending
      .then(async () => {
        for (;;) {
          if (sub.lastSentLsn === null || sub.socket.readyState !== sub.socket.OPEN) return;
          const batch = await this.store.entriesAfter(sub.lastSentLsn, PAGE);
          for (const changeset of batch) {
            this.send(sub, { type: "entry", changeset });
            sub.lastSentLsn = changeset.lsn;
          }
          if (batch.length < PAGE) return;
        }
      })
      .catch((err) => this.fail(sub, err));
  }

  private send(sub: Subscriber, message: ServerMessage): void {
    if (sub.socket.readyState === sub.socket.OPEN) sub.socket.send(JSON.stringify(message));
  }

  private fail(sub: Subscriber, err: unknown): void {
    this.log?.error({ err }, "stream delivery failed");
    sub.socket.close(1011, "delivery failed");
  }
}

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
