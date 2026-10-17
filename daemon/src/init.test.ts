import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Author } from "@pitstop/protocol";
import { commit } from "./commit.js";
import { configFrom, loadConfig, readFileConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { init } from "./init.js";
import { declareIntent } from "./intents.js";
import { readState, writeState } from "./state.js";
import { FakeApplier, fixtureCommitFiles, removeDir, tempDir, waitFor } from "./test-support.js";

const author: Author = { developer: "teammate", agent: "agent-b" };

describe("configuration", () => {
  let worktree: string;
  beforeEach(async () => {
    worktree = await tempDir();
  });
  afterEach(() => removeDir(worktree));

  it("reads .pitstop/config.json and lets the environment override it", async () => {
    expect(await loadConfig({}, worktree)).toMatchObject({ serverUrl: "http://localhost:8080", worktree });
    await mkdir(join(worktree, ".pitstop"), { recursive: true });
    await writeFile(join(worktree, ".pitstop", "config.json"), JSON.stringify({ serverUrl: "https://pitstop.example/", token: "t1", repo: "teamdb/demo" }));
    expect(await readFileConfig(worktree)).toEqual({ serverUrl: "https://pitstop.example/", token: "t1", repo: "teamdb/demo" });
    expect(await loadConfig({ PITSTOP_AGENT: "agent-b" }, worktree)).toMatchObject({
      serverUrl: "https://pitstop.example",
      token: "t1",
      repo: "teamdb/demo",
      author: { agent: "agent-b" },
    });
    expect(await loadConfig({ PITSTOP_SERVER: "http://localhost:9090", PITSTOP_REPO: "other/repo" }, worktree)).toMatchObject({
      serverUrl: "http://localhost:9090",
      repo: "other/repo",
      token: "t1",
    });
  });

  it("refuses a repository id that is not owner/name", () => {
    expect(() => configFrom({ repo: "Not/Valid" }, {}, "/w")).toThrow();
  });
});

describe("pitstop init and the repository on requests", () => {
  let worktree: string;
  let server: FakeServer;
  const applier = new FakeApplier();

  beforeEach(async () => {
    worktree = await tempDir();
    server = await startFakeServer({ messages: [{ type: "hello", serverVersion: "empty", headLsn: 0 }] });
    applier.applied = [];
    applier.files = [];
    applier.trees = { main: new Map(), "@": new Map([["tsconfig.json", "{}"], ["src/a.ts", "export const a = 1;\n"]]) };
  });
  afterEach(async () => {
    await server.close();
    await removeDir(worktree);
  });

  it("writes the config, creates the repository and imports the worktree as its first entry", async () => {
    const log: string[] = [];
    const result = await init({ serverUrl: `${server.url}/`, token: "t1", repo: "teamdb/demo", worktree, applier, author, log: (l) => log.push(l) });
    expect(result.repo).toMatchObject({ id: "teamdb/demo", headLsn: 0 });
    expect(result.importedAs).toBe(1);
    expect(await readFileConfig(worktree)).toEqual({ serverUrl: server.url, token: "t1", repo: "teamdb/demo" });
    expect(server.repos.map((r) => r.id)).toEqual(["teamdb/demo"]);
    expect(server.commits[0]).toMatchObject({ repo: "teamdb/demo", baseLsn: 0, intent: `import ${worktree.split(/[\\/]/).pop()}` });
    expect(server.commits[0]?.files.map((f) => f.path)).toEqual(["tsconfig.json", "src/a.ts"]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 1 });
    expect(log.some((l) => l.startsWith("created teamdb/demo at #0"))).toBe(true);
  });

  it("does not import into a repository that already has entries, and is idempotent", async () => {
    await init({ serverUrl: server.url, repo: "teamdb/demo", worktree, applier, author });
    const second = await tempDir();
    try {
      const result = await init({ serverUrl: server.url, repo: "teamdb/demo", worktree: second, applier, author });
      expect(result.repo).toMatchObject({ id: "teamdb/demo", headLsn: 1 });
      expect(result.importedAs).toBeUndefined();
      expect(server.repos).toHaveLength(1);
      expect(server.commits).toHaveLength(1);
      expect(await readState(second)).toEqual({ appliedLsn: 0 });
    } finally {
      await removeDir(second);
    }
  });

  it("subscribe, commits and intents carry the repository once configured", async () => {
    await writeState(worktree, { appliedLsn: 0 });
    const daemon = new Daemon({ serverUrl: server.url, repo: "teamdb/demo", worktree, applier, author, reconnectMs: 0, heartbeatMs: 0 });
    await daemon.start();
    try {
      await waitFor(() => server.received.some((m) => m.type === "subscribe"));
      expect(server.received[0]).toEqual({ type: "subscribe", repo: "teamdb/demo", fromLsn: 0 });
      const intent = await declareIntent({ serverUrl: server.url, repo: "teamdb/demo", worktree, author, text: "x" });
      expect(intent.repo).toBe("teamdb/demo");
      applier.files = fixtureCommitFiles();
      await commit({ serverUrl: server.url, repo: "teamdb/demo", worktree, applier, author, intent: "x" });
      expect(server.commits[0]).toMatchObject({ repo: "teamdb/demo", intentId: intent.id });
      expect((await daemon.status()).repo).toBe("teamdb/demo");
    } finally {
      await daemon.close();
    }
  });
});
