/**
 * This worktree's presence (design doc 9.5): the live, Figma-like view of who is working where.
 *
 * Presence is the brain's one CRDT (packages/protocol/src/presence.ts): a last-writer-wins map
 * keyed by replica, one replica per worktree, stamped by a hybrid logical clock. The daemon keeps
 * a copy of its repository's document, merges every `presence` message into it, and writes only
 * its own key:
 *
 * - at connect (on `head`, once the subscription is confirmed), at every safe point, after a
 *   declare and after a commit: the entry is recomputed (state, open intent, files with
 *   unfinished edits, declared symbols, applied LSN);
 * - with every heartbeat, and shortly after entries are applied: the same values, a new stamp
 *   (views hide an entry older than two minutes, so this keeps it alive);
 * - on close: a tombstone (`state: "gone"`).
 *
 * The clock observes every stamp it receives, so a write here orders after everything this
 * worktree has seen. Presence is never used for decisions: an overlap with another replica is a
 * note for the agent, once, never a refusal.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyPresence,
  HybridClock,
  livePresence,
  parseStamp,
  PresenceEntry,
  presenceOverlaps,
  SymbolId,
  type Author,
  type ClientMessage,
  type PresenceDoc,
  type RepoId,
} from "@pitstop/protocol";
import type { Applier } from "./jj.js";
import { stateDir, withWorktreeLock } from "./state.js";

/** `.pitstop/replica`: this worktree's replica id, generated once. `.pitstop/` ignores itself. */
export const REPLICA_FILE = "replica";
/** Views show entries written this recently; the server's PRESENCE_TTL_MS is the same. */
export const PRESENCE_TTL_MS = 2 * 60_000;
/** Unfinished edits are diffed at most this often at safe points, which follow every tool call. */
export const PRESENCE_FILES_MS = 3_000;
/** How long after an apply the keepalive with the new applied LSN goes out (a replay applies many at once). */
export const PRESENCE_BUMP_MS = 250;

const REPLICA = /^[A-Za-z0-9_-]{1,64}$/;
/** The schema's limits on an entry (packages/protocol/src/presence.ts). */
const MAX_LIST = 500;
const MAX_INTENT = 500;

/** This worktree's replica id, `w_` and 8 hex digits, created on first use and stable afterwards. */
export async function replicaId(worktree: string): Promise<string> {
  const path = join(await stateDir(worktree), REPLICA_FILE);
  const read = async () => (await readFile(path, "utf8").catch(() => "")).trim();
  const existing = await read();
  if (REPLICA.test(existing)) return existing;
  const fresh = `w_${randomBytes(4).toString("hex")}`;
  try {
    // `wx`: if another process made one meanwhile, that one stands.
    await writeFile(path, `${fresh}\n`, { flag: "wx" });
    return fresh;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const theirs = await read();
    if (REPLICA.test(theirs)) return theirs;
    await writeFile(path, `${fresh}\n`); // there, but not an id: replaced
    return fresh;
  }
}

/** The open intent as presence shows it. */
export interface PresenceIntent {
  id: string;
  text: string;
  symbols: string[];
}

export interface PresenceOptions {
  worktree: string;
  repo: RepoId;
  author: Author;
  applier: Applier;
  /** Sends a message on the stream; false when the socket is not open (the next write catches up). */
  send: (message: ClientMessage) => boolean;
  appliedLsn: () => number;
  /** The worktree's open intent, if any: from the state file and what the daemon knows of it. */
  intent: () => Promise<PresenceIntent | undefined>;
  now?: () => number;
  ttlMs?: number;
  /** Minimum time between two diffs at safe points; default PRESENCE_FILES_MS. */
  filesMs?: number;
  bumpMs?: number;
  log?: (line: string) => void;
}

/** What `GET /presence` answers: the live entries, each with its age, and which one is this worktree. */
export interface PresenceView {
  replica: string | null;
  ttlMs: number;
  entries: (PresenceEntry & { ageMs: number })[];
}

