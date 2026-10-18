/**
 * Tests both stores share: the brain (ADRs, versions, leases), stale intents and the query API
 * reads behave the same in MemoryStore (store.test.ts) and PgStore (pg-store.test.ts). Not a test
 * file itself, and left out of the build (tsconfig.json).
 */
import { expect, it } from "vitest";
import type { Author, CommitRequest, RepoId } from "@pitstop/protocol";
import { InvalidCommit, withBlobHashes, type Store } from "./store.js";

const alice: Author = { developer: "alice", agent: "agent-a" };
const bob: Author = { developer: "bob", agent: "agent-b" };

let counter = 0;
/** A repository nobody else uses, so the suite needs no cleanup between tests. */
export const freshRepo = async (store: Store): Promise<RepoId> => {
  const id = `brain-${process.pid}-${Date.now().toString(36)}/r${++counter}`;
  await store.createRepo(id);
  return id;
};

const commit = (repo: RepoId, key: string, extra: Partial<CommitRequest> = {}): CommitRequest =>
  withBlobHashes({
    idempotencyKey: `brain-suite-${repo}-${key}`,
    repo,
    baseLsn: 0,
    author: alice,
    intent: `change ${key}`,
    files: [{ path: `src/${key}.ts`, op: "add", content: `export const ${key} = 1;\n` }],
    writeSet: [],
    sigWriteSet: [],
    readSet: [],
    ...extra,
  });

