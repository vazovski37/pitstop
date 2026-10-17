/** Shared by the daemon's tests only; excluded from the build. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CommitRequest, ServerMessage, type Changeset, type FileChange } from "@pitstop/protocol";
import type { Applier, ApplyResult } from "./jj.js";
import type { Tree } from "./symbols.js";

export const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../packages/protocol/fixtures/${name}`, import.meta.url), "utf8"));

export const fixtureMessages = (): ServerMessage[] =>
  (fixture("server-messages.json") as unknown[]).map((m) => ServerMessage.parse(m));

/** The one `entry` in the shared fixture (#122). */
export const fixtureEntry = (): Changeset => {
  const m = fixtureMessages().find((x) => x.type === "entry");
  if (m?.type !== "entry") throw new Error("the fixture has no entry");
  return m.changeset;
};

/** The fixture entry moved to another LSN. */
export const entryAt = (lsn: number, patch: Partial<Changeset> = {}): Changeset => ({
  ...fixtureEntry(),
  lsn,
  baseLsn: Math.max(0, lsn - 2),
  intent: `entry #${lsn}`,
  ...patch,
});

export const fixtureCommitFiles = (): FileChange[] => CommitRequest.parse(fixture("commit-request.json")).files;

/** Records what the daemon asked it to do instead of touching a repository. */
export class FakeApplier implements Applier {
  applied: Changeset[] = [];
  /** Throw when asked to apply this LSN. */
  failOn: number | undefined;
  /** What `diffAgainstMain` reports. */
  files: FileChange[] = [];
  /** What `hasChanges` reports, on top of `files` being non-empty. */
  changes = false;
  /** What `treeFiles` reports. */
  trees: { main: Tree; "@": Tree } = { main: new Map(), "@": new Map() };

  async apply(changeset: Changeset): Promise<ApplyResult> {
    if (changeset.lsn === this.failOn) throw new Error(`cannot apply #${changeset.lsn}`);
    this.applied.push(changeset);
    return { commit: `commit-${changeset.lsn}`, conflicted: [] };
  }

  async diffAgainstMain(): Promise<FileChange[]> {
    return this.files;
  }

  async hasChanges(): Promise<boolean> {
    return this.changes || this.files.length > 0;
  }

  async treeFiles(rev: "main" | "@"): Promise<Tree> {
    return this.trees[rev];
  }

  get lsns(): number[] {
    return this.applied.map((c) => c.lsn);
  }
}

export async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pitstop-"));

/** Removes a temp worktree; retries while a daemon still touches `.pitstop` (Windows: ENOTEMPTY, EBUSY). */
export const removeDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/** The demo slice (demo/teamdb) as a tree: tsconfig.json and every file under src. */
export function demoTree(): Tree {
  const root = fileURLToPath(new URL("../../demo/teamdb/", import.meta.url));
  const tree: Tree = new Map();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else tree.set(relative(root, full).replace(/\\/g, "/"), readFileSync(full, "utf8"));
    }
  };
  tree.set("tsconfig.json", readFileSync(join(root, "tsconfig.json"), "utf8"));
  walk(join(root, "src"));
  return tree;
}

/** A copy of `tree` with `from` replaced by `to` in `path`; fails if `from` is not there. */
export function edited(tree: Tree, path: string, from: string, to: string): Tree {
  const text = tree.get(path);
  if (text === undefined || !text.includes(from)) throw new Error(`${path} does not contain the text to replace`);
  const copy = new Map(tree);
  copy.set(path, text.replace(from, to));
  return copy;
}
