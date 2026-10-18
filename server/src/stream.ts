import type { FastifyBaseLogger } from "fastify";
import type { RawData, WebSocket } from "ws";
import { ClientMessage, DEFAULT_REPO, type Lsn, type PresenceEntry, type RepoId, type ServerMessage } from "@pitstop/protocol";
import { nextStamp, PresenceDocs } from "./presence.js";
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
  /** Asked again before every delivery: a member removed, a repository made private or a token revoked cuts the socket off. */
  canRead: (repo: RepoId) => Promise<boolean>;
  /** Messages from the socket are handled one at a time, in order: a `presence` right after `subscribe` finds the repository set. */
  handling: Promise<void>;
  /** The signed-in user's login, when the socket stands for one: the `author.developer` of its presence. */
  developer: string | undefined;
  /** The replicas this socket wrote presence for, with the repository and the stamp of its last write: tombstoned when it closes. */
  published: Map<string, { repo: RepoId; stamp: string }>;
}

/** What `connect` knows about the caller besides what it may read. */
export interface ConnectOptions {
  /**
   * The login of the user the socket stands for (a personal token or a session): presence from
   * it is written as that developer, whatever the entry says, as commits are (app.ts).
   */
  developer?: string | undefined;
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
    /** Each repository's presence document (presence.ts), in this process like the subscribers. */
    readonly presence: PresenceDocs = new PresenceDocs(),
  ) {}

  /**
   * Wires a new connection: `hello` first (with the default repository's head), then whatever the
   * daemon asks for. `canRead` decides which repositories this socket may follow (auth.ts);
   * `options.developer` names the signed-in user behind it, if any.
   */
  connect(socket: WebSocket, canRead: (repo: RepoId) => Promise<boolean> = async () => true, options: ConnectOptions = {}): void {
    const sub: Subscriber = {
      socket,
      repo: null,
      lastSentLsn: null,
      appliedLsn: null,
      intentId: null,
      sending: Promise.resolve(),
      canRead,
      handling: Promise.resolve(),
      developer: options.developer,
      published: new Map(),
    };
    this.subs.add(sub);
    socket.on("close", () => {
      this.subs.delete(sub);
      this.leave(sub);
    });
    socket.on("error", (err) => this.log?.warn({ err }, "stream socket error"));
    socket.on("message", (raw) => {
      sub.handling = sub.handling.then(() => this.onMessage(sub, raw, canRead)).catch((err) => this.log?.warn({ err }, "stream message failed"));
    });
    // hello carries the default repository's head only for a socket that may read it; the head
    // that matters comes with `head` after subscribe.
    sub.sending = canRead(DEFAULT_REPO)
      .then(async (readable) => this.send(sub, { type: "hello", serverVersion: this.version, headLsn: readable ? await this.store.headLsn(DEFAULT_REPO) : 0 }))
      .catch((err) => this.fail(sub, err));
  }

  /** Whether the socket may still read its repository; closes it when not. */
  private async stillReads(sub: Subscriber): Promise<boolean> {
    if (sub.repo === null) return false;
    if (await sub.canRead(sub.repo)) return true;
    sub.socket.close(1008, `no read access to ${sub.repo}`);
    return false;
  }

  /** Called after every append to `repo`: each of its subscribed sockets gets what it has not seen yet. */
  notify(repo: RepoId): void {
    for (const sub of this.subs) if (sub.repo === repo) this.deliver(sub);
  }

  /** Pushes a message that is not a log entry (`intent`, `warning`) to every socket following `repo`. */
  broadcast(repo: RepoId, message: ServerMessage): void {
    for (const sub of this.subs) {
      if (sub.repo !== repo) continue;
      // In order with the entries, and only while the socket may still read the repository.
      sub.sending = sub.sending
        .then(async () => {
          if (await this.stillReads(sub)) this.send(sub, message);
        })
        .catch((err) => this.fail(sub, err));
    }
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
            // Then the whole presence document, tombstones included, for the subscriber to merge.
            const present = this.presence.entries(repo);
            if (present.length > 0) this.send(sub, { type: "presence", repo, entries: present });
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
        // Only for the repository this socket follows: an id from elsewhere refreshes nothing.
        if (message.intentId !== undefined && sub.repo !== null) await this.store.heartbeat(sub.repo, message.intentId);
        break;
      case "presence":
        await this.onPresence(sub, message.entry);
        break;
    }
  }

  /**
   * A worktree's presence (design doc 9.5): merged into its repository's document and, when that
   * changed the document, passed on to every socket following the repository, the sender
   * included. Only for the repository this socket follows, and only while it may read it; a
   * signed-in user's entries carry their login as the developer. A stale or duplicate entry
   * changes nothing and goes nowhere.
   */
  private async onPresence(sub: Subscriber, sent: PresenceEntry): Promise<void> {
    if (sub.repo === null || sent.repo !== sub.repo) return;
    if (!(await this.stillReads(sub))) return;
    const entry = sub.developer === undefined ? sent : { ...sent, author: { ...sent.author, developer: sub.developer } };
    if (!this.presence.apply(entry)) return;
    sub.published.set(entry.replica, { repo: entry.repo, stamp: entry.stamp });
    this.broadcast(entry.repo, { type: "presence", repo: entry.repo, entries: [entry] });
  }

  /**
   * A socket that wrote presence closed: each replica it wrote leaves at once, through a tombstone
   * stamped just after that replica's last stamp, instead of fading out after the TTL. A replica
   * someone wrote since (the same daemon, reconnected on a new socket) is not leaving and is left
   * alone; a later write from the replica itself carries a newer clock and wins over the tombstone.
   */
  private leave(sub: Subscriber): void {
    for (const [replica, { repo, stamp }] of sub.published) {
      const current = this.presence.get(repo, replica);
      if (current === undefined || current.stamp !== stamp || current.state === "gone") continue;
      const { intent: _intent, intentId: _intentId, ...rest } = current;
      const tombstone: PresenceEntry = { ...rest, state: "gone", files: [], symbols: [], stamp: nextStamp(current.stamp) };
      if (this.presence.apply(tombstone)) this.broadcast(repo, { type: "presence", repo, entries: [tombstone] });
    }
  }

  private deliver(sub: Subscriber): void {
    sub.sending = sub.sending
      .then(async () => {
        for (;;) {
          if (sub.repo === null || sub.lastSentLsn === null || sub.socket.readyState !== sub.socket.OPEN) return;
          if (!(await this.stillReads(sub))) return;
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
