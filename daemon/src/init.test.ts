import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Author } from "@pitstop/protocol";
import { commit } from "./commit.js";
import { configFrom, daemonEnv, findWorktree, loadConfig, readFileConfig, writeFileConfig } from "./config.js";
import { Daemon } from "./daemon.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { init, OtherCheckout } from "./init.js";
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
    // The token follows the server: the file's goes to the file's server only.
    const elsewhere = await loadConfig({ PITSTOP_SERVER: "http://localhost:9090", PITSTOP_REPO: "other/repo" }, worktree);
    expect(elsewhere).toMatchObject({ serverUrl: "http://localhost:9090", repo: "other/repo" });
    expect(elsewhere.token).toBeUndefined();
    expect((await loadConfig({ PITSTOP_SERVER: "http://localhost:9090", PITSTOP_TOKEN: "t9" }, worktree)).token).toBe("t9");
    // A shell token meant for another server does not beat the file's; the same server named again changes nothing.
    expect((await loadConfig({ PITSTOP_TOKEN: "hosted" }, worktree)).token).toBe("t1");
    expect((await loadConfig({ PITSTOP_SERVER: "https://pitstop.example", PITSTOP_TOKEN: "hosted" }, worktree)).token).toBe("t1");
    // Without a token in the file, the environment's is used.
    expect(configFrom({ serverUrl: "https://a" }, { PITSTOP_TOKEN: "t2" }, worktree).token).toBe("t2");
  });

  it("gives a checkout's background daemon the checkout's own server, repository, token and agent", () => {
    const file = { serverUrl: "http://localhost:8132", token: "y-token", repo: "team/app", agent: "carol-claude" };
    const shell = { PATH: "p", PITSTOP_TOKEN: "x-hosted", PITSTOP_SERVER: "https://hosted", PITSTOP_REPO: "a/b", PITSTOP_AGENT: "alice" };
    expect(daemonEnv(file, shell)).toEqual({ PATH: "p", PITSTOP_TOKEN: "y-token", PITSTOP_SERVER: "http://localhost:8132", PITSTOP_REPO: "team/app", PITSTOP_AGENT: "carol-claude" });
    // No token in the file: a shell token for another server is dropped, one for this server kept.
    expect(daemonEnv({ serverUrl: "http://localhost:8132" }, shell).PITSTOP_TOKEN).toBeUndefined();
    expect(daemonEnv({ serverUrl: "http://localhost:8132" }, { PITSTOP_TOKEN: "t", PITSTOP_SERVER: "http://localhost:8132/" }).PITSTOP_TOKEN).toBe("t");
    expect(daemonEnv({ serverUrl: "http://localhost:8132" }, { PITSTOP_TOKEN: "t" }).PITSTOP_TOKEN).toBe("t");
  });

  it("finds the checkout at or above a directory, and nothing outside one", async () => {
    await mkdir(join(worktree, "src", "deep"), { recursive: true });
    expect(findWorktree(join(worktree, "src", "deep"))).toBeUndefined();
    await mkdir(join(worktree, ".pitstop"), { recursive: true });
    await writeFile(join(worktree, ".pitstop", "config.json"), "{}");
    expect(findWorktree(join(worktree, "src", "deep"))).toBe(worktree);
    expect(findWorktree(worktree)).toBe(worktree);
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

  it("never re-points a checkout of another repository or server, and keeps what else its config holds", async () => {
    await writeFileConfig(worktree, { serverUrl: server.url, token: "t1", repo: "teamdb/demo", agent: "alice-claude" });
    await expect(init({ serverUrl: server.url, repo: "teamdb/other", worktree, applier, author })).rejects.toBeInstanceOf(OtherCheckout);
    await expect(init({ serverUrl: "http://elsewhere:1", repo: "teamdb/demo", worktree, applier, author })).rejects.toThrow(
      /already a Pitstop checkout of teamdb\/demo on .*; its \.pitstop\/config\.json was left as it is/,
    );
    await expect(init({ serverUrl: server.url, worktree, applier, author })).rejects.toBeInstanceOf(OtherCheckout);
    expect(await readFileConfig(worktree)).toEqual({ serverUrl: server.url, token: "t1", repo: "teamdb/demo", agent: "alice-claude" });
    expect(server.commits).toEqual([]);

    await init({ serverUrl: `${server.url}/`, repo: "teamdb/demo", worktree, applier, author, noImport: true });
    expect(await readFileConfig(worktree)).toEqual({ serverUrl: server.url, token: "t1", repo: "teamdb/demo", agent: "alice-claude" });
  });

  it("imports main's tree instead of @ when asked", async () => {
    applier.trees = { main: new Map([["src/a.ts", "export const a = 1;\n"]]), "@": new Map([["src/a.ts", "export const a = 2; // WIP\n"], ["secret.env", "KEY=x\n"]]) };
    await init({ serverUrl: server.url, repo: "teamdb/demo", worktree, applier, author, importFrom: "main" });
    expect(server.commits[0]?.files.map((f) => [f.path, f.content])).toEqual([["src/a.ts", "export const a = 1;\n"]]);
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
