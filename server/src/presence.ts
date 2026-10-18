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

/** Why an entry is refused before it reaches the merge, or undefined when it may be merged. */
export function refusal(entry: PresenceEntry, now: number): string | undefined {
  const stamp = parseStamp(entry.stamp);
  if (stamp.replica !== entry.replica) return "the stamp names another replica";
  if (stamp.wall > now + PRESENCE_MAX_SKEW_MS) return "the stamp is from the future";
  if (JSON.stringify(entry).length > PRESENCE_MAX_BYTES) return "the entry is too large";
  return undefined;
}

export class PresenceDocs {
  private readonly docs = new Map<RepoId, PresenceDoc>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = PRESENCE_MAX_ENTRIES,
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
  apply(entry: PresenceEntry): boolean {
    const now = this.now();
    if (refusal(entry, now) !== undefined) return false;
    const before = this.docs.get(entry.repo) ?? {};
    const after = applyPresence(before, entry);
    if (after === before) return false;
    this.docs.set(entry.repo, this.trim(after, now));
    return this.docs.get(entry.repo)?.[entry.replica] === entry;
  }

  /**
   * Forgets entries older than PRESENCE_RETAIN_MS, then keeps the document under its cap. Dropping
   * a key is not part of the CRDT, but only keys whose last write faded from every view long ago
   * (or the oldest, when a repository has more replicas than the cap) are dropped, so a late copy
   * of one could only come back as an entry the views already hide.
   */
  private trim(doc: PresenceDoc, now: number): PresenceDoc {
    const wall = (e: PresenceEntry) => parseStamp(e.stamp).wall;
    let entries = Object.values(doc).filter((e) => now - wall(e) <= PRESENCE_RETAIN_MS);
    if (entries.length > this.maxEntries) {
      // Tombstones first, oldest first; then live entries, oldest first.
      const order = [...entries].sort((a, b) => Number(b.state === "gone") - Number(a.state === "gone") || (a.stamp < b.stamp ? -1 : 1));
      const drop = new Set(order.slice(0, entries.length - this.maxEntries).map((e) => e.replica));
      entries = entries.filter((e) => !drop.has(e.replica));
    }
    if (entries.length === Object.keys(doc).length) return doc;
    return Object.fromEntries(entries.map((e) => [e.replica, e]));
  }
}