export function brainStoreSuite(store: () => Store): void {
  it("numbers ADRs per repository and moves the brain version on accept and supersede only", async () => {
    const s = store();
    const repo = await freshRepo(s);
    const other = await freshRepo(s);
    const one = await s.proposeAdr({ repo, title: "Pages never touch the database", decision: "Pages read through services.", createdBy: "alice", rules: [{ kind: "forbid_import", files: "src/pages/**", target: "src/db/**" }] });
    const two = await s.proposeAdr({ repo, title: "No console.log", decision: "Use the logger.", reason: "Noise.", createdBy: "bob" });
    expect(await s.proposeAdr({ repo: other, title: "Elsewhere", decision: "d", createdBy: "x" })).toMatchObject({ number: 1 });
    expect(one).toMatchObject({ repo, number: 1, status: "proposed", version: 0, reason: "", consequences: "", createdBy: "alice" });
    expect(one.rules).toEqual([{ kind: "forbid_import", files: "src/pages/**", target: "src/db/**" }]);
    expect(two).toMatchObject({ number: 2, reason: "Noise.", rules: [] });
    expect(await s.brainVersion(repo)).toBe(0);

    const accepted = await s.decideAdr(repo, 1, "accepted", "owner1");
    expect(accepted).toMatchObject({ ok: true, version: 1, adr: { number: 1, status: "accepted", version: 1, decidedBy: "owner1" } });
    expect(accepted.ok && accepted.adr.decidedAt).toBeTruthy();
    const rejected = await s.decideAdr(repo, 2, "rejected", "owner1");
    expect(rejected).toMatchObject({ ok: true, version: 1, adr: { status: "rejected", version: 0 } });
    expect(await s.decideAdr(repo, 2, "accepted", "owner1")).toMatchObject({ ok: false, error: "invalid_transition", adr: { status: "rejected" } });
    expect(await s.decideAdr(repo, 1, "accepted", "owner1")).toMatchObject({ ok: false, error: "invalid_transition" });
    expect(await s.decideAdr(repo, 9, "accepted", "owner1")).toEqual({ ok: false, error: "not_found" });
    expect(await s.brainVersion(repo)).toBe(1);
    expect(await s.brainVersion(other)).toBe(0);

    await s.proposeAdr({ repo, title: "Third", decision: "d3", createdBy: "alice" });
    expect(await s.decideAdr(repo, 3, "accepted", "owner1")).toMatchObject({ ok: true, version: 2 });
    expect(await s.decideAdr(repo, 1, "superseded", "owner1")).toMatchObject({ ok: true, version: 3, adr: { status: "superseded", version: 3 } });
    expect(await s.brainVersion(repo)).toBe(3);

    const inForce = async (v: number) => (await s.adrsInForce(repo, v)).map((a) => a.number);
    expect(await inForce(0)).toEqual([]);
    expect(await inForce(1)).toEqual([1]);
    expect(await inForce(2)).toEqual([1, 3]);
    expect(await inForce(3)).toEqual([3]);
    expect((await s.listAdrs(repo)).map((a) => [a.number, a.status])).toEqual([[1, "superseded"], [2, "rejected"], [3, "accepted"]]);
    expect(await s.getAdr(repo, 3)).toMatchObject({ title: "Third", status: "accepted" });
    expect(await s.getAdr(repo, 4)).toBeUndefined();
    await expect(s.proposeAdr({ repo: "no/such", title: "t", decision: "d", createdBy: "x" })).rejects.toThrow(/unknown repo/);
  });

  it("accepts an ADR once when two owners decide at the same moment", async () => {
    const s = store();
    const repo = await freshRepo(s);
    await s.proposeAdr({ repo, title: "t", decision: "d", createdBy: "a" });
    const answers = await Promise.all([s.decideAdr(repo, 1, "accepted", "a"), s.decideAdr(repo, 1, "accepted", "b")]);
    expect(answers.map((a) => a.ok).sort()).toEqual([false, true]);
    expect(await s.brainVersion(repo)).toBe(1);
    expect((await s.adrsInForce(repo, 1)).map((a) => a.number)).toEqual([1]);
  });

  it("records the brain version a commit was validated against", async () => {
    const s = store();
    const repo = await freshRepo(s);
    await s.proposeAdr({ repo, title: "t", decision: "d", createdBy: "a" });
    await s.decideAdr(repo, 1, "accepted", "a");
    expect((await s.append(commit(repo, "plain"))).brainVersion).toBe(1);
    expect((await s.append(commit(repo, "decided"), () => ({ brainVersion: 0 }))).brainVersion).toBe(0);
    expect((await s.entriesAfter(repo, 0, 10)).map((e) => e.brainVersion)).toEqual([1, 0]);
  });

  it("grants one holder per symbol, refuses the others, renews for the holder and expires by the clock", async () => {
    const s = store();
    const repo = await freshRepo(s);
    const symbol = "src/auth/session.ts#getCurrentUser";
    const t0 = new Date("2030-01-01T00:00:00Z");
    const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

    const first = await s.acquireLease({ repo, symbol, holder: alice, reason: "changing its return type", ttlSeconds: 60 }, t0);
    expect(first).toMatchObject({ granted: true, renewed: false, expired: [], lease: { repo, symbol, holder: alice, status: "held", reason: "changing its return type", expiresAt: at(60).toISOString() } });
    const refused = await s.acquireLease({ repo, symbol, holder: bob, reason: "me too", ttlSeconds: 60 }, at(10));
    expect(refused).toMatchObject({ granted: false, holder: { holder: alice, expiresAt: at(60).toISOString() } });
    const renewed = await s.acquireLease({ repo, symbol, holder: alice, reason: "still at it", ttlSeconds: 120 }, at(30));
    expect(renewed).toMatchObject({ granted: true, renewed: true, lease: { reason: "still at it", expiresAt: at(150).toISOString() } });
    expect((await s.liveLeases(repo, at(100))).map((l) => l.symbol)).toEqual([symbol]);
    expect(await s.liveLeases(repo, at(151))).toEqual([]);

    // Past its expiry, the next taker gets it and the old lease is reported expired.
    const taken = await s.acquireLease({ repo, symbol, holder: bob, reason: "mine now", ttlSeconds: 60 }, at(200));
    expect(taken).toMatchObject({ granted: true, renewed: false, lease: { holder: bob } });
    expect(taken.expired.map((l) => [l.holder.agent, l.status])).toEqual([["agent-a", "expired"]]);

    // Released only for the holder named: a lease someone took since is not.
    expect(await s.releaseLease(repo, symbol, at(201), alice)).toBeUndefined();
    expect(await s.releaseLease(repo, symbol, at(201), bob)).toMatchObject({ holder: bob, status: "released" });
    expect(await s.releaseLease(repo, symbol)).toBeUndefined();
    expect(await s.liveLeases(repo, at(201))).toEqual([]);
  });

  it("gives a contested symbol to exactly one of many concurrent takers", async () => {
    const s = store();
    const repo = await freshRepo(s);
    const now = new Date("2030-01-01T00:00:00Z");
    const grants = await Promise.all(
      Array.from({ length: 6 }, (_, i) => s.acquireLease({ repo, symbol: "src/hot.ts#hot", holder: { developer: `dev${i}`, agent: `agent-${i}` }, reason: "", ttlSeconds: 60 }, now)),
    );
    expect(grants.filter((g) => g.granted)).toHaveLength(1);
    const winner = grants.find((g) => g.granted);
    for (const g of grants) if (!g.granted && winner?.granted) expect(g.holder.holder).toEqual(winner.lease.holder);
  });

  it("ties leases to an open intent: refused for a closed one or another's, held by that intent, renewed only by asking again, released with it", async () => {
    const s = store();
    const repo = await freshRepo(s);
    const intent = await s.openIntent({ repo, author: alice, baseLsn: 0, text: "fix auth", declaredSymbols: ["src/a.ts#a"] });
    const earlier = new Date(Date.now() - 50_000);
    const grant = await s.acquireLease({ repo, symbol: "src/a.ts#a", holder: alice, intentId: intent.id, reason: "", ttlSeconds: 60 }, earlier);
    expect(grant).toMatchObject({ granted: true, lease: { intentId: intent.id } });
    const before = grant.granted ? Date.parse(grant.lease.expiresAt) : 0;
    // A heartbeat, which any reader of the stream may send, renews nothing.
    await s.heartbeat(repo, intent.id);
    expect((await s.liveLeases(repo))[0]?.expiresAt).toBe(new Date(before).toISOString());
    // The same person's other checkout (same author, another intent) is not the holder.
    const elsewhere = await s.openIntent({ repo, author: alice, baseLsn: 0, text: "other checkout", declaredSymbols: [] });
    expect(await s.acquireLease({ repo, symbol: "src/a.ts#a", holder: alice, intentId: elsewhere.id, reason: "", ttlSeconds: 60 })).toMatchObject({ granted: false, holder: { intentId: intent.id } });
    expect(await s.acquireLease({ repo, symbol: "src/a.ts#a", holder: alice, reason: "", ttlSeconds: 60 })).toMatchObject({ granted: false });
    // Its holder renews it by asking again.
    expect(await s.acquireLease({ repo, symbol: "src/a.ts#a", holder: alice, intentId: intent.id, reason: "", ttlSeconds: 60 })).toMatchObject({ granted: true, renewed: true });
    const [live] = await s.liveLeases(repo);
    expect(Date.parse(live?.expiresAt ?? "")).toBeGreaterThan(before + 40_000);
    // Someone else's intent cannot carry a lease.
    await expect(s.acquireLease({ repo, symbol: "src/z.ts#z", holder: bob, intentId: intent.id, reason: "", ttlSeconds: 60 })).rejects.toThrow(/not agent-b's/);
    await s.acquireLease({ repo, symbol: "src/b.ts#b", holder: alice, intentId: intent.id, reason: "", ttlSeconds: 60 });
    await s.acquireLease({ repo, symbol: "src/c.ts#c", holder: bob, reason: "", ttlSeconds: 60 });

    const released = await s.releaseIntentLeases(repo, intent.id);
    expect(released.map((l) => [l.symbol, l.status]).sort()).toEqual([["src/a.ts#a", "released"], ["src/b.ts#b", "released"]]);
    expect((await s.liveLeases(repo)).map((l) => l.symbol)).toEqual(["src/c.ts#c"]);

    await s.append(commit(repo, "closes", { intentId: intent.id }));
    await expect(s.acquireLease({ repo, symbol: "src/d.ts#d", holder: alice, intentId: intent.id, reason: "", ttlSeconds: 60 })).rejects.toBeInstanceOf(InvalidCommit);
    await expect(s.acquireLease({ repo, symbol: "src/d.ts#d", holder: alice, intentId: "int_nope", reason: "", ttlSeconds: 60 })).rejects.toThrow(/unknown intent/);
    await expect(s.acquireLease({ repo: "no/such", symbol: "src/d.ts#d", holder: alice, reason: "", ttlSeconds: 60 })).rejects.toThrow(/unknown repo/);
  });

  it("expires held leases past their expiry in the sweep", async () => {
    const s = store();
    const repo = await freshRepo(s);
    const t0 = new Date("2030-01-01T00:00:00Z");
    await s.acquireLease({ repo, symbol: "src/a.ts#a", holder: alice, reason: "", ttlSeconds: 30 }, t0);
    await s.acquireLease({ repo, symbol: "src/b.ts#b", holder: bob, reason: "", ttlSeconds: 300 }, t0);
    const swept = (await s.expireLeases(new Date(t0.getTime() + 60_000))).filter((l) => l.repo === repo);
    expect(swept.map((l) => [l.symbol, l.status])).toEqual([["src/a.ts#a", "expired"]]);
    expect((await s.liveLeases(repo, new Date(t0.getTime() + 60_000))).map((l) => l.symbol)).toEqual(["src/b.ts#b"]);
  });

  it("marks intents stale after their last heartbeat, and a commit still closes a stale one", async () => {
    const s = store();
    const repo = await freshRepo(s);
    const quiet = await s.openIntent({ repo, author: alice, baseLsn: 0, text: "went quiet", declaredSymbols: [] });
    expect(await s.getIntent(repo, quiet.id)).toMatchObject({ status: "open", text: "went quiet" });
    expect(await s.getIntent("no/such", quiet.id)).toBeUndefined();
    expect((await s.markStaleIntents(new Date(Date.parse(quiet.heartbeatAt) - 1000))).map((i) => i.id)).not.toContain(quiet.id);
    const stale = (await s.markStaleIntents(new Date(Date.now() + 1000))).filter((i) => i.repo === repo);
    expect(stale.map((i) => [i.id, i.status])).toEqual([[quiet.id, "stale"]]);
    expect(await s.openIntents(repo)).toEqual([]);
    await s.heartbeat(repo, quiet.id); // too late: a heartbeat does not reopen it
    expect((await s.getIntent(repo, quiet.id))?.status).toBe("stale");
    await s.append(commit(repo, "late", { intentId: quiet.id }));
    expect((await s.getIntent(repo, quiet.id))?.status).toBe("committed");
  });

  it("answers the query API's reads: by symbol written or read, by path glob or path, since an LSN", async () => {
    const s = store();
    const repo = await freshRepo(s);
    const intent = await s.openIntent({ repo, author: bob, baseLsn: 0, text: "profile", declaredSymbols: [] });
    await s.append(commit(repo, "auth", { files: [{ path: "src/auth/session.ts", op: "add", content: "export function getCurrentUser() {}\n" }], writeSet: ["src/auth/session.ts#getCurrentUser"] }));
    await s.append(commit(repo, "auth2", { files: [{ path: "src/auth/session.ts", op: "modify", content: "export function getCurrentUser(x: number) {}\n" }], writeSet: ["src/auth/session.ts#getCurrentUser"], sigWriteSet: ["src/auth/session.ts#getCurrentUser"] }));
    await s.append(commit(repo, "page", { author: bob, intentId: intent.id, files: [{ path: "src/pages/Profile.tsx", op: "add", content: "x\n" }], writeSet: ["src/pages/Profile.tsx#Profile"], readSet: ["src/auth/session.ts#getCurrentUser"] }));
    await s.append(commit(repo, "move", { files: [{ path: "src/pages/Me.tsx", op: "rename", fromPath: "src/pages/Profile.tsx", content: "x\n" }] }));

    const lsns = (entries: { lsn: number }[]) => entries.map((e) => e.lsn);
    expect(lsns(await s.findEntries(repo, { writes: "src/auth/session.ts#getCurrentUser", newestFirst: true, limit: 10 }))).toEqual([2, 1]);
    const readers = await s.findEntries(repo, { reads: "src/auth/session.ts#getCurrentUser", limit: 10 });
    expect(readers.map((e) => [e.lsn, e.intentId, e.writeSet])).toEqual([[3, intent.id, ["src/pages/Profile.tsx#Profile"]]]);
    expect(lsns(await s.findEntries(repo, { touches: "src/pages/**", limit: 10 }))).toEqual([3, 4]);
    expect(lsns(await s.findEntries(repo, { touches: "src/pages/**", since: 3, limit: 10 }))).toEqual([4]);
    expect(lsns(await s.findEntries(repo, { touches: "src/*/session.ts", limit: 1 }))).toEqual([1]);
    expect(lsns(await s.findEntries(repo, { paths: ["src/pages/Profile.tsx"], newestFirst: true, limit: 10 }))).toEqual([4, 3]);
    expect(await s.findEntries(repo, { touches: "lib/**", limit: 10 })).toEqual([]);
    // Contents only when asked for: the query API never needs them.
    const [entry] = await s.findEntries(repo, { paths: ["src/auth/session.ts"], limit: 1 });
    expect(entry).toMatchObject({ lsn: 1, intent: "change auth", files: [{ path: "src/auth/session.ts", op: "add" }] });
    expect(entry?.files[0]?.content).toBeUndefined();
    expect(entry?.intentId).toBeUndefined();
    const [full] = await s.findEntries(repo, { paths: ["src/auth/session.ts"], limit: 1, contents: true });
    expect(full?.files[0]?.content).toBe("export function getCurrentUser() {}\n");
    // Pages below an LSN, and entries validated before a brain version.
    expect(lsns(await s.findEntries(repo, { touches: "src/**", newestFirst: true, before: 3, limit: 10 }))).toEqual([2, 1]);
    expect(lsns(await s.findEntries(repo, { touches: "src/**", brainBefore: 1, limit: 10 }))).toEqual([1, 2, 3, 4]);
    expect(await s.findEntries(repo, { touches: "src/**", brainBefore: 0, limit: 10 })).toEqual([]);
    // Globs with braces and a trailing slash.
    expect(lsns(await s.findEntries(repo, { touches: "src/{auth,pages}/*.{ts,tsx}", limit: 10 }))).toEqual([1, 2, 3, 4]);
    expect(lsns(await s.findEntries(repo, { touches: "src/pages/", limit: 10 }))).toEqual([3, 4]);
    // The tree, read in part: by path or glob, and its paths alone.
    expect([...(await s.filesAt(repo, 4, { paths: ["src/auth/session.ts"] })).entries()]).toEqual([["src/auth/session.ts", "export function getCurrentUser(x: number) {}\n"]]);
    expect([...(await s.filesAt(repo, 4, { globs: ["src/pages/**"] })).keys()]).toEqual(["src/pages/Me.tsx"]);
    expect([...(await s.filesAt(repo, 3, { globs: ["src/pages/**"] })).keys()]).toEqual(["src/pages/Profile.tsx"]);
    expect((await s.filesAt(repo, 4, {})).size).toBe(0);
    expect(await s.pathsAt(repo, 4)).toEqual(["src/auth/session.ts", "src/pages/Me.tsx"]);

    const states = await s.symbolStates(repo, "src/", 10);
    expect(states.map((x) => [x.symbol, x.lsn, x.signature, x.intentId ?? null])).toEqual([
      ["src/auth/session.ts#getCurrentUser", 2, true, null],
      ["src/pages/Profile.tsx#Profile", 3, false, intent.id],
    ]);
    expect((await s.symbolStates(repo, "src/pages/", 10)).map((x) => x.symbol)).toEqual(["src/pages/Profile.tsx#Profile"]);
    expect(await s.symbolStates(repo, "src/", 1)).toHaveLength(1);
  });
}
