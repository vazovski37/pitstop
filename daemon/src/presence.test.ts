import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { applyPresence, parseStamp, stampOf, type Author, type ClientMessage, type PresenceDoc, type PresenceEntry } from "@pitstop/protocol";
import { Daemon, type SafePointResult } from "./daemon.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { Presence, replicaId, type PresenceView } from "./presence.js";
import { STATE_DIR, writeState } from "./state.js";
import { FakeApplier, fixtureCommitFiles, fixtureMessages, removeDir, tempDir, waitFor } from "./test-support.js";

const author: Author = { developer: "teammate", agent: "agent-b" };
const PROFILE = "src/pages/ProfilePage.ts";

/** Another worktree's entry, as its daemon would write it. */
const other = (counter: number, extra: Partial<PresenceEntry> = {}, wall = Date.now()): PresenceEntry => ({
  replica: "w_other",
  repo: "local/default",
  author: { developer: "lbala23", agent: "agent-a" },
  state: "working",
  intent: "Show last-seen on the profile page",
  intentId: "int_09",
  files: [PROFILE],
  symbols: [],
  appliedLsn: 122,
  stamp: stampOf(wall, counter, "w_other"),
  ...extra,
});

describe("the replica id", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await tempDir();
  });
  afterEach(async () => removeDir(worktree));

  it("is made once per worktree, kept in .pitstop/ (which ignores itself), and stays", async () => {
    const id = await replicaId(worktree);
    expect(id).toMatch(/^w_[0-9a-f]{8}$/);
    expect(await replicaId(worktree)).toBe(id);
    expect((await readFile(join(worktree, STATE_DIR, "replica"), "utf8")).trim()).toBe(id);
    expect(await readFile(join(worktree, STATE_DIR, ".gitignore"), "utf8")).toBe("*\n");

    await writeFile(join(worktree, STATE_DIR, "replica"), "not an id!\n");
    const replaced = await replicaId(worktree);
    expect(replaced).toMatch(/^w_[0-9a-f]{8}$/);
    expect(await replicaId(worktree)).toBe(replaced);
  });
});

