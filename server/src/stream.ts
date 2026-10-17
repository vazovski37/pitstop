import type { FastifyBaseLogger } from "fastify";
import type { RawData, WebSocket } from "ws";
import { ClientMessage, DEFAULT_REPO, type Lsn, type RepoId, type ServerMessage } from "@pitstop/protocol";
import type { Store } from "./store.js";

/** Entries read from the store per delivery round. */
const PAGE = 200;

interface Subscriber {
  socket: WebSocket;
  /** Set by `subscribe`; a socket follows one repository. */
  repo: RepoId | null;
  /** Set by `subscribe`; null until then, so nothing is delivered. */
  lastSentLsn: Lsn | null;
  /** From heartbeats; the live view shows it against the head. */
  appliedLsn: Lsn | null;
  /** The open intent the last heartbeat named, if it named one: how the live view puts a name on the worktree. */
  intentId: string | null;
  /** One delivery at a time per socket, so entries never interleave. */
  sending: Promise<void>;
}

/**
 * What a connected worktree has told the server about itself through heartbeats. Answered by
 * `GET /repos/:owner/:name/worktrees` (app.ts), where the open intent adds the agent's name. A
 * server query, not a server↔daemon message, so its shape lives here and not in the protocol.
 */
export interface Worktree {
  appliedLsn: Lsn;
  intentId?: string;
}

/**
 * The WebSocket side of the log (design doc section 8.2).
 *
 * Replay and live push are one path: a delivery sends everything after the socket's
 * `lastSentLsn` from its repository's log, in LSN order. `subscribe` starts it; every append to
 * that repository triggers it again. So a socket never sees a gap or a duplicate, and a late
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

  /**
   * Wires a new connection: `hello` first (with the default repository's head), then whatever the
   * daemon asks for. `canRead` decides which repositories this socket may follow (auth.ts).
   */
  connect(socket: WebSocket, canRead: (repo: RepoId) => Promise<boolean> = async () => true): void {
    const sub: Subscriber = { socket, repo: null, lastSentLsn: null, appliedLsn: null, intentId: null, sending: Promise.resolve() };
    this.subs.add(sub);
    socket.on("close", () => this.subs.delete(sub));
    socket.on("error", (err) => this.log?.warn({ err }, "stream socket error"));
    socket.on("message", (raw) => void this.onMessage(sub, raw, canRead));
    sub.sending = this.store
      .headLsn(DEFAULT_REPO)
      .then((headLsn) => this.send(sub, { type: "hello", serverVersion: this.version, headLsn }))
      .catch((err) => this.fail(sub, err));
  }

  /** Called after every append to `repo`: each of its subscribed sockets gets what it has not seen yet. */
  notify(repo: RepoId): void {
    for (const sub of this.subs) if (sub.repo === repo) this.deliver(sub);
  }

  /** Pushes a message that is not a log entry (`intent`, `warning`) to every socket following `repo`. */
  broadcast(repo: RepoId, message: ServerMessage): void {
    for (const sub of this.subs) if (sub.repo === repo) this.send(sub, message);
  }

  /**
   * Every connected worktree of `repo` that has reported an applied LSN, in connection order. A
   * socket that never heartbeats (the live view itself) is not a worktree and is left out.
   */
  worktrees(repo: RepoId): Worktree[] {
    return [...this.subs].flatMap((s) =>
      s.repo === repo && s.appliedLsn !== null ? [{ appliedLsn: s.appliedLsn, ...(s.intentId === null ? {} : { intentId: s.intentId }) }] : [],
    );
  }

  private async onMessage(sub: Subscriber, raw: RawData, canRead: (repo: RepoId) => Promise<boolean>): Promise<void> {
    const parsed = ClientMessage.safeParse(tryJson(raw.toString()));
    if (!parsed.success) {
      sub.socket.close(1003, "expected a ClientMessage");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "subscribe": {
        const repo = message.repo ?? DEFAULT_REPO;
        if ((await this.store.getRepo(repo)) === undefined) {
          sub.socket.close(1008, `unknown repo ${repo}: POST /repos first`);
          return;
        }
        if (!(await canRead(repo))) {
          sub.socket.close(1008, `no read access to ${repo}`);
          return;
        }
        sub.repo = repo;
        // `head` first, so the daemon knows where the log stands before the entries arrive; then the
        // open intents, so a subscriber that arrives late (the live view, a restarted daemon) sees them.
        sub.sending = sub.sending
          .then(async () => {
            this.send(sub, { type: "head", repo, headLsn: await this.store.headLsn(repo) });
            for (const intent of await this.store.openIntents(repo)) this.send(sub, { type: "intent", intent });
          })
          .catch((err) => this.fail(sub, err));
        sub.lastSentLsn = message.fromLsn;
        this.deliver(sub);
        break;
      }
      case "heartbeat":
        if (message.appliedLsn !== undefined) sub.appliedLsn = message.appliedLsn;
        // The daemon names its open intent on every heartbeat while it has one, so a heartbeat
        // without one means the task is over: the worktree loses its name until the next intent.
        sub.intentId = message.intentId ?? null;
        if (message.intentId !== undefined) await this.store.heartbeat(message.intentId);
        break;
    }
  }

  private deliver(sub: Subscriber): void {
    sub.sending = sub.sending
      .then(async () => {
        for (;;) {
          if (sub.repo === null || sub.lastSentLsn === null || sub.socket.readyState !== sub.socket.OPEN) return;
          const batch = await this.store.entriesAfter(sub.repo, sub.lastSentLsn, PAGE);
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
