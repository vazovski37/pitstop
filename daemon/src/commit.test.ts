import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommitRequest, type Author } from "@pitstop/protocol";
import { commit, CommitRejected, importWorktree } from "./commit.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { readState, writeState } from "./state.js";
import type { Tree } from "./symbols.js";
import { FakeApplier, fixtureCommitFiles, fixtureMessages, removeDir, tempDir } from "./test-support.js";

const author: Author = { developer: "teammate", agent: "agent-b" };

describe("pitstop commit", () => {
  let worktree: string;
  let server: FakeServer;
  const applier = new FakeApplier();

  beforeEach(async () => {
    worktree = await tempDir();
    server = await startFakeServer({ messages: fixtureMessages() }); // head #122
    applier.applied = [];
    applier.files = fixtureCommitFiles();
    applier.trees = { main: new Map(), "@": new Map() };
  });
  afterEach(async () => {
    await server.close();
    await removeDir(worktree);
  });

  const send = (intent = "Show last-seen time on ProfilePage", extra: Partial<Parameters<typeof commit>[0]> = {}) =>
    commit({ serverUrl: server.url, worktree, applier, intent, author, ...extra });

  it("sends @ as a CommitRequest with content and applies the accepted entry", async () => {
    await writeState(worktree, { appliedLsn: 122 });
    const changeset = await send();
    expect(changeset.lsn).toBe(123);
    const sent = server.commits[0];
    expect(() => CommitRequest.parse(sent)).not.toThrow();
    expect(sent).toMatchObject({ baseLsn: 122, author, intent: "Show last-seen time on ProfilePage", writeSet: [], readSet: [] });
    expect(sent?.readBaseLsn).toBeUndefined();
    expect(sent?.files[0]?.content).toContain("getCurrentUser");
    expect(sent?.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(applier.lsns).toEqual([123]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 123 });
  });

  it("fills the symbol sets from the worktree's TypeScript project", async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] });
    const main: Tree = new Map([
      ["tsconfig.json", tsconfig],
      ["src/a.ts", "export function f(x: number): number {\n  return x;\n}\nexport function g(): number {\n  return 1;\n}\n"],
    ]);
    const at: Tree = new Map(main);
    at.set("src/a.ts", "export function f(x: number): number {\n  return x + g();\n}\nexport function g(): number {\n  return 1;\n}\n");
    applier.trees = { main, "@": at };
    await writeState(worktree, { appliedLsn: 122 });
    await send();
    expect(server.commits[0]).toMatchObject({ writeSet: ["src/a.ts#f"], sigWriteSet: [], readSet: ["src/a.ts#g"] });
  });

  it("sends readBaseLsn when the daemon recorded one, and forgets it once the commit lands", async () => {
    await writeState(worktree, { appliedLsn: 122, readBaseLsn: 120 });
    await send();
    expect(server.commits[0]).toMatchObject({ baseLsn: 122, readBaseLsn: 120 });
    expect(await readState(worktree)).toEqual({ appliedLsn: 123 });
  });

  it("moves readBaseLsn past the entries a skew refusal named, so the adapted commit is not refused for the same skew", async () => {
    await writeState(worktree, { appliedLsn: 122, readBaseLsn: 120 });
    const log: string[] = [];
    server.rejectNextCommit({
      reason: "escalated",
      message: "write skew: #121 changed getCurrentUser (signature). Re-read src/auth/session.ts at head #122 and commit again",
      conflictsWith: [121, 122],
    });
    await expect(send(undefined, { log: (l) => log.push(l) })).rejects.toMatchObject({ reason: "escalated", conflictsWith: [121, 122] });
    expect(await readState(worktree)).toEqual({ appliedLsn: 122, readBaseLsn: 122 });
    expect(log).toContain("reads are checked from #122 from now on: the server named what to re-read");
    await send(); // the fake records accepted commits only
    expect(server.commits[0]).toMatchObject({ baseLsn: 122 });
    expect(server.commits[0]?.readBaseLsn).toBeUndefined();
    expect(await readState(worktree)).toEqual({ appliedLsn: 123 });
  });

  it("keeps readBaseLsn where it was on a write-write refusal, which names nothing the agent read", async () => {
    await writeState(worktree, { appliedLsn: 122, readBaseLsn: 120 });
    server.rejectNextCommit({ reason: "constraint_failed", message: "changed since #122 by #121: src/a.ts. Rebase onto #122 and retry", conflictsWith: [121] });
    await expect(send()).rejects.toBeInstanceOf(CommitRejected);
    expect(await readState(worktree)).toEqual({ appliedLsn: 122, readBaseLsn: 120 });
  });

  it("does not apply an entry the daemon applied while the server was answering", async () => {
    await writeState(worktree, { appliedLsn: 122, readBaseLsn: 121 });
    // The server pushes the entry before it answers: here the daemon wins the race.
    const racing: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      await writeState(worktree, { appliedLsn: 123, readBaseLsn: 121 });
      return res;
    };
    const changeset = await send(undefined, { fetch: racing });
    expect(changeset.lsn).toBe(123);
    expect(applier.lsns).toEqual([]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 123 });
  });

  it("leaves entries it has not applied yet to the daemon", async () => {
    await writeState(worktree, { appliedLsn: 120, readBaseLsn: 119 });
    const changeset = await send();
    expect(changeset.lsn).toBe(123);
    expect(applier.lsns).toEqual([]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 120 });
  });

  it("refuses to commit when @ has no changes", async () => {
    applier.files = [];
    await expect(send()).rejects.toThrow(/nothing to commit/);
    expect(server.commits).toEqual([]);
  });

  it("surfaces a rejection", async () => {
    await writeState(worktree, { appliedLsn: 122 });
    await expect(send("")).rejects.toBeInstanceOf(CommitRejected);
    expect(applier.lsns).toEqual([]);
  });

  it("sends the shared token", async () => {
    await server.close();
    server = await startFakeServer({ messages: fixtureMessages(), token: "s3cret" });
    await writeState(worktree, { appliedLsn: 122 });
    await expect(send()).rejects.toThrow(/401/);
    await expect(send(undefined, { token: "s3cret" })).resolves.toMatchObject({ lsn: 123 });
  });
});