describe("the daemon's presence", () => {
  let worktree: string;
  let server: FakeServer;
  let daemon: Daemon | undefined;
  let port: number;
  const applier = new FakeApplier();
  const log: string[] = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (await res.json()) as unknown;
  };
  const safePoint = async () => (await api("POST", "/safe-point")) as SafePointResult;
  const view = async () => (await api("GET", "/presence")) as PresenceView;
  /** What this daemon sent, in order. */
  const sent = (): PresenceEntry[] => server.received.flatMap((m) => (m.type === "presence" ? [m.entry] : []));
  const last = (): PresenceEntry | undefined => sent().at(-1);

  const start = async (extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {}) => {
    server = await startFakeServer({ messages: fixtureMessages() });
    await writeState(worktree, { appliedLsn: 122 });
    daemon = new Daemon({
      serverUrl: server.url,
      worktree,
      applier,
      author,
      log: (l) => log.push(l),
      reconnectMs: 0,
      heartbeatMs: 0,
      attachMs: 60_000,
      presenceFilesMs: 0,
      ...extra,
    });
    port = await daemon.start();
    await waitFor(() => sent().length > 0);
    return daemon;
  };

  beforeEach(async () => {
    onTestFailed(() => console.log(["--- daemon log:", ...log].join("\n")));
    worktree = await tempDir();
    applier.applied = [];
    applier.files = [];
    applier.changes = false;
    log.length = 0;
  });
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    await server?.close();
    await removeDir(worktree);
  });

  it("publishes at connect, declare, safe point and commit, with stamps that only grow, and leaves with a tombstone", async () => {
    await start();
    const id = await replicaId(worktree);
    expect(sent()[0]).toMatchObject({ replica: id, repo: "local/default", author, state: "idle", files: [], symbols: [], appliedLsn: 122 });
    expect(parseStamp(sent()[0]?.stamp ?? "").replica).toBe(id);

    await api("POST", "/intents", { text: "Show last-seen time on ProfilePage", symbols: [`${PROFILE}#renderProfile`] });
    expect(last()).toMatchObject({
      state: "working",
      intent: "Show last-seen time on ProfilePage",
      intentId: "int_01",
      symbols: [`${PROFILE}#renderProfile`],
      files: [],
    });

    applier.files = [{ path: PROFILE, op: "modify", content: "x" }];
    await safePoint();
    await waitFor(() => last()?.files.includes(PROFILE) === true); // published in the background
    expect(last()).toMatchObject({ state: "working", intentId: "int_01", files: [PROFILE] });

    applier.files = fixtureCommitFiles();
    await api("POST", "/commit", { intent: "Show last-seen time on ProfilePage" });
    const afterCommit = last();
    expect(afterCommit?.intentId).toBeUndefined();
    expect(afterCommit?.symbols).toEqual([]);

    applier.files = [];
    await safePoint();
    await waitFor(() => last()?.state === "idle");
    expect(last()).toMatchObject({ state: "idle", files: [] });

    await daemon?.close();
    daemon = undefined;
    await waitFor(() => last()?.state === "gone");
    expect(last()).toMatchObject({ replica: id, state: "gone", files: [], symbols: [] });
    expect(last()?.intent).toBeUndefined();

    const stamps = sent().map((e) => e.stamp);
    expect(stamps.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < stamps.length; i++) expect((stamps[i] as string) > (stamps[i - 1] as string)).toBe(true);
    // The fake server merged them all: the tombstone is what it holds.
    expect(server.presence()[id]?.state).toBe("gone");
  });

  it("sends a keepalive with every heartbeat: the same values, a new stamp", async () => {
    applier.files = [{ path: PROFILE, op: "modify", content: "x" }];
    await start({ heartbeatMs: 20 });
    await waitFor(() => sent().length >= 4);
    const [first, ...rest] = sent();
    for (const e of rest) {
      expect({ ...e, stamp: "" }).toEqual({ ...first, stamp: "" });
      expect(e.stamp > (first?.stamp ?? "")).toBe(true);
    }
  });

  it("tells the agent once about another agent in the same files or symbols, and again when the overlap comes back", async () => {
    applier.files = [{ path: PROFILE, op: "modify", content: "x" }];
    await start();
    await api("POST", "/intents", { text: "Rename the profile heading", symbols: [`${PROFILE}#renderProfile`] });
    server.putPresence(other(0, { symbols: [`${PROFILE}#renderProfile`] }));
    await waitFor(async () => (await view()).entries.some((e) => e.replica === "w_other"));

    const first = await safePoint();
    expect(first.notes).toContain(
      `agent-a (lbala23) is also editing ${PROFILE} and changing ${PROFILE}#renderProfile, for 'Show last-seen on the profile page'`,
    );
    expect((await safePoint()).notes.filter((n) => n.includes("is also"))).toEqual([]);

    // The other agent moves on; later it comes back to the file: told again, the file only.
    server.putPresence(other(1, { files: [], symbols: [] }));
    await waitFor(async () => (await view()).entries.some((e) => e.replica === "w_other" && e.files.length === 0));
    expect((await safePoint()).notes.filter((n) => n.includes("is also"))).toEqual([]);
    server.putPresence(other(2, { intent: "Show last-seen, take two", symbols: [] }));
    await waitFor(async () => (await view()).entries.some((e) => e.replica === "w_other" && e.files.length === 1));
    expect((await safePoint()).notes).toContain(`agent-a (lbala23) is also editing ${PROFILE}, for 'Show last-seen, take two'`);

    // One that left is nobody to warn about.
    server.putPresence(other(3, { state: "gone", files: [], symbols: [] }));
    await waitFor(async () => !(await view()).entries.some((e) => e.replica === "w_other"));
    server.putPresence(other(2)); // late and older than the tombstone: stays gone
    expect((await safePoint()).notes.filter((n) => n.includes("is also"))).toEqual([]);
    expect(log).toContain("presence: agent-a (lbala23) left");
  });

  it("GET /presence answers the live entries with their age: not the faded, not the departed", async () => {
    await start();
    const id = await replicaId(worktree);
    server.putPresence(other(0));
    server.putPresence({ ...other(0), replica: "w_slept", stamp: stampOf(Date.now() - 10 * 60_000, 0, "w_slept") });
    server.putPresence({ ...other(0, { state: "gone" }), replica: "w_left", stamp: stampOf(Date.now(), 0, "w_left") });
    await waitFor(async () => (await view()).entries.length === 2);
    const answer = await view();
    expect(answer.replica).toBe(id);
    expect(answer.ttlMs).toBe(120_000);
    expect(answer.entries.map((e) => [e.replica === id ? "me" : e.replica, e.author.agent])).toEqual([
      ["w_other", "agent-a"],
      ["me", "agent-b"],
    ]);
    for (const e of answer.entries) expect(e.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("orders its writes after any stamp it has seen, and writes again over a newer write to its own key", async () => {
    await start();
    const id = await replicaId(worktree);
    const ahead = stampOf(Date.now() + 30_000, 4, "w_other");
    server.putPresence({ ...other(0), stamp: ahead });
    await waitFor(async () => (await view()).entries.some((e) => e.replica === "w_other"));
    applier.files = [{ path: PROFILE, op: "modify", content: "x" }];
    await safePoint();
    await waitFor(() => last()?.files.includes(PROFILE) === true);
    expect((last()?.stamp ?? "") > ahead).toBe(true);

    // A tombstone for this worktree, newer than its last write (a server closing an old socket of ours, late).
    const before = sent().length;
    const tombstone: PresenceEntry = { ...(last() as PresenceEntry), state: "gone", files: [], stamp: stampOf(Date.now() + 40_000, 0, id) };
    server.putPresence(tombstone);
    await waitFor(() => sent().length > before);
    expect(last()).toMatchObject({ state: "working", files: [PROFILE] });
    expect((last()?.stamp ?? "") > tombstone.stamp).toBe(true);
    expect(server.presence()[id]?.state).toBe("working");

    // A live entry under this worktree's id that it did not write (a copy of the checkout) is not answered.
    const twin: PresenceEntry = { ...(last() as PresenceEntry), author: { developer: "dev", agent: "agent-copy" }, stamp: stampOf(Date.now() + 50_000, 0, id) };
    const now = sent().length;
    server.putPresence(twin);
    await waitFor(() => log.some((l) => l.includes("another process writes this worktree's replica id")));
    expect(sent().length).toBe(now);
  });

  it("sends nothing at a safe point that changed nothing, and answers the safe point without waiting for its diff", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated = new FakeApplier();
    gated.diffAgainstMain = async () => {
      await gate;
      return gated.files;
    };
    release(); // connect's publish diffs freely
    await start({ applier: gated });
    const before = sent().length;
    await safePoint();
    await safePoint();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent().length).toBe(before); // idle, no files, written just now: nothing to say

    let hold!: () => void;
    const held = new Promise<void>((resolve) => (hold = resolve));
    gated.diffAgainstMain = async () => {
      await held;
      return gated.files;
    };
    gated.files = [{ path: PROFILE, op: "modify", content: "x" }];
    await safePoint(); // answered while presence's diff is still held
    expect(sent().length).toBe(before);
    hold();
    await waitFor(() => last()?.files.includes(PROFILE) === true);
    expect(sent().length).toBe(before + 1);
  });

  it("names a few of the shared files in a note and counts the rest", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    applier.files = many.map((path) => ({ path, op: "modify" as const, content: "x" }));
    await start();
    server.putPresence(other(0, { files: many }));
    await waitFor(async () => (await view()).entries.some((e) => e.replica === "w_other"));
    const notes = (await safePoint()).notes.filter((n) => n.includes("is also"));
    expect(notes).toEqual([
      "agent-a (lbala23) is also editing src/f0.ts, src/f1.ts, src/f2.ts, src/f3.ts, src/f4.ts and 3 more, for 'Show last-seen on the profile page' (call who for the full list)",
    ]);
  });
});

