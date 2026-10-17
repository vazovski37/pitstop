import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
}

export const STATE_DIR = ".pitstop";
export const STATE_FILE = "state.json";

export const statePath = (worktree: string): string => join(worktree, STATE_DIR, STATE_FILE);

const isLsn = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The worktree's state; `appliedLsn: 0` when the daemon has never run here. */
export async function readState(worktree: string): Promise<State> {
  let text: string;
  try {
    text = await readFile(statePath(worktree), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { appliedLsn: 0 };
    throw err;
  }
  const raw = JSON.parse(text) as { appliedLsn?: unknown; readBaseLsn?: unknown } | null;
  const appliedLsn = raw?.appliedLsn;
  const readBaseLsn = raw?.readBaseLsn;
  if (!isLsn(appliedLsn) || (readBaseLsn !== undefined && !isLsn(readBaseLsn))) {
    throw new Error(`${statePath(worktree)} is not a daemon state file`);
  }
  return readBaseLsn === undefined ? { appliedLsn } : { appliedLsn, readBaseLsn };
}

/**
 * Writes the state atomically (temp file, then rename), so a crash never leaves a half-written file.
 * The temp name is unique per writer: the daemon and `pitstop commit` are separate processes.
 * The directory ignores itself, so neither git nor jj ever see the state as a change to commit.
 */
export async function writeState(worktree: string, state: State): Promise<void> {
  const dir = join(worktree, STATE_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n");
  const target = statePath(worktree);
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, target);
}
