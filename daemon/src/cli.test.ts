import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileConfig } from "./config.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { liveDaemon, stopDaemon } from "./processes.js";
import { removeDir, tempDir, waitFor } from "./test-support.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const loader = pathToFileURL(join(root, "node_modules", "tsx", "dist", "loader.mjs")).href;

/** The shell a user (or Claude Code) runs the CLI from: none of this process's PITSTOP_ settings, plus `extra`. */
const shell = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PITSTOP_"))),
  ...extra,
});

/** `pitstop <args>` from source in `cwd`: its exit code and output. */
const pitstop = (args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["--import", loader, join(root, "daemon", "src", "index.ts"), ...args], { cwd, env, windowsHide: true }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
      resolve({ code, out: `${stdout}${stderr}` });
    });
  });

describe("the CLI acts on the checkout around the current directory", { timeout: 90_000 }, () => {
  let server: FakeServer;
  let checkout: string;
  let outside: string;

  beforeEach(async () => {
    server = await startFakeServer({ messages: [{ type: "hello", serverVersion: "x", headLsn: 0 }], token: "y-token-for-this-server", repos: ["team/app"] });
    checkout = await tempDir();
    outside = await tempDir();
  });
  afterEach(async () => {
    await stopDaemon(checkout).catch(() => undefined);
    await server.close();
    await removeDir(checkout);
    await removeDir(outside);
  });

  it("start, status and stop from src/ reach the checkout's daemon, which uses the checkout's token, not the shell's", async () => {
    await writeFileConfig(checkout, { serverUrl: server.url, token: "y-token-for-this-server", repo: "team/app", agent: "carol-claude" });
    const src = join(checkout, "src");
    await mkdir(src);
    // A personal token for another server sits in the shell, as an old README told people to do.
    const env = shell({ PITSTOP_TOKEN: "x-hosted-token" });

    const started = await pitstop(["start"], src, env);
    expect(started.out).toContain(`daemon started in ${checkout}`);
    expect(started.code).toBe(0);
    expect(existsSync(join(src, ".pitstop"))).toBe(false);
    expect(await liveDaemon(checkout)).toBeDefined();
    // The fake server answers only this checkout's token: a subscribe means the daemon sent it.
    await waitFor(() => server.received.some((m) => m.type === "subscribe"), 30_000);
    expect(server.received.find((m) => m.type === "subscribe")).toMatchObject({ repo: "team/app" });

    const status = await pitstop(["status"], src, env);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ repo: "team/app" });
    const stopped = await pitstop(["stop"], src, env);
    expect(stopped.out).toMatch(/stopped the daemon \(pid \d+\)/);
    expect(await liveDaemon(checkout)).toBeUndefined();
  });

  it("start and daemon outside any checkout refuse, instead of following some server's default repository", async () => {
    for (const command of ["start", "daemon"]) {
      const r = await pitstop([command], outside, shell({}));
      expect(r.code).toBe(1);
      expect(r.out).toContain("is not inside a Pitstop checkout");
    }
    expect(existsSync(join(outside, ".pitstop"))).toBe(false);
  });
});
