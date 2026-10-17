import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** What the daemon remembers between runs. */
export interface State {
  /** The last log entry applied to this worktree. */
  appliedLsn: number;
  /**
   * The applied LSN when the agent's current work in `@` began, recorded by the daemon the first
   * time it applies an entry over unfinished edits. Sent as `readBaseLsn` with the commit, so the
   * server checks the agent's reads from there; cleared when the commit lands.
   */
  readBaseLsn?: number;
  /** The open intent declared for the current task; heartbeats keep it alive, the next commit closes it. */
  intentId?: string;
}

export const STATE_DIR = ".pitstop";
export const STATE_FILE = "state.json";
export const LOCK_FILE = "lock";

export const statePath = (worktree: string): string => join(worktree, STATE_DIR, STATE_FILE);

/** The daemon state directory, created on demand and ignored by git and jj. */
export async function stateDir(worktree: string): Promise<string> {
  const dir = join(worktree, STATE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n");
  return dir;
}

/**
 * Runs `fn` while holding the worktree's lock, so the daemon and `pitstop commit` never apply at
 * the same time: the server pushes an accepted entry on the stream before it answers the commit,
 * so both would otherwise move `main` for the same entry. Whoever gets the lock second re-reads
 * the state and finds the entry applied. A lock older than `staleMs` belongs to a dead process
 * and is taken over.
 */
export async function withWorktreeLock<T>(worktree: string, fn: () => Promise<T>, staleMs = 60_000): Promise<T> {
  const lock = join(await stateDir(worktree), LOCK_FILE);
  const until = Date.now() + staleMs;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`${lock} has been held by another pitstop process for over ${staleMs / 1000}s`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { force: true });
  }
}

const isLsn = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The worktree's state; `appliedLsn: 0` when the daemon has never run here. */
export async function readState(worktree: string): Promise<State> {
  let text: string | undefined;
  // Another pitstop process may be renaming a fresh state file into place right now; on Windows
  // that shows as EPERM or EBUSY for a moment.
  for (let attempt = 0; ; attempt++) {
    try {
      text = await readFile(statePath(worktree), "utf8");
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { appliedLsn: 0 };
      if ((code === "EPERM" || code === "EBUSY") && attempt < 20) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      throw err;
    }
  }
  const raw = JSON.parse(text) as { appliedLsn?: unknown; readBaseLsn?: unknown; intentId?: unknown } | null;
  const appliedLsn = raw?.appliedLsn;
  const readBaseLsn = raw?.readBaseLsn;
  const intentId = raw?.intentId;
  if (
    !isLsn(appliedLsn) ||
    (readBaseLsn !== undefined && !isLsn(readBaseLsn)) ||
    (intentId !== undefined && typeof intentId !== "string")
  ) {
    throw new Error(`${statePath(worktree)} is not a daemon state file`);
  }
  return {
    appliedLsn,
    ...(readBaseLsn === undefined ? {} : { readBaseLsn }),
    ...(intentId === undefined ? {} : { intentId }),
  };
}

/**
 * Writes the state atomically (temp file, then rename), so a crash never leaves a half-written file.
 * The temp name is unique per writer: the daemon and `pitstop commit` are separate processes.
 * The directory ignores itself, so neither git nor jj ever see the state as a change to commit.
 */
export async function writeState(worktree: string, state: State): Promise<void> {
  await stateDir(worktree);
  const target = statePath(worktree);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  // On Windows the rename fails with EPERM while any other handle (a reader in the daemon, the
  // CLI, a test) still has the old file open; that lasts milliseconds, so wait it out.
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "EACCES") && attempt < 50) {
        await new Promise((r) => setTimeout(r, 10));
        continue;
      }
      await rm(tmp, { force: true });
      throw err;
    }
  }
}
