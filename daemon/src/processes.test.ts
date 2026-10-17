import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonInfoPath, readDaemonInfo } from "./daemon.js";
import { liveDaemon, startDaemon, stopDaemon, type ChildLike, type Spawn } from "./processes.js";
import { removeDir, tempDir, waitFor } from "./test-support.js";

/** Answers /status the way a daemon does, and writes daemon.json for it. */
async function fakeDaemonApi(worktree: string, pid = process.pid): Promise<{ port: number; close: () => Promise<void> }> {
  const http: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ pid, worktree }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  await mkdir(join(worktree, ".pitstop"), { recursive: true });
  await writeFile(daemonInfoPath(worktree), JSON.stringify({ port, pid, startedAt: "now" }));
  return { port, close: () => new Promise<void>((r) => http.close(() => r())) };
}

const child = (onExit?: (exit: (code: number) => void) => void): ChildLike => ({
  pid: 4242,
  once(event: string, listener: (arg: never) => void) {
    if (event === "exit" && onExit) onExit((code) => (listener as (code: number) => void)(code));
    return this;
  },
  unref() {},
});

describe("the daemon as a background process", () => {
  let worktree: string;
  let closers: (() => Promise<void>)[] = [];
  beforeEach(async () => {
    worktree = await tempDir();
    closers = [];
  });
  afterEach(async () => {
    for (const close of closers) await close();
    await removeDir(worktree);
  });

  it("starts it detached and hidden in the worktree with its output in .pitstop/daemon.log, once", async () => {
    const calls: { command: string; args: string[]; options: Parameters<Spawn>[2] }[] = [];
    const fake: Spawn = (command, args, options) => {
      calls.push({ command, args, options });
      void fakeDaemonApi(worktree).then((d) => closers.push(d.close));
      return child();
    };
    const started = await startDaemon(worktree, { spawn: fake, command: { command: "node", args: ["pitstop.js", "daemon"] }, env: { A: "1" } });
    expect(started).toMatchObject({ started: true, info: { pid: process.pid }, log: join(worktree, ".pitstop", "daemon.log") });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: "node", args: ["pitstop.js", "daemon"], options: { cwd: worktree, detached: true, windowsHide: true, env: { A: "1" } } });
    const stdio = calls[0]?.options.stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    expect(typeof stdio[1]).toBe("number");
    expect(existsSync(join(worktree, ".pitstop", "daemon.log"))).toBe(true);
    expect(existsSync(join(worktree, ".pitstop", "starting"))).toBe(false);

    const again = await startDaemon(worktree, { spawn: fake });
    expect(again.started).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("starts one daemon when two starters race", async () => {
    let spawns = 0;
    const fake: Spawn = () => {
      spawns++;
      setTimeout(() => void fakeDaemonApi(worktree).then((d) => closers.push(d.close)), 300);
      return child();
    };
    const command = { command: "node", args: ["x"] };
    const [a, b] = await Promise.all([startDaemon(worktree, { spawn: fake, command }), startDaemon(worktree, { spawn: fake, command })]);
    expect(spawns).toBe(1);
    expect([a.started, b.started].sort()).toEqual([false, true]);
  });

  it("says why when the daemon exits before it answers", async () => {
    const fake: Spawn = () =>
      child((exit) => {
        void writeFile(join(worktree, ".pitstop", "daemon.log"), "[pitstop] stream error: nope\n").then(() => exit(1));
      });
    await expect(startDaemon(worktree, { spawn: fake, command: { command: "node", args: ["x"] } })).rejects.toThrow(/exited with 1[\s\S]*stream error: nope/);
  });

  it("does not trust a daemon.json whose process is gone or is someone else", async () => {
    await mkdir(join(worktree, ".pitstop"), { recursive: true });
    await writeFile(daemonInfoPath(worktree), JSON.stringify({ port: 1, pid: 2 ** 22 + 7, startedAt: "" }));
    expect(await liveDaemon(worktree)).toBeUndefined();
    // a live pid (this one) whose port answers for another process
    const other = await fakeDaemonApi(worktree, process.pid + 1);
    closers.push(other.close);
    await writeFile(daemonInfoPath(worktree), JSON.stringify({ port: other.port, pid: process.pid, startedAt: "" }));
    expect(await liveDaemon(worktree)).toBeUndefined();
    // stop removes the stale file and signals nobody
    expect(await stopDaemon(worktree)).toBeUndefined();
    expect(await readDaemonInfo(worktree)).toBeUndefined();
  });

  it("stops a running daemon", async () => {
    // A process that behaves like a daemon: answers /status with its pid, written to daemon.json.
    const script = `
      const http = require("node:http"); const fs = require("node:fs");
      const s = http.createServer((q, r) => { r.end(JSON.stringify({ pid: process.pid })); });
      s.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[1], JSON.stringify({ port: s.address().port, pid: process.pid, startedAt: "" })));`;
    await mkdir(join(worktree, ".pitstop"), { recursive: true });
    const proc = spawn(process.execPath, ["-e", script, daemonInfoPath(worktree)], { stdio: "ignore", windowsHide: true });
    const exited = new Promise((r) => proc.once("exit", r));
    await waitFor(async () => (await liveDaemon(worktree)) !== undefined, 10_000);
    expect(await stopDaemon(worktree)).toBe(proc.pid);
    await exited;
    expect(await readFile(daemonInfoPath(worktree), "utf8").catch(() => "gone")).toBe("gone");
  });
});