type Values = Omit<PresenceEntry, "stamp">;

export class Presence {
  private clock: HybridClock | undefined;
  private doc: PresenceDoc = {};
  /** This worktree's entry as last computed; keepalives resend it with a new stamp. */
  private mine: Values | undefined;
  private lastStamp: string | undefined;
  private files: string[] = [];
  private filesAt = Number.NEGATIVE_INFINITY;
  /** Overlaps already told to the agent, `replica\0path-or-symbol`: each once while it lasts. */
  private told = new Set<string>();
  private bumpTimer: NodeJS.Timeout | undefined;
  private left = false;

  constructor(private readonly opts: PresenceOptions) {}

  get replica(): string | undefined {
    return this.clock?.replica;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private get ttl(): number {
    return this.opts.ttlMs ?? PRESENCE_TTL_MS;
  }

  /** Reads (or makes) the replica id; nothing is published before. */
  async start(): Promise<void> {
    this.clock = new HybridClock(await replicaId(this.opts.worktree), () => this.now());
  }

  /** Entries from the server: every stamp moves the clock, every entry is merged. */
  receive(repo: RepoId, entries: PresenceEntry[]): void {
    if (repo !== this.opts.repo || this.clock === undefined) return;
    for (const entry of entries) {
      if (entry.repo !== this.opts.repo) continue;
      this.clock.observe(entry.stamp);
      const before = this.doc[entry.replica];
      this.doc = applyPresence(this.doc, entry);
      if (entry.replica !== this.clock.replica && this.doc[entry.replica] === entry) this.logChange(before, entry);
    }
    // Someone wrote this worktree's key after its own last write (the tombstone a server leaves
    // when an old socket of ours closes late, say): this worktree is still here, so write again.
    // The clock has observed that stamp, so the new write wins.
    const own = this.doc[this.clock.replica];
    if (own !== undefined && this.lastStamp !== undefined && own.stamp > this.lastStamp) this.keepalive();
  }

  /**
   * Recomputes this worktree's entry and publishes it: at connect, at safe points, after a
   * declare and a commit. Unfinished edits are diffed under the worktree lock (never during an
   * apply), and at most every `filesMs` unless `fresh` asks for it now.
   */
  async publish(fresh = false): Promise<PresenceEntry | undefined> {
    if (this.clock === undefined || this.left) return undefined;
    const now = this.now();
    if (fresh || now - this.filesAt >= (this.opts.filesMs ?? PRESENCE_FILES_MS)) {
      this.filesAt = now;
      try {
        const changes = await withWorktreeLock(this.opts.worktree, () => this.opts.applier.diffAgainstMain());
        this.files = [...new Set(changes.map((f) => f.path))].sort();
      } catch (err) {
        this.opts.log?.(`presence: could not list the unfinished edits: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const intent = await this.opts.intent().catch(() => undefined);
    if (this.left) return undefined;
    const text = intent?.text.trim().slice(0, MAX_INTENT) ?? "";
    this.mine = {
      replica: this.clock.replica,
      repo: this.opts.repo,
      author: this.opts.author,
      state: this.files.length > 0 || intent !== undefined ? "working" : "idle",
      ...(intent === undefined ? {} : { intentId: intent.id }),
      ...(text === "" ? {} : { intent: text }),
      files: this.files.slice(0, MAX_LIST),
      symbols: (intent?.symbols ?? []).filter((s) => SymbolId.safeParse(s).success).slice(0, MAX_LIST),
      appliedLsn: this.opts.appliedLsn(),
    };
    return this.write(this.mine);
  }

  /** The keepalive: the values last computed, the current applied LSN, a new stamp. */
  keepalive(): PresenceEntry | undefined {
    if (this.mine === undefined || this.left) return undefined;
    this.mine = { ...this.mine, appliedLsn: this.opts.appliedLsn() };
    return this.write(this.mine);
  }

  /** Entries were applied: a keepalive shortly, one for a whole batch. */
  bump(): void {
    if (this.bumpTimer !== undefined || this.left) return;
    this.bumpTimer = setTimeout(() => {
      this.bumpTimer = undefined;
      this.keepalive();
    }, this.opts.bumpMs ?? PRESENCE_BUMP_MS);
    this.bumpTimer.unref();
  }

  /** The tombstone: this worktree leaves. Nothing more is published afterwards. */
  leave(): PresenceEntry | undefined {
    if (this.bumpTimer !== undefined) clearTimeout(this.bumpTimer);
    this.bumpTimer = undefined;
    if (this.left) return undefined;
    const mine = this.mine;
    if (mine === undefined) {
      this.left = true;
      return undefined;
    }
    const { intent: _intent, intentId: _intentId, ...rest } = mine;
    const tombstone = this.write({ ...rest, state: "gone", files: [], symbols: [], appliedLsn: this.opts.appliedLsn() });
    this.left = true;
    return tombstone;
  }

  /** The live entries, this worktree's included, with their age. */
  view(): PresenceView {
    const now = this.now();
    return {
      replica: this.clock?.replica ?? null,
      ttlMs: this.ttl,
      entries: livePresence(this.doc, now, this.ttl).map((e) => ({ ...e, ageMs: Math.max(0, now - parseStamp(e.stamp).wall) })),
    };
  }

  /**
   * Notes for the agent at a safe point: other live replicas in the files or symbols this
   * worktree's entry names. Each overlap once, while it lasts; one that ends and comes back is
   * told again.
   */
  overlapNotes(): string[] {
    if (this.clock === undefined || this.mine === undefined) return [];
    const overlaps = presenceOverlaps(this.doc, this.clock.replica, this.mine.files, this.mine.symbols, this.now(), this.ttl);
    const current = new Set<string>();
    const notes: string[] = [];
    for (const { entry, files, symbols } of overlaps) {
      const key = (item: string) => `${entry.replica}\0${item}`;
      for (const item of [...files, ...symbols]) current.add(key(item));
      const newFiles = files.filter((f) => !this.told.has(key(f)));
      const newSymbols = symbols.filter((s) => !this.told.has(key(s)));
      if (newFiles.length === 0 && newSymbols.length === 0) continue;
      const doing = [
        newFiles.length > 0 ? `editing ${newFiles.join(", ")}` : "",
        newSymbols.length > 0 ? `changing ${newSymbols.join(", ")}` : "",
      ].filter((s) => s !== "");
      const why = entry.intent === undefined ? "" : `, for '${entry.intent}'`;
      notes.push(`${entry.author.agent} (${entry.author.developer}) is also ${doing.join(" and ")}${why}`);
    }
    this.told = current;
    return notes;
  }

  /** Stamps, checks against the schema (an invalid message would cost the socket), merges locally, sends. */
  private write(values: Values): PresenceEntry | undefined {
    if (this.clock === undefined) return undefined;
    const parsed = PresenceEntry.safeParse({ ...values, stamp: this.clock.tick() });
    if (!parsed.success) {
      this.opts.log?.(`presence: not sent, the entry does not fit the protocol: ${parsed.error.issues[0]?.message ?? "invalid"}`);
      return undefined;
    }
    const entry = parsed.data;
    this.doc = applyPresence(this.doc, entry);
    this.lastStamp = entry.stamp;
    this.opts.send({ type: "presence", entry });
    return entry;
  }

  /** One log line when another replica arrives, changes state or task, or leaves: not for every keepalive. */
  private logChange(before: PresenceEntry | undefined, after: PresenceEntry): void {
    if (before !== undefined && before.state === after.state && before.intentId === after.intentId) return;
    const who = `${after.author.agent} (${after.author.developer})`;
    if (after.state === "gone") {
      if (before !== undefined && before.state !== "gone") this.opts.log?.(`presence: ${who} left`);
      return;
    }
    const task = after.intent === undefined ? "" : `: ${after.intent}`;
    this.opts.log?.(`presence: ${who} is ${after.state}${task}`);
  }
}
