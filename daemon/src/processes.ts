/**
 * The daemon as a background process: is one running in a worktree, start one detached, stop it.
 * `pitstop setup`, `pitstop start` and `pitstop stop` use these; the MCP server and the hook in
 * mcp/ start a daemon by running `pitstop start` (mcp/src/autostart.ts).
 */
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED } from "./build-info.js";
import { daemonInfoPath, readDaemonInfo, type DaemonInfo } from "./daemon.js";
import { STATE_DIR, stateDir } from "./state.js";

export const DAEMON_LOG = "daemon.log";
export const START_LOCK = "starting";

export const daemonLogPath = (worktree: string): string => join(worktree, STATE_DIR, DAEMON_LOG);

/** Whether a process with this id exists (EPERM: it does, and belongs to someone else). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The worktree's daemon when one is running: `.pitstop/daemon.json`, a live pid, and its local API
 * answering `/status` with that same pid. A daemon killed hard leaves the file behind, and its pid
 * may since belong to another process, so the file alone proves nothing.
 */
export async function liveDaemon(worktree: string, fetchImpl: typeof fetch = fetch): Promise<DaemonInfo | undefined> {
  const info = await readDaemonInfo(worktree);
  if (info === undefined || !isAlive(info.pid)) return undefined;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/status`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return undefined;
    const status = (await res.json()) as { pid?: unknown };
    return status.pid === info.pid ? info : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How to run this CLI's `daemon` command as a child: the bundle itself (packages/cli), or index.js
 * (index.ts under tsx, with the same loader flags) next to this file.
 */
export function daemonCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (BUNDLED) return { command: process.execPath, args: [here, "daemon"] };
  return { command: process.execPath, args: [...process.execArgv, join(dirname(here), `index${extname(here)}`), "daemon"] };
}

/** The part of a ChildProcess this file uses, so tests can hand in a fake. */
export interface ChildLike {
  pid?: number | undefined;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

export interface StartOptions {
  /** The daemon's environment; default this process's. */
  env?: NodeJS.ProcessEnv;
  spawn?: Spawn;
  command?: { command: string; args: string[] };
  /** How long to wait for the daemon to answer; default 20 s. */
  waitMs?: number;
  fetch?: typeof fetch;
}

export interface Started {
  info: DaemonInfo;
  /** False when a daemon was already running (or another process started it meanwhile). */
  started: boolean;
  log: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The last lines of the daemon's log, for an error message. */
export function logTail(worktree: string, lines = 15): string {
  try {
    return readFileSync(daemonLogPath(worktree), "utf8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

/**
 * Starts `pitstop daemon` in the worktree unless one is running: detached, without a window, its
 * output appended to `.pitstop/daemon.log`, so it outlives whoever started it. Waits until it
 * answers. `.pitstop/starting` keeps two starters (the MCP server and the hook, say) from starting
 * two daemons; the second one waits for the first one's daemon.
 */
export async function startDaemon(worktree: string, opts: StartOptions = {}): Promise<Started> {
  const log = daemonLogPath(worktree);
  const running = await liveDaemon(worktree, opts.fetch);
  if (running !== undefined) return { info: running, started: false, log };

  const lock = join(await stateDir(worktree), START_LOCK);
  const waitMs = opts.waitMs ?? 20_000;
  const until = Date.now() + waitMs;
  const ours = await takeLock(lock, waitMs);
  let exited: string | undefined;
  try {
    if (ours) {
      const out = openSync(log, "a");
      try {
        const { command, args } = opts.command ?? daemonCommand();
        const child = (opts.spawn ?? (nodeSpawn as unknown as Spawn))(command, args, {
          cwd: worktree,
          env: opts.env ?? process.env,
          detached: true,
          stdio: ["ignore", out, out],
          windowsHide: true,
        });
        child.once("exit", (code) => {
          exited = `exited with ${code ?? "a signal"}`;
        });
        child.once("error", (err) => {
          exited = `could not start: ${err.message}`;
        });
        child.unref();
      } finally {
        closeSync(out);
      }
    }
    for (;;) {
      const info = await liveDaemon(worktree, opts.fetch);
      if (info !== undefined) return { info, started: ours, log };
      if (exited !== undefined) throw new Error(`the daemon ${exited} before it was ready. ${log}:\n${logTail(worktree)}`);
      if (Date.now() > until) throw new Error(`the daemon did not answer within ${Math.round(waitMs / 1000)}s. ${log}:\n${logTail(worktree)}`);
      await sleep(100);
    }
  } finally {
    if (ours) await rm(lock, { force: true });
  }
}

/** True when this process now holds the start lock; false when another starter does. A lock older than `staleMs` is taken over. */
async function takeLock(lock: string, staleMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age <= staleMs) return false;
      await rm(lock, { force: true });
    }
  }
  return false;
}

/**
 * Stops the worktree's daemon. Only a daemon that answers as itself is signalled: a pid left in a
 * stale daemon.json may belong to an unrelated process by now. Returns its pid, or undefined when
 * none was running (a stale daemon.json is removed).
 */
export async function stopDaemon(worktree: string, opts: { fetch?: typeof fetch; waitMs?: number } = {}): Promise<number | undefined> {
  const info = await liveDaemon(worktree, opts.fetch);
  if (info === undefined) {
    await rm(daemonInfoPath(worktree), { force: true });
    return undefined;
  }
  process.kill(info.pid, "SIGTERM");
  const until = Date.now() + (opts.waitMs ?? 5_000);
  while (isAlive(info.pid) && Date.now() < until) await sleep(100);
  // On Windows the signal ends the process at once, so it cannot remove its own file.
  await rm(daemonInfoPath(worktree), { force: true });
  return info.pid;
}
