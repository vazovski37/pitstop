/**
 * Presence (design doc 9.5): which agents are working, on what, in which files and symbols.
 *
 * It is the one part of the brain where merging concurrent writes is the right behaviour: nobody
 * needs a winner, and it is never used for decisions (the server's tables are). So it is a
 * state-based CRDT, a last-writer-wins map:
 *
 * - The key is a replica, one per worktree. Each replica writes only its own key.
 * - Every write carries a hybrid logical clock stamp (`HybridClock`): wall time, then a counter,
 *   then the replica id. Stamps from one replica only ever grow, and two stamps never tie.
 * - `mergePresence` keeps, per key, the entry with the greater stamp. That makes merge
 *   commutative, associative and idempotent (a join), so the server, every daemon and every
 *   browser converge on the same document whatever order the updates arrive in, and an update
 *   delivered twice changes nothing.
 * - A replica that leaves writes a tombstone (`state: "gone"`) instead of deleting its key, so a
 *   late, older update cannot bring it back.
 *
 * The server holds one document per repository, merges what daemons send (`ClientMessage`
 * `presence`) and sends the merged entries on (`ServerMessage` `presence`); a socket that
 * subscribes gets the whole document first.
 */
import { z } from "zod";

const RepoIdShape = z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/);
const SymbolIdShape = z.string().regex(/^[^#]+#.+$/);

/**
 * A hybrid logical clock stamp, `<wall ms, 15 digits>.<counter, 6 digits>.<replica>`, so string
 * order is clock order: compare two stamps with `<`.
 */
export const PresenceStamp = z.string().regex(/^\d{15}\.\d{6}\..+$/, "expected <wall>.<counter>.<replica>");
export type PresenceStamp = z.infer<typeof PresenceStamp>;

export const PresenceEntry = z.object({
  /** One per worktree: stable for a checkout, unique across the repository's checkouts. */
  replica: z.string().min(1).max(200),
  repo: RepoIdShape,
  author: z.object({ developer: z.string().min(1), agent: z.string().min(1) }),
  /** `working`: unfinished edits or an open intent; `idle`: connected, nothing in flight; `gone`: left (a tombstone). */
  state: z.enum(["working", "idle", "gone"]),
  /** The open intent's text and id, when there is one. */
  intent: z.string().max(500).optional(),
  intentId: z.string().optional(),
  /** Files with unfinished edits in the worktree (repository-relative, posix). */
  files: z.array(z.string()).max(500).default([]),
  /** Symbols the agent declared or is changing. */
  symbols: z.array(SymbolIdShape).max(500).default([]),
  /** The last log entry the worktree applied. */
  appliedLsn: z.number().int().nonnegative(),
  stamp: PresenceStamp,
});
export type PresenceEntry = z.infer<typeof PresenceEntry>;

/** A repository's presence document: one entry per replica. */
export type PresenceDoc = Record<string, PresenceEntry>;

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 6;

export const stampOf = (wall: number, counter: number, replica: string): PresenceStamp =>
  `${String(Math.max(0, Math.trunc(wall))).padStart(WALL_DIGITS, "0")}.${String(counter).padStart(COUNTER_DIGITS, "0")}.${replica}`;

/** The wall time and counter a stamp carries. */
export function parseStamp(stamp: PresenceStamp): { wall: number; counter: number; replica: string } {
  const [wall = "0", counter = "0", ...rest] = stamp.split(".");
  return { wall: Number(wall), counter: Number(counter), replica: rest.join(".") };
}

/**
 * A hybrid logical clock (Kulkarni et al.): physical time when it moves forward, a counter when
 * it does not, and it never goes backwards even if the wall clock does or a peer's clock runs
 * ahead (`observe`). Stamps from one clock are strictly increasing.
 */
export class HybridClock {
  private wall = 0;
  private counter = 0;

  constructor(
    readonly replica: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** A stamp for a local write. */
  tick(): PresenceStamp {
    const physical = this.now();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter += 1;
    }
    return stampOf(this.wall, this.counter, this.replica);
  }

  /** Moves past a stamp seen from another replica, so the next local write orders after it. */
  observe(stamp: PresenceStamp): void {
    const seen = parseStamp(stamp);
    const physical = this.now();
    const top = Math.max(this.wall, seen.wall, physical);
    if (top === this.wall && top === seen.wall) this.counter = Math.max(this.counter, seen.counter) + 1;
    else if (top === this.wall) this.counter += 1;
    else if (top === seen.wall) this.counter = seen.counter + 1;
    else this.counter = 0;
    this.wall = top;
  }
}

/** The later of two entries for one key: the greater stamp wins (stamps never tie across replicas). */
const later = (a: PresenceEntry, b: PresenceEntry): PresenceEntry => (b.stamp > a.stamp ? b : a);

/** Merges one entry into a document; returns the same document when the entry changes nothing. */
export function applyPresence(doc: PresenceDoc, entry: PresenceEntry): PresenceDoc {
  const current = doc[entry.replica];
  if (current !== undefined && later(current, entry) === current) return doc;
  return { ...doc, [entry.replica]: entry };
}

/** The join of two documents: commutative, associative and idempotent. */
export function mergePresence(a: PresenceDoc, b: PresenceDoc): PresenceDoc {
  let out = a;
  for (const entry of Object.values(b)) out = applyPresence(out, entry);
  return out;
}

/**
 * The entries to show: not tombstones, and written within `ttlMs` of `now` (a replica that
 * stopped writing without a tombstone, say a laptop that slept, fades out on its own). A view,
 * never part of the merge.
 */
export function livePresence(doc: PresenceDoc, now: number, ttlMs: number): PresenceEntry[] {
  return Object.values(doc)
    .filter((e) => e.state !== "gone" && now - parseStamp(e.stamp).wall <= ttlMs)
    .sort((a, b) => a.author.agent.localeCompare(b.author.agent) || a.replica.localeCompare(b.replica));
}

/** Other live replicas that touch any of `files` or `symbols`: a soft heads-up, never a refusal. */
export function presenceOverlaps(
  doc: PresenceDoc,
  replica: string,
  files: string[],
  symbols: string[],
  now: number,
  ttlMs: number,
): { entry: PresenceEntry; files: string[]; symbols: string[] }[] {
  const myFiles = new Set(files);
  const mySymbols = new Set(symbols);
  return livePresence(doc, now, ttlMs)
    .filter((e) => e.replica !== replica)
    .map((entry) => ({
      entry,
      files: entry.files.filter((f) => myFiles.has(f)),
      symbols: entry.symbols.filter((s) => mySymbols.has(s)),
    }))
    .filter((o) => o.files.length > 0 || o.symbols.length > 0);
}