describe("pitstop import", () => {
  let worktree: string;
  let server: FakeServer;
  const applier = new FakeApplier();

  beforeEach(async () => {
    worktree = await tempDir();
    server = await startFakeServer({ messages: [{ type: "hello", serverVersion: "empty", headLsn: 0 }] });
    applier.applied = [];
    applier.trees = {
      main: new Map(),
      "@": new Map([
        ["tsconfig.json", "{}"],
        ["src/a.ts", "export const a = 1;\n"],
        ["logo.png", "\u0089PNG\0\0binary"],
      ]),
    };
  });
  afterEach(async () => {
    await server.close();
    await removeDir(worktree);
  });

  it("sends every text file as an add at base LSN 0 and applies the first entry", async () => {
    const log: string[] = [];
    const changeset = await importWorktree({ serverUrl: server.url, worktree, applier, author, log: (l) => log.push(l) });
    expect(changeset.lsn).toBe(1);
    const sent = server.commits[0];
    expect(sent).toMatchObject({ baseLsn: 0, intent: `import ${worktree.split(/[\\/]/).pop()}`, writeSet: [], readSet: [] });
    expect(sent?.files.map((f) => `${f.op} ${f.path}`)).toEqual(["add tsconfig.json", "add src/a.ts"]);
    expect(sent?.files.every((f) => f.content !== undefined && f.blob?.startsWith("sha256:"))).toBe(true);
    expect(log.some((l) => l.startsWith("skipped logo.png"))).toBe(true);
    expect(applier.lsns).toEqual([1]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 1 });
  });

  it("refuses a worktree that already applied entries", async () => {
    await writeState(worktree, { appliedLsn: 5 });
    await expect(importWorktree({ serverUrl: server.url, worktree, applier, author })).rejects.toThrow(/at #5/);
    expect(server.commits).toEqual([]);
  });
});
