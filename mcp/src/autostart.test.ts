import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonRunning, ensureDaemon, findWorktree, pitstopCommand, type Spawn } from "./autostart.js";
import { DaemonClient } from "./client.js";
import { safePointHook } from "./hook.js";
import { makeTools } from "./tools.js";

/** What `pitstop start` leaves behind: a daemon answering /status (and a safe point) with daemon.json naming it. */
async function daemonUp(worktree: string): Promise<() => Promise<void>> {
  const http: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/safe-point") res.end(JSON.stringify({ applied: [7], pending: 0, notes: ['#7 "y" touched src/b.ts'] }));
    else res.end(JSON.stringify({ pid: process.pid, appliedLsn: 7, headLsn: 7, pending: 0, attached: true, intent: null, openIntents: [], worktree }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  await writeFile(join(worktree, ".pitstop", "daemon.json"), JSON.stringify({ port, pid: process.pid, startedAt: "" }));
  return () => new Promise<void>((r) => http.close(() => r()));
}

describe("starting the daemon from the agent side", () => {
  let base: string;
  let worktree: string;
  let closers: (() => Promise<void>)[];
  const command = { command: "node", args: ["/x/pitstop.js"] };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "pitstop-auto-"));
    worktree = join(base, "app");
    await mkdir(join(worktree, ".pitstop"), { recursive: true });
    await writeFile(join(worktree, ".pitstop", "config.json"), JSON.stringify({ serverUrl: "http://x", repo: "team/app" }));
    closers = [];
  });
  afterEach(async () => {
    for (const close of closers) await close();
    await rm(base, { recursive: true, force: true, maxRetries: 5 });
  });

  /** A spawn that records its calls and, unless told otherwise, brings a daemon up shortly after. */
  const spawner = (bringUp = true) => {
    const calls: { command: string; args: string[]; options: Parameters<Spawn>[2] }[] = [];
    const spawn: Spawn = (cmd, args, options) => {
      calls.push({ command: cmd, args, options });
      if (bringUp) setTimeout(() => void daemonUp(worktree).then((c) => closers.push(c)), 150);
      return { once: () => undefined, unref: () => undefined };
    };
    return { calls, spawn };
  };

  it("finds the checkout from a directory inside it", async () => {
    await mkdir(join(worktree, "src", "deep"), { recursive: true });
    expect(findWorktree(join(worktree, "src", "deep"))).toBe(worktree);
    expect(findWorktree(base)).toBe(base);
  });

  it("finds the pitstop CLI next to the MCP server: the repository's daemon from source or dist", async () => {
    const fakeRepo = join(base, "repo");
    await mkdir(join(fakeRepo, "daemon", "src"), { recursive: true });
    await mkdir(join(fakeRepo, "daemon", "dist"), { recursive: true });
    expect(pitstopCommand(join(fakeRepo, "mcp", "dist", "index.js"))).toBeUndefined();
    await writeFile(join(fakeRepo, "daemon", "dist", "index.js"), "");
    expect(pitstopCommand(join(fakeRepo, "mcp", "dist", "index.js"))).toEqual({ command: process.execPath, args: [join(fakeRepo, "daemon", "dist", "index.js")] });
    await writeFile(join(fakeRepo, "daemon", "src", "index.ts"), "");
    expect(pitstopCommand(join(fakeRepo, "mcp", "src", "index.ts"))?.args.at(-1)).toBe(join(fakeRepo, "daemon", "src", "index.ts"));
  });

  it("runs `pitstop start` detached in the checkout, waits for the daemon, and leaves a running one alone", async () => {
    const { calls, spawn } = spawner();
    expect(await ensureDaemon(worktree, { spawn, command, waitMs: 5_000 })).toBe("started");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "node", args: ["/x/pitstop.js", "start"], options: { cwd: worktree, detached: true, windowsHide: true } });
    expect(await daemonRunning(worktree)).toBe(true);
    expect(await ensureDaemon(worktree, { spawn, command })).toBe("running");
    expect(calls).toHaveLength(1);
  });

  it("does nothing outside a Pitstop checkout", async () => {
    const { calls, spawn } = spawner();
    expect(await ensureDaemon(base, { spawn, command })).toBe("not-set-up");
    expect(calls).toHaveLength(0);
  });

  it("gives up within its wait, and does not try again on every call while a start just failed", async () => {
    const { calls, spawn } = spawner(false);
    const t0 = Date.now();
    expect(await ensureDaemon(worktree, { spawn, command, waitMs: 400 })).toBe("waiting");
    expect(Date.now() - t0).toBeLessThan(2_000);
    const t1 = Date.now();
    expect(await ensureDaemon(worktree, { spawn, command, waitMs: 400 })).toBe("waiting");
    expect(Date.now() - t1).toBeLessThan(300);
    expect(calls).toHaveLength(1);
    // after the retry pause it tries again
    expect(await ensureDaemon(worktree, { spawn, command, waitMs: 400, retryMs: 0 })).toBe("waiting");
    expect(calls).toHaveLength(2);
  });

  it("the hook starts a missing daemon and still reports the safe point", async () => {
    const { calls, spawn } = spawner();
    const out = await safePointHook({ cwd: join(worktree) }, {}, { ensureDaemon: async (w) => (await ensureDaemon(w, { spawn, command, waitMs: 3_000 })) === "started" });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toBe('Pitstop applied #7 to this worktree.\n#7 "y" touched src/b.ts');
  });

  it("the hook stays silent when no daemon comes up", async () => {
    const { spawn } = spawner(false);
    expect(await safePointHook({ cwd: worktree }, {}, { ensureDaemon: async (w) => (await ensureDaemon(w, { spawn, command, waitMs: 300 })) === "started" })).toBe("");
  });

  it("a tool that finds no daemon starts one and answers; when none comes up it says where to look", async () => {
    const { spawn } = spawner();
    const tools = makeTools(new DaemonClient(worktree), { ensureDaemon: async () => (await ensureDaemon(worktree, { spawn, command, waitMs: 5_000 })) === "started" });
    expect((await tools.status()).text).toMatch(/is at #7 \(head #7\)/);

    const nothing = makeTools(new DaemonClient(join(base, "nowhere")), { ensureDaemon: async () => false });
    expect(await nothing.status()).toMatchObject({ isError: true, text: expect.stringMatching(/run `pitstop start` there\. Starting one did not work: \.pitstop\/daemon\.log/) });
  });
});
