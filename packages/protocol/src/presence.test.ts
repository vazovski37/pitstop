import { describe, expect, it } from "vitest";
import {
  applyPresence,
  HybridClock,
  livePresence,
  mergePresence,
  parseStamp,
  presenceOverlaps,
  stampOf,
  type PresenceDoc,
  type PresenceEntry,
} from "./presence.js";

/** A small deterministic PRNG, so the property checks below are reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entry = (replica: string, wall: number, counter: number, extra: Partial<PresenceEntry> = {}): PresenceEntry => ({
  replica,
  repo: "teamdb/demo",
  author: { developer: "dev", agent: `agent-${replica}` },
  state: "working",
  files: [],
  symbols: [],
  appliedLsn: 0,
  stamp: stampOf(wall, counter, replica),
  ...extra,
});

/** Random updates from a few replicas, each replica's own stamps increasing, as a real clock makes them. */
function randomUpdates(next: () => number, count: number): PresenceEntry[] {
  const replicas = ["a", "b", "c", "d"];
  const clocks = new Map(replicas.map((r) => [r, new HybridClock(r, () => Math.floor(next() * 50))]));
  return Array.from({ length: count }, (_, i) => {
    const replica = replicas[Math.floor(next() * replicas.length)] as string;
    const clock = clocks.get(replica) as HybridClock;
    const state = (["working", "idle", "gone"] as const)[Math.floor(next() * 3)] as PresenceEntry["state"];
    return { ...entry(replica, 0, 0, { state, files: [`f${i % 5}.ts`], appliedLsn: i }), stamp: clock.tick() };
  });
}

const docOf = (entries: PresenceEntry[]): PresenceDoc => entries.reduce<PresenceDoc>((d, e) => applyPresence(d, e), {});

const shuffled = <T>(xs: T[], next: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
};

describe("presence CRDT (a last-writer-wins map)", () => {
  it("merge is commutative, associative and idempotent", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const updates = randomUpdates(next, 30);
      const a = docOf(updates.filter(() => next() < 0.5));
      const b = docOf(updates.filter(() => next() < 0.5));
      const c = docOf(updates.filter(() => next() < 0.5));
      expect(mergePresence(a, b)).toEqual(mergePresence(b, a));
      expect(mergePresence(mergePresence(a, b), c)).toEqual(mergePresence(a, mergePresence(b, c)));
      expect(mergePresence(a, a)).toEqual(a);
    }
  });

  it("replicas that receive the same updates in any order, with duplicates, converge", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const updates = randomUpdates(next, 40);
      const withDuplicates = [...updates, ...updates.filter(() => next() < 0.3)];
      const one = docOf(shuffled(withDuplicates, next));
      const two = docOf(shuffled(withDuplicates, next));
      expect(one).toEqual(two);
      // Every key holds that replica's newest update.
      for (const [replica, e] of Object.entries(one)) {
        const newest = updates.filter((u) => u.replica === replica).reduce((x, y) => (y.stamp > x.stamp ? y : x));
        expect(e).toEqual(newest);
      }
    }
  });

  it("a tombstone is not undone by a late, older update", () => {
    const working = entry("a", 100, 0, { state: "working" });
    const gone = entry("a", 200, 0, { state: "gone" });
    expect(docOf([gone, working]).a?.state).toBe("gone");
    expect(livePresence(docOf([gone, working]), 250, 1_000)).toEqual([]);
  });

  it("applying an entry that changes nothing returns the same document", () => {
    const doc = docOf([entry("a", 200, 0)]);
    expect(applyPresence(doc, entry("a", 100, 0))).toBe(doc);
  });
});

describe("HybridClock", () => {
  it("never goes backwards, even when the wall clock does", () => {
    let wall = 1_000;
    const clock = new HybridClock("a", () => wall);
    const stamps = [clock.tick()];
    wall = 500; // the system clock was set back
    stamps.push(clock.tick(), clock.tick());
    wall = 2_000;
    stamps.push(clock.tick());
    for (let i = 1; i < stamps.length; i++) expect((stamps[i] as string) > (stamps[i - 1] as string)).toBe(true);
    expect(parseStamp(stamps[1] as string)).toEqual({ wall: 1_000, counter: 1, replica: "a" });
  });

  it("orders its next write after a stamp it observed from a replica whose clock runs ahead", () => {
    const behind = new HybridClock("b", () => 1_000);
    const ahead = stampOf(9_000, 4, "a");
    behind.observe(ahead);
    expect(behind.tick() > ahead).toBe(true);
  });
});

describe("presence views", () => {
  it("shows live replicas only: no tombstones, nothing older than the TTL", () => {
    const doc = docOf([entry("a", 1_000, 0), entry("b", 9_000, 0), entry("c", 9_500, 0, { state: "gone" })]);
    expect(livePresence(doc, 10_000, 5_000).map((e) => e.replica)).toEqual(["b"]);
  });

  it("finds other replicas in the same files or symbols", () => {
    const doc = docOf([
      entry("a", 9_000, 0, { files: ["src/auth/session.ts"], symbols: ["src/auth/session.ts#getCurrentUser"] }),
      entry("b", 9_000, 0, { files: ["src/pages/ProfilePage.ts"] }),
    ]);
    const overlaps = presenceOverlaps(doc, "b", ["src/pages/ProfilePage.ts"], ["src/auth/session.ts#getCurrentUser"], 10_000, 5_000);
    expect(overlaps).toEqual([{ entry: doc.a, files: [], symbols: ["src/auth/session.ts#getCurrentUser"] }]);
  });
});
