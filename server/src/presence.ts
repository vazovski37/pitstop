import {
  applyPresence,
  parseStamp,
  stampOf,
  type PresenceDoc,
  type PresenceEntry,
  type PresenceStamp,
  type RepoId,
} from "@pitstop/protocol";

/**
 * The server's copy of each repository's presence document (design doc 9.5; the CRDT itself is
 * `packages/protocol/src/presence.ts`). In memory, like the stream's subscribers: presence is
 * never used for decisions, so losing it on a restart costs a few seconds until every daemon's
 * next keepalive. The server is one replica among many here; it merges with the same
 * `applyPresence` the daemons and the page run, so all of them converge.
 */

/** At most this many entries per repository; the oldest tombstones go first, then the oldest entries. */
export const PRESENCE_MAX_ENTRIES = 500;
/** At most this much JSON per repository, all entries together: every new subscriber receives the whole document. */
export const PRESENCE_MAX_DOC_BYTES = 1024 * 1024;
/** Views show entries written this recently (daemons refresh theirs with every heartbeat). */
export const PRESENCE_TTL_MS = 2 * 60_000;
/** Entries older than this are forgotten: they faded from every view long ago. */
export const PRESENCE_RETAIN_MS = 60 * 60_000;
/** A stamp further ahead of this server's clock is refused: it would never fade from the views. */
export const PRESENCE_MAX_SKEW_MS = 60_000;
/** An entry larger than this (as JSON) is refused: every subscriber receives the whole document. */
export const PRESENCE_MAX_BYTES = 64 * 1024;

const COUNTER_MAX = 999_999;

/** The stamp right after `stamp` on the same replica's clock: same wall time, counter + 1. */
export function nextStamp(stamp: PresenceStamp): PresenceStamp {
  const { wall, counter, replica } = parseStamp(stamp);
  return counter >= COUNTER_MAX ? stampOf(wall + 1, 0, replica) : stampOf(wall, counter + 1, replica);
}

/** Each entry's size as JSON, measured once (an entry is immutable once merged). */
const sizes = new WeakMap<PresenceEntry, number>();
const sizeOf = (entry: PresenceEntry): number => {
  let size = sizes.get(entry);
  if (size === undefined) {
    size = JSON.stringify(entry).length;
    sizes.set(entry, size);
  }
  return size;
};

/** Why an entry is refused before it reaches the merge, or undefined when it may be merged. */
export function refusal(entry: PresenceEntry, now: number): string | undefined {
  const stamp = parseStamp(entry.stamp);
  if (stamp.replica !== entry.replica) return "the stamp names another replica";
  if (stamp.wall > now + PRESENCE_MAX_SKEW_MS) return "the stamp is from the future";
  if (sizeOf(entry) > PRESENCE_MAX_BYTES) return "the entry is too large";
  return undefined;
}

/** What `offer` did with an entry: merged and changed the document, changed nothing, or refused it (and why). */
export type Offered = { changed: true } | { changed: false; refused?: string };

export class PresenceDocs {
  private readonly docs = new Map<RepoId, PresenceDoc>();
  /** Who wrote each replica last (a user's login, or "shared"): another writer may not take it over while it is live. */
  private readonly writers = new Map<RepoId, Map<string, string>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = PRESENCE_MAX_ENTRIES,
    private readonly maxDocBytes = PRESENCE_MAX_DOC_BYTES,
  ) {}

  /** Every entry of a repository's document, tombstones included (what a new subscriber merges). */
  entries(repo: RepoId): PresenceEntry[] {
    return Object.values(this.docs.get(repo) ?? {});
  }

  /** The current entry of one replica, if the document has it. */
  get(repo: RepoId, replica: string): PresenceEntry | undefined {
    return this.docs.get(repo)?.[replica];
  }

  /**
   * Merges one entry into its repository's document. True when the document changed, so the
   * entry should be passed on; false for a stale, duplicate or refused one.
   */
  apply(entry: PresenceEntry, writer?: string): boolean {
    return this.offer(entry, writer).changed;
  }

  /**
   * `apply`, saying why an entry was refused. `writer` is who sent it (a user's login, or
   * "shared" for the shared token): a replica is bound to the writer who last wrote it, and
   * another writer's entry for it is refused while that replica is live (not departed, written
   * within the TTL), so nobody can overwrite or tombstone a worktree that is still working. The
   * server's own tombstones pass no writer.
   */
  offer(entry: PresenceEntry, writer?: string): Offered {
    const now = this.now();
    const refused = refusal(entry, now) ?? (writer === undefined ? undefined : this.takenBy(entry, writer, now));
    if (refused !== undefined) return { changed: false, refused };
    const before = this.docs.get(entry.repo) ?? {};
    const after = applyPresence(before, entry);
    if (after === before) return { changed: false };
    const kept = this.trim(after, now);
    this.docs.set(entry.repo, kept);
    const writers = this.writers.get(entry.repo) ?? new Map<string, string>();
    this.writers.set(entry.repo, writers);
    if (kept !== after) for (const replica of writers.keys()) if (kept[replica] === undefined) writers.delete(replica);
    if (kept[entry.replica] !== entry) return { changed: false };
    if (writer !== undefined) writers.set(entry.replica, writer);
    return { changed: true };
  }

  /** Why `writer` may not write this replica now: another writer holds it and it is live. */
  private takenBy(entry: PresenceEntry, writer: string, now: number): string | undefined {
    const holder = this.writers.get(entry.repo)?.get(entry.replica);
    if (holder === undefined || holder === writer) return undefined;
    const current = this.get(entry.repo, entry.replica);
    if (current === undefined || current.state === "gone" || now - parseStamp(current.stamp).wall > PRESENCE_TTL_MS) return undefined;
    return "another writer holds this replica while it is live";
  }

  /**
   * Forgets entries older than PRESENCE_RETAIN_MS, then keeps the document under its caps (entries
   * and bytes). Dropping a key is not part of the CRDT, but only keys whose last write faded from
   * every view long ago (or the oldest, when a repository has more than the caps allow) are
   * dropped, so a late copy of one could only come back as an entry the views already hide.
   */
  private trim(doc: PresenceDoc, now: number): PresenceDoc {
    const wall = (e: PresenceEntry) => parseStamp(e.stamp).wall;
    let entries = Object.values(doc).filter((e) => now - wall(e) <= PRESENCE_RETAIN_MS);
    let bytes = entries.reduce((sum, e) => sum + sizeOf(e), 0);
    if (entries.length > this.maxEntries || bytes > this.maxDocBytes) {
      // Tombstones first, oldest first; then live entries, oldest first.
      const order = [...entries].sort((a, b) => Number(b.state === "gone") - Number(a.state === "gone") || (a.stamp < b.stamp ? -1 : 1));
      const drop = new Set<string>();
      let count = entries.length;
      for (const e of order) {
        if (count <= this.maxEntries && bytes <= this.maxDocBytes) break;
        drop.add(e.replica);
        count -= 1;
        bytes -= sizeOf(e);
      }
      entries = entries.filter((e) => !drop.has(e.replica));
    }
    if (entries.length === Object.keys(doc).length) return doc;
    return Object.fromEntries(entries.map((e) => [e.replica, e]));
  }
}
