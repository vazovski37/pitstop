import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Changeset, type ServerMessage } from "@pitstop/protocol";
import { readFileConfig } from "./config.js";
import { run } from "./exec.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { binariesFromEnv, blobHash } from "./jj.js";
import { liveDaemon, startDaemon, stopDaemon, type Started } from "./processes.js";
import { checkTools, defaultAgent, setup, SetupStopped, type SetupHooks } from "./setup.js";
import { readState } from "./state.js";
import { entryAt, FakeApplier, removeDir, tempDir } from "./test-support.js";

const bin = binariesFromEnv();
const works = (b: string) =>
  run(b, ["--version"], { cwd: process.cwd() }).then(
    () => true,
    () => false,
  );
const hasGit = await works(bin.git);
const hasJj = hasGit && (await works(bin.jj));

const importEntry: Changeset = entryAt(1, {
  repo: "team/app",
  baseLsn: 0,
  intent: "import app",
  files: [{ path: "src/a.ts", op: "add", content: "export const a = 1;\n", blob: blobHash("export const a = 1;\n") }],
  writeSet: [],
  sigWriteSet: [],
  readSet: [],
});
const oneEntry: ServerMessage[] = [{ type: "hello", serverVersion: "x", headLsn: 1 }, { type: "entry", changeset: importEntry }];
const empty: ServerMessage[] = [{ type: "hello", serverVersion: "x", headLsn: 0 }];

const fakeStarted = (dir: string): Started => ({ info: { port: 1, pid: 99, startedAt: "" }, started: true, log: join(dir, ".pitstop", "daemon.log") });

describe("pitstop setup: the tool check", () => {
  const ctx = { cwd: process.cwd(), log: () => undefined };

  it("names what to install for each platform and stops", async () => {
    const none = { jj: "pitstop-test-no-jj", git: "pitstop-test-no-git", mergiraf: "x" };
    const win = checkTools({ ...ctx, bin: none, platform: "win32", nodeVersion: "22.10.0" });
    await expect(win).rejects.toBeInstanceOf(SetupStopped);
    await expect(win).rejects.toThrow(/git: winget install Git\.Git[\s\S]*jj \(Jujutsu\): winget install jj-vcs\.jj/);
    await expect(checkTools({ ...ctx, bin: none, platform: "darwin", nodeVersion: "22.10.0" })).rejects.toThrow(/brew install jj/);
    await expect(checkTools({ ...ctx, bin: none, platform: "linux", nodeVersion: "22.10.0" })).rejects.toThrow(/cargo binstall jj-cli/);
  });

  it("wants Node 22 or newer", async () => {
    await expect(checkTools({ ...ctx, bin, platform: "linux", nodeVersion: "20.11.1" })).rejects.toThrow(/Node\.js 22 or newer; this is 20\.11\.1/);
  });

  it.skipIf(!hasJj)("takes jj's identity from git when jj has none, without touching the real jj config", async () => {
    const dir = await tempDir();
    const saved = { JJ_USER: process.env.JJ_USER, JJ_EMAIL: process.env.JJ_EMAIL, JJ_CONFIG: process.env.JJ_CONFIG };
    try {
      delete process.env.JJ_USER;
      delete process.env.JJ_EMAIL;
      process.env.JJ_CONFIG = join(dir, "jj-config.toml");
      await run(bin.git, ["init", "-q"], { cwd: dir });
      await run(bin.git, ["config", "user.name", "Test Person"], { cwd: dir });
      await run(bin.git, ["config", "user.email", "test@example.com"], { cwd: dir });
      const lines: string[] = [];
      await checkTools({ bin, cwd: dir, platform: process.platform, nodeVersion: "22.0.0", log: (l) => lines.push(l) });
      expect(await readFile(join(dir, "jj-config.toml"), "utf8")).toMatch(/Test Person[\s\S]*test@example\.com/);
      expect(lines.join("\n")).toContain('set jj\'s user.name to "Test Person" (from git)');

      // Without a git identity either, it says which two commands to run.
      await writeFile(join(dir, "jj-config.toml"), "");
      await run(bin.git, ["config", "--unset", "user.name"], { cwd: dir });
      process.env.GIT_CONFIG_GLOBAL = join(dir, "no-global");
      await expect(checkTools({ bin, cwd: dir, platform: process.platform, nodeVersion: "22.0.0", log: () => undefined })).rejects.toThrow(
        /jj config set --user user\.name "Your Name"/,
      );
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      delete process.env.GIT_CONFIG_GLOBAL;
      await removeDir(dir);
    }
  });
});

