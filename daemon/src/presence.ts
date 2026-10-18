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
 * A safe-point publish whose values did not change sends nothing (the heartbeat keeps the entry
 * alive), and the daemon does not wait for it: the hook never waits on jj and git for presence.
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
  canonicalPresence,
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
export const PRESENCE_FILES_MS = 5_000;
/** How long after an apply the keepalive with the new applied LSN goes out (a replay applies many at once). */
export const PRESENCE_BUMP_MS = 250;
/** A safe point with nothing new still writes once this long has passed since the last write (the heartbeat's default period). */
export const PRESENCE_REFRESH_MS = 30_000;
/** At most one rewrite of this worktree's entry over someone else's write of it in this long. */
export const PRESENCE_REWRITE_MS = 5_000;
/** At most this many entries in this copy of the document (the server keeps as many); the oldest tombstones go first. */
export const PRESENCE_MAX_ENTRIES = 500;
/** Files and symbols named per overlap note; the rest is counted, and the `who` tool lists them all. */
const NOTE_ITEMS = 5;

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
  /** A publish with unchanged values writes nothing until this long after the last write; default PRESENCE_REFRESH_MS. */
  refreshMs?: number;
  /** Minimum time between two rewrites over someone else's write of this worktree's key; default PRESENCE_REWRITE_MS. */
  rewriteMs?: number;
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
  /** This worktree's last write, canonical: a write by a twin with the same stamp shows as a different text. */
  private lastWritten: string | undefined;
  private lastWriteAt = Number.NEGATIVE_INFINITY;
  private lastRewriteAt = Number.NEGATIVE_INFINITY;
  /** Another process writes this worktree's key (a copied checkout): said once in the log. */
  private twinWarned = false;
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
    this.prune();
    // Someone wrote this worktree's key after its own last write. A tombstone (the server's, when
    // an old socket of ours closes late) is wrong while this worktree is here, so it writes again;
    // the clock has observed that stamp, so the new write wins. A live entry means another
    // process shares this replica id (a copied checkout, two daemons): answering it would start
    // an endless exchange of rewrites, so it is said once and left to the keepalives.
    const own = this.doc[this.clock.replica];
    if (own === undefined || this.lastStamp === undefined) return;
    // Newer than its own last write, or as new but not what it wrote (a twin in the same millisecond).
    const clobbered = own.stamp > this.lastStamp || (own.stamp === this.lastStamp && canonicalPresence(own) !== this.lastWritten);
    if (!clobbered) return;
    if (own.state !== "gone") {
      if (!this.twinWarned) {
        this.twinWarned = true;
        this.opts.log?.(
          `presence: another process writes this worktree's replica id ${this.clock.replica} (a copied checkout? delete .pitstop/replica in the copy)`,
        );
      }
      return;
    }
    const now = this.now();
    if (now - this.lastRewriteAt < (this.opts.rewriteMs ?? PRESENCE_REWRITE_MS)) return; // the next keepalive heals it
    this.lastRewriteAt = now;
    this.keepalive();
  }

  /**
   * The unfinished edits as the daemon's own safe-point notes just listed them: the next publish
   * uses them instead of diffing again.
   */
  setFiles(paths: Iterable<string>): void {
    this.files = [...new Set(paths)].sort();
    this.filesAt = this.now();
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
        const { applier } = this.opts;
        // Paths only when the applier can (no file contents read just to be dropped).
        const paths = await withWorktreeLock(this.opts.worktree, async () =>
          applier.changedPaths !== undefined ? applier.changedPaths() : (await applier.diffAgainstMain()).map((f) => f.path),
        );
        this.files = [...new Set(paths)].sort();
      } catch (err) {
        this.opts.log?.(`presence: could not list the unfinished edits: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const intent = await this.opts.intent().catch(() => undefined);
    if (this.left) return undefined;
    const text = intent?.text.trim().slice(0, MAX_INTENT) ?? "";
    const values: Values = {
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
    // Nothing new since the last write, which is recent: the heartbeat keeps the entry alive, so
    // a safe point (one per tool call) sends nothing. A fresh publish (connect, declare, commit) always goes.
    const unchanged = this.mine !== undefined && sameValues(this.mine, values);
    this.mine = values;
    if (!fresh && unchanged && this.now() - this.lastWriteAt < (this.opts.refreshMs ?? PRESENCE_REFRESH_MS)) return undefined;
    return this.write(values);
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
        newFiles.length > 0 ? `editing ${some(newFiles)}` : "",
        newSymbols.length > 0 ? `changing ${some(newSymbols)}` : "",
      ].filter((s) => s !== "");
      const why = entry.intent === undefined ? "" : `, for '${entry.intent}'`;
      const more = newFiles.length > NOTE_ITEMS || newSymbols.length > NOTE_ITEMS ? " (call who for the full list)" : "";
      notes.push(`${entry.author.agent} (${entry.author.developer}) is also ${doing.join(" and ")}${why}${more}`);
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
    this.lastWritten = canonicalPresence(entry);
    this.lastWriteAt = this.now();
    try {
      // Callers fire and forget (heartbeats, `head`): a socket that fails mid-send must not take the daemon down.
      this.opts.send({ type: "presence", entry });
    } catch (err) {
      this.opts.log?.(`presence: not sent: ${err instanceof Error ? err.message : String(err)}`);
    }
    return entry;
  }

  /**
   * Keeps this copy of the document under PRESENCE_MAX_ENTRIES, as the server keeps its own:
   * tombstones first, then the oldest entries, never this worktree's. Only a flood of replicas
   * gets here; dropping a key is outside the CRDT, but views hide such entries soon anyway.
   */
  private prune(): void {
    const all = Object.values(this.doc);
    if (all.length <= PRESENCE_MAX_ENTRIES) return;
    const own = this.clock?.replica;
    const order = all
      .filter((e) => e.replica !== own)
      .sort((a, b) => Number(b.state === "gone") - Number(a.state === "gone") || (a.stamp < b.stamp ? -1 : 1));
    const drop = new Set(order.slice(0, all.length - PRESENCE_MAX_ENTRIES).map((e) => e.replica));
    this.doc = Object.fromEntries(all.filter((e) => !drop.has(e.replica)).map((e) => [e.replica, e]));
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

/** Whether two computed entries say the same (the stamp aside). */
function sameValues(a: Values, b: Values): boolean {
  const list = (xs: string[], ys: string[]) => xs.length === ys.length && xs.every((x, i) => x === ys[i]);
  return (
    a.state === b.state &&
    a.intentId === b.intentId &&
    a.intent === b.intent &&
    a.appliedLsn === b.appliedLsn &&
    a.author.agent === b.author.agent &&
    a.author.developer === b.author.developer &&
    list(a.files, b.files) &&
    list(a.symbols, b.symbols)
  );
}

/** A list for a note: the first few, then how many more. */
function some(items: string[]): string {
  return items.length <= NOTE_ITEMS ? items.join(", ") : `${items.slice(0, NOTE_ITEMS).join(", ")} and ${items.length - NOTE_ITEMS} more`;
}