describe("two daemons sharing one replica id (a copied checkout)", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await tempDir();
  });
  afterEach(async () => removeDir(worktree));

  it("do not answer each other's writes, and the one that stays writes itself back once the other leaves", async () => {
    // A relay that merges and passes on what changed, as the server does.
    let doc: PresenceDoc = {};
    let relayed = 0;
    const peers: Presence[] = [];
    const send = (message: ClientMessage): boolean => {
      if (message.type !== "presence") return true;
      relayed += 1;
      const before = doc;
      doc = applyPresence(doc, message.entry);
      if (doc !== before) setImmediate(() => peers.forEach((p) => p.receive("local/default", [message.entry])));
      return true;
    };
    const logs: string[] = [];
    const peer = (agent: string) =>
      new Presence({
        worktree,
        repo: "local/default",
        author: { developer: "dev", agent },
        applier: new FakeApplier(),
        send,
        appliedLsn: () => 0,
        intent: async () => undefined,
        log: (line) => logs.push(line),
      });
    const [a, b] = [peer("agent-a"), peer("agent-b")];
    peers.push(a, b);
    await a.start();
    await b.start();
    expect(a.replica).toBe(b.replica);
    const replica = a.replica as string;

    await a.publish(true);
    await b.publish(true);
    a.keepalive();
    b.keepalive();
    // Wait for the clash to be noticed rather than a fixed time: CI machines are slow.
    await waitFor(() => logs.some((l) => l.includes(`another process writes this worktree's replica id ${replica}`)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(relayed).toBeLessThanOrEqual(4); // their own writes only, no exchange of rewrites

    a.leave();
    await waitFor(() => doc[replica]?.author.agent === "agent-b" && doc[replica]?.state !== "gone");
    const settled = relayed;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relayed).toBe(settled);
  });
});
