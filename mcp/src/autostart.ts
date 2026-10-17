/**
 * The agent side starts the worktree's daemon when none is running, so opening Claude Code in a
 * checkout is enough: the MCP server asks at startup and when a tool finds no daemon, the hook when
 * a safe point finds none. Starting means running `pitstop start` in the checkout, detached; that
 * command starts the daemon detached with its output in `.pitstop/daemon.log`, and its lock
 * (`.pitstop/starting`) keeps two starters from starting two daemons (daemon/src/processes.ts).
 */
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED } from "./build-info.js";

const PITSTOP = ".pitstop";
const configFile = (worktree: string) => join(worktree, PITSTOP, "config.json");

/** The checkout `start` is in: the nearest directory at or above it with `.pitstop/config.json`, else `start`. */
export function findWorktree(start: string): string {
  const from = resolve(start);
  for (let dir = from; ; ) {
    if (existsSync(configFile(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/**
 * How to run the `pitstop` CLI: `pitstop.js` next to this file in the bundle (packages/cli), else
 * the daemon of this repository (src under tsx, with the same loader flags; dist otherwise).
 */
export function pitstopCommand(here: string = fileURLToPath(import.meta.url)): { command: string; args: string[] } | undefined {
  if (BUNDLED) {
    const bundle = join(dirname(here), "pitstop.js");
    return existsSync(bundle) ? { command: process.execPath, args: [bundle] } : undefined;
  }
  const daemon = join(dirname(here), "..", "..", "daemon");
  const src = join(daemon, "src", "index.ts");
  if (extname(here) === ".ts" && existsSync(src)) return { command: process.execPath, args: [...process.execArgv, src] };
  const dist = join(daemon, "dist", "index.js");
  return existsSync(dist) ? { command: process.execPath, args: [dist] } : undefined;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Whether the worktree's daemon answers: `.pitstop/daemon.json`, a live pid, and `/status` naming that pid. */
export async function daemonRunning(worktree: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  let info: { port?: unknown; pid?: unknown };
  try {
    info = JSON.parse(await readFile(join(worktree, PITSTOP, "daemon.json"), "utf8")) as typeof info;
  } catch {
    return false;
  }
  if (typeof info.port !== "number" || typeof info.pid !== "number" || !alive(info.pid)) return false;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${info.port}/status`, { signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return false;
    return ((await res.json()) as { pid?: unknown }).pid === info.pid;
  } catch {
    return false;
  }
}

export interface ChildLike {
  once(event: "error", listener: (err: Error) => void): unknown;
  unref(): void;
}

export type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildLike;

export interface EnsureOptions {
  /** How long to wait for the daemon to answer; the hook keeps this short. Default 20 s. */
  waitMs?: number;
  /** After a start that did not bring a daemon up, how long to leave it before trying again. Default 30 s. */
  retryMs?: number;
  spawn?: Spawn;
  command?: { command: string; args: string[] };
  fetch?: typeof fetch;
}

/**
 * running: a daemon answers. started: this call started one and it answers. not-set-up: no
 * `.pitstop/config.json`, so not a Pitstop checkout. no-cli: no `pitstop` to run. waiting: a start
 * is under way (or failed a moment ago) and no daemon answered within `waitMs`.
 */
export type EnsureResult = "running" | "started" | "not-set-up" | "no-cli" | "waiting";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ageMs = (path: string): Promise<number | undefined> =>
  stat(path).then(
    (s) => Date.now() - s.mtimeMs,
    () => undefined,
  );

/** Starts the worktree's daemon unless one answers, then waits up to `waitMs` for it. Never throws. */
export async function ensureDaemon(worktree: string, opts: EnsureOptions = {}): Promise<EnsureResult> {
  const fetchImpl = opts.fetch ?? fetch;
  const waitMs = opts.waitMs ?? 20_000;
  const retryMs = opts.retryMs ?? 30_000;
  try {
    if (await daemonRunning(worktree, fetchImpl)) return "running";
    if (!existsSync(configFile(worktree))) return "not-set-up";

    const starting = await ageMs(join(worktree, PITSTOP, "starting"));
    const attempted = await ageMs(join(worktree, PITSTOP, "autostart"));
    let spawned = false;
    if (starting === undefined || starting > retryMs) {
      // A start from a moment ago that brought nothing up: do not try again on every tool call.
      if (attempted !== undefined && attempted < retryMs) return "waiting";
      const cmd = opts.command ?? pitstopCommand();
      if (cmd === undefined) return "no-cli";
      await writeFile(join(worktree, PITSTOP, "autostart"), `${new Date().toISOString()}\n`);
      // Its own output (a start that failed says why) goes where the daemon's does.
      const out = openSync(join(worktree, PITSTOP, "daemon.log"), "a");
      try {
        const child = (opts.spawn ?? (nodeSpawn as unknown as Spawn))(cmd.command, [...cmd.args, "start"], {
          cwd: worktree,
          detached: true,
          stdio: ["ignore", out, out],
          windowsHide: true,
        });
        child.once("error", () => undefined);
        child.unref();
      } finally {
        closeSync(out);
      }
      spawned = true;
    }
    const until = Date.now() + waitMs;
    while (Date.now() < until) {
      await sleep(100);
      if (await daemonRunning(worktree, fetchImpl)) return spawned ? "started" : "running";
    }
    return "waiting";
  } catch {
    return "waiting";
  }
}
