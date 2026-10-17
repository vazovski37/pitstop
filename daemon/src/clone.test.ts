import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REPO, type Changeset, type ServerMessage } from "@pitstop/protocol";
import { cloneRepository, prepareWorktree } from "./clone.js";
import { readFileConfig } from "./config.js";
import { run } from "./exec.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { binariesFromEnv, blobHash, JjWorktree } from "./jj.js";
import { readState } from "./state.js";
import { entryAt, FakeApplier, removeDir, tempDir } from "./test-support.js";


/** A two-entry log for `teamdb/demo`: an import of two files, then a change to one of them. */
const log: Changeset[] = [
  entryAt(1, {
    repo: "teamdb/demo",
    baseLsn: 0,
    intent: "import teamdb",
    files: [
      { path: "a.txt", op: "add", content: "a1\na2\n", blob: blobHash("a1\na2\n") },
      { path: "src/b.ts", op: "add", content: "export const b = 1;\n", blob: blobHash("export const b = 1;\n") },
    ],
    writeSet: [],
    sigWriteSet: [],
    readSet: [],
  }),
  entryAt(2, {
    repo: "teamdb/demo",
    baseLsn: 1,
    intent: "a2 becomes a3",
    files: [{ path: "a.txt", op: "modify", content: "a1\na3\n", blob: blobHash("a1\na3\n") }],
    writeSet: [],
    sigWriteSet: [],
    readSet: [],
  }),
];
const messages: ServerMessage[] = [{ type: "hello", serverVersion: "x", headLsn: 2 }, ...log.map((changeset) => ({ type: "entry" as const, changeset }))];

describe("pitstop clone", () => {
  let server: FakeServer;
  let dir: string;
  const applier = new FakeApplier();

  beforeEach(async () => {
    server = await startFakeServer({ messages, repos: ["teamdb/demo"] });
    dir = join(await tempDir(), "clone");
    applier.applied = [];
  });
  afterEach(async () => {
    await server.close();
    await removeDir(join(dir, ".."));
  });

  const hooks = { prepare: async (d: string) => mkdir(d, { recursive: true }), applierFor: () => applier };

  it("fetches the log, replays every entry in order and leaves config and state behind", async () => {
    const lines: string[] = [];
    const result = await cloneRepository({ serverUrl: server.url, token: "t1", repo: "teamdb/demo", dir, log: (l) => lines.push(l) }, hooks);
    expect(result).toMatchObject({ dir, entries: 2, repo: { id: "teamdb/demo", headLsn: 2 } });
    expect(applier.lsns).toEqual([1, 2]);
    expect(await readFileConfig(dir)).toEqual({ serverUrl: server.url, token: "t1", repo: "teamdb/demo" });
    expect(await readState(dir)).toEqual({ appliedLsn: 2 });
    expect(lines).toContain("teamdb/demo is at #2");
  });

  it("refuses an unknown repository and a directory that is not empty", async () => {
    await expect(cloneRepository({ serverUrl: server.url, repo: "nobody/nothing", dir }, hooks)).rejects.toThrow(/no repository nobody\/nothing/);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "x"), "x");
    await expect(cloneRepository({ serverUrl: server.url, repo: "teamdb/demo", dir }, hooks)).rejects.toThrow(/not empty/);
    expect(applier.lsns).toEqual([]);
  });

  it("works for the default repository without a repo query", async () => {
    await cloneRepository({ serverUrl: server.url, repo: DEFAULT_REPO, dir }, hooks);
    expect(applier.lsns).toEqual([1, 2]);
    expect(await readFileConfig(dir)).toEqual({ serverUrl: server.url, repo: DEFAULT_REPO });
  });
});

const bin = binariesFromEnv();
const available = await Promise.all([run(bin.jj, ["--version"], { cwd: tmpdir() }), run(bin.git, ["--version"], { cwd: tmpdir() })]).then(
  () => true,
  () => false,
);

describe.skipIf(!available)("pitstop clone into a real colocated worktree", { timeout: 60_000 }, () => {
  let server: FakeServer;
  let base: string;
  beforeEach(async () => {
    server = await startFakeServer({ messages, repos: ["teamdb/demo"] });
    base = await tempDir();
    process.env.JJ_USER = "agent";
    process.env.JJ_EMAIL = "agent@test";
  });
  afterEach(async () => {
    await server.close();
    await removeDir(base);
  });

  it("replays the log into files, commits and a working copy the daemon can continue from", async () => {
    const dir = join(base, "one");
    const result = await cloneRepository({ serverUrl: server.url, repo: "teamdb/demo", dir, bin });
    expect(result.entries).toBe(2);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("a1\na3\n");
    expect(await readFile(join(dir, "src", "b.ts"), "utf8")).toBe("export const b = 1;\n");
    const git = (...args: string[]) => run(bin.git, args, { cwd: dir });
    expect((await git("log", "--format=%s", "main")).trim().split("\n")).toEqual(["#2 a2 becomes a3", "#1 import teamdb", "pitstop clone teamdb/demo"]);
    expect(await readState(dir)).toEqual({ appliedLsn: 2 });
    // the daemon's own operations work on the clone: @ is empty on top of main
    const wt = new JjWorktree(dir, bin);
    expect(await wt.hasChanges()).toBe(false);
    expect(await wt.diffAgainstMain()).toEqual([]);

    // a second clone of the same log agrees on every commit id
    const other = join(base, "two");
    await cloneRepository({ serverUrl: server.url, repo: "teamdb/demo", dir: other, bin });
    expect((await run(bin.git, ["rev-parse", "main"], { cwd: other })).trim()).toBe((await git("rev-parse", "main")).trim());
  });

  it("prepares an empty worktree with a main bookmark jj knows", async () => {
    const dir = join(base, "empty");
    await mkdir(dir, { recursive: true });
    await prepareWorktree(dir, { id: "teamdb/demo", headLsn: 0, createdAt: "2026-10-17T09:00:00Z" }, bin);
    const out = await run(bin.jj, ["log", "-r", "main", "--no-graph", "-T", "description"], { cwd: dir });
    expect(out.trim()).toBe("pitstop clone teamdb/demo");
  });
});