describe("pitstop setup against a fake server", () => {
  let server: FakeServer;
  let base: string;
  const noCheck: Partial<SetupHooks> = { checkTools: async () => undefined };

  afterEach(async () => {
    await server.close();
    await removeDir(base);
  });

  it("stops when the repository does not exist, and when the token is refused", async () => {
    server = await startFakeServer({ messages: empty, token: "right" });
    base = await tempDir();
    const opts = { serverUrl: server.url, cwd: base, hooks: noCheck };
    await expect(setup({ ...opts, repo: "nobody/nothing", token: "right" })).rejects.toThrow(/no repository nobody\/nothing on .*Create it on the website/);
    await expect(setup({ ...opts, repo: "nobody/nothing", token: "wrong" })).rejects.toThrow(/answered 401/);
    await expect(setup({ ...opts, repo: "Not A Repo" })).rejects.toThrow(/owner\/name/);
  });

  it.skipIf(!hasGit)("clones a repository with entries into ./<name>, wires it, records the agent and starts the daemon", async () => {
    server = await startFakeServer({ messages: oneEntry, repos: ["team/app"] });
    base = await tempDir();
    const applier = new FakeApplier();
    const starts: { dir: string; env: NodeJS.ProcessEnv }[] = [];
    const hooks: Partial<SetupHooks> = {
      ...noCheck,
      clone: { prepare: async (d) => void (await run(bin.git, ["init", "-q", "-b", "main", d], { cwd: base })), applierFor: () => applier },
      start: async (dir, env) => {
        starts.push({ dir, env });
        return fakeStarted(dir);
      },
    };
    const lines: string[] = [];
    const result = await setup({ serverUrl: `${server.url}/`, repo: "Team/App", token: "t1", cwd: base, env: { PITSTOP_SERVER: "http://stale:1" }, platform: "linux", hooks, log: (l) => lines.push(l) });
    const dir = join(base, "app");
    expect(result).toMatchObject({ dir, how: "cloned", appliedLsn: 1, agent: defaultAgent(), tracked: [] });
    expect(applier.lsns).toEqual([1]);
    expect(await readFileConfig(dir)).toEqual({ serverUrl: server.url, token: "t1", repo: "team/app", agent: defaultAgent() });
    expect(JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { pitstop: { command: "pitstop-mcp" } } });
    expect(await readFile(join(dir, ".claude", "settings.json"), "utf8")).toContain('"pitstop-hook"');
    expect(await readFile(join(dir, "CLAUDE.local.md"), "utf8")).toContain("team/app");
    expect(await readFile(join(dir, ".git", "info", "exclude"), "utf8")).toContain("/.mcp.json\n/.claude/\n/CLAUDE.local.md\n");
    // What setup was told wins over a stale shell for the daemon it starts.
    expect(starts).toHaveLength(1);
    expect(starts[0]?.env).toMatchObject({ PITSTOP_SERVER: server.url, PITSTOP_REPO: "team/app", PITSTOP_TOKEN: "t1", PITSTOP_AGENT: defaultAgent() });

    // Again from the same place: the checkout is found and reused, with a new agent name.
    const again = await setup({ serverUrl: server.url, repo: "team/app", cwd: base, agent: "laptop-b", platform: "linux", hooks });
    expect(again).toMatchObject({ dir, how: "existing", agent: "laptop-b" });
    expect(applier.lsns).toEqual([1]);
    expect(await readFileConfig(dir)).toMatchObject({ token: "t1", agent: "laptop-b" });
    // and the name sticks when setup runs once more without --agent
    expect((await setup({ serverUrl: server.url, repo: "team/app", cwd: dir, platform: "linux", hooks })).agent).toBe("laptop-b");
  });

  it.skipIf(!hasGit)("will not import an empty repository from a directory that is not a git checkout", async () => {
    server = await startFakeServer({ messages: empty, repos: ["team/app"] });
    base = await tempDir();
    await expect(setup({ serverUrl: server.url, repo: "team/app", cwd: base, hooks: noCheck })).rejects.toThrow(/has no entries yet, and .* is not a git checkout/);
  });
});

const root = fileURLToPath(new URL("../../", import.meta.url));
/** A real `pitstop daemon` from source, the way `tsx` runs it in development. */
const daemonFromSource = {
  command: process.execPath,
  args: ["--import", pathToFileURL(join(root, "node_modules", "tsx", "dist", "loader.mjs")).href, join(root, "daemon", "src", "index.ts"), "daemon"],
};

describe.skipIf(!hasJj)("pitstop setup with real git, jj and daemons", { timeout: 120_000 }, () => {
  let server: FakeServer;
  let base: string;
  const started: string[] = [];
  const hooks: Partial<SetupHooks> = {
    start: async (dir, env) => {
      started.push(dir);
      return startDaemon(dir, { env, command: daemonFromSource, waitMs: 60_000 });
    },
  };

  beforeEach(async () => {
    base = await tempDir();
    process.env.JJ_USER = "agent";
    process.env.JJ_EMAIL = "agent@test";
  });
  afterEach(async () => {
    for (const dir of started.splice(0)) await stopDaemon(dir).catch(() => undefined);
    await server?.close();
    await removeDir(base);
  });

  const gitRepo = async (dir: string, branch = "main") => {
    await mkdir(join(dir, "src"), { recursive: true });
    const git = (...args: string[]) => run(bin.git, args, { cwd: dir });
    await git("init", "-q", "-b", branch);
    await git("config", "user.name", "Dev");
    await git("config", "user.email", "dev@example.com");
    await writeFile(join(dir, "tsconfig.json"), '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n');
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
    await git("add", "-A");
    await git("commit", "-q", "-m", "first");
    return git;
  };

  it("imports a git checkout into an empty repository, then clones it elsewhere; both daemons run", async () => {
    server = await startFakeServer({ messages: empty, repos: ["team/app"] });
    const first = join(base, "first");
    await gitRepo(first);
    // Claude Code's own files, present before setup: never part of the import.
    await mkdir(join(first, ".claude"), { recursive: true });
    await writeFile(join(first, ".claude", "settings.local.json"), "{}\n");

    const result = await setup({ serverUrl: server.url, repo: "team/app", cwd: first, agent: "alice-claude", hooks });
    expect(result).toMatchObject({ dir: resolve(first), how: "imported", appliedLsn: 1, agent: "alice-claude" });
    expect(existsSync(join(first, ".jj"))).toBe(true);
    expect(server.commits[0]?.files.map((f) => f.path).sort()).toEqual(["src/a.ts", "tsconfig.json"]);
    expect(server.commits[0]?.author.agent).toBe("alice-claude");
    // jj sees none of the wiring: nothing for the agent's first commit to carry along
    expect((await run(bin.jj, ["diff", "--name-only", "-r", "@"], { cwd: first })).trim()).toBe("");
    expect(await liveDaemon(first)).toMatchObject({ pid: result.daemon.info.pid });
    expect(result.daemon.started).toBe(true);

    const elsewhere = join(base, "b");
    await mkdir(elsewhere);
    const clone = await setup({ serverUrl: server.url, repo: "team/app", cwd: elsewhere, hooks });
    const dir = join(elsewhere, "app");
    expect(clone).toMatchObject({ dir, how: "cloned", appliedLsn: 1 });
    expect(await readFile(join(dir, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await liveDaemon(dir)).toBeDefined();
    expect(JSON.parse(await readFile(join(dir, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: { pitstop: process.platform === "win32" ? { command: "cmd", args: ["/c", "pitstop-mcp"] } : { command: "pitstop-mcp" } },
    });
    expect((await run(bin.jj, ["diff", "--name-only", "-r", "@"], { cwd: dir })).trim()).toBe("");

    // Running setup again in a set-up checkout leaves the running daemon alone.
    const again = await setup({ serverUrl: server.url, repo: "team/app", cwd: dir, hooks });
    expect(again).toMatchObject({ how: "existing", daemon: { started: false, info: { pid: clone.daemon.info.pid } } });
  });

  it("refuses a checkout on another branch than main, and one without a commit, saying what to run", async () => {
    server = await startFakeServer({ messages: empty, repos: ["team/app"] });
    const dir = join(base, "master");
    await gitRepo(dir, "master");
    await expect(setup({ serverUrl: server.url, repo: "team/app", cwd: dir, hooks })).rejects.toThrow(/on branch master.*git branch -m master main/);
    expect(existsSync(join(dir, ".jj"))).toBe(false);

    const bare = join(base, "bare");
    await mkdir(bare);
    await run(bin.git, ["init", "-q", "-b", "main"], { cwd: bare });
    await writeFile(join(bare, "x.ts"), "export {};\n");
    await expect(setup({ serverUrl: server.url, repo: "team/app", cwd: bare, hooks })).rejects.toThrow(/no commit yet/);
    expect(server.commits).toEqual([]);
  });
});
