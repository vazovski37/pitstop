import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Changeset, FileChange } from "@pitstop/protocol";
import { run } from "./exec.js";

/** What applying one log entry to a worktree produced. */
export interface ApplyResult {
  /** The git commit `main` now points at. */
  commit: string;
  /** jj change ids (of `@` and anything between it and `main`) left with conflicts; empty when clean. */
  conflicted: string[];
  /** The files in `@` that carry conflict markers now; empty when clean. */
  conflictedFiles: string[];
}

/** The worktree operations the daemon needs. `JjWorktree` is the real one; tests substitute a fake. */
export interface Applier {
  apply(changeset: Changeset): Promise<ApplyResult>;
  /** The agent's unfinished work in `@`, as the file changes a commit request carries. */
  diffAgainstMain(): Promise<FileChange[]>;
  /** Whether `@` holds any change against its parent. */
  hasChanges(): Promise<boolean>;
  /** Every tracked file at `main` or at `@`: posix path relative to the worktree -> text. */
  treeFiles(rev: "main" | "@"): Promise<Map<string, string>>;
}

/** The entry cannot be applied as sent (missing content, wrong blob hash). Nothing was changed. */
export class ApplyError extends Error {}

export const blobHash = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

export interface Binaries {
  jj: string;
  git: string;
}

export const binariesFromEnv = (env: NodeJS.ProcessEnv = process.env): Binaries => ({
  jj: env.PITSTOP_JJ_BIN ?? "jj",
  git: env.PITSTOP_GIT_BIN ?? "git",
});

/**
 * A worktree under Jujutsu colocated with git (`jj git init --colocate`).
 *
 * The command sequence is the one from daemon/CLAUDE.md, "jj apply sequence": the entry's commit is
 * built with git plumbing on top of `main`, `main` moves with a compare-and-swap, and the agent's
 * working copy `@` is rebased onto it. The agent's files on disk are touched once, by that rebase.
 * On any failure the jj operation log is restored to where the apply started.
 */
export class JjWorktree implements Applier {
  constructor(
    readonly dir: string,
    private readonly bin: Binaries = binariesFromEnv(),
    readonly bookmark = "main",
  ) {}

  async apply(changeset: Changeset): Promise<ApplyResult> {
    for (const f of changeset.files) checkFile(changeset, f);

    // 0. Snapshot the agent's edits into @ and remember where to roll back to.
    await this.detachHead();
    await this.jj(["util", "snapshot"]);
    const restoreOp = (await this.jj(["op", "log", "-n1", "--no-graph", "-T", "id"])).trim();
    try {
      // 1. Build the entry's commit on top of main without touching the working copy.
      const oldMain = (await this.git(["rev-parse", `refs/heads/${this.bookmark}`])).trim();
      const newMain = await this.buildCommit(oldMain, changeset);
      // 2. Move main; fails if something else moved it since step 1.
      await this.git(["update-ref", `refs/heads/${this.bookmark}`, newMain, oldMain]);
      // 3. Rebase @ onto the new main (jj imports the moved git ref by itself in a colocated repo).
      await this.jj(["rebase", "-d", this.bookmark]);
      // 4. jj records conflicts instead of stopping; report the changes that carry one.
      const conflicted = (
        await this.jj(["log", "-r", `conflicts() & ${this.bookmark}..@`, "--no-graph", "-T", 'change_id ++ "\\n"'])
      )
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const conflictedFiles = conflicted.length === 0 ? [] : await this.conflictedFiles();
      return { commit: newMain, conflicted, conflictedFiles };
    } catch (err) {
      await this.jj(["op", "restore", restoreOp]);
      throw err;
    }
  }

  /**
   * In a repository whose first commits git made (demo/scripts/reset.sh), `jj git init --colocate`
   * leaves git HEAD a symbolic ref to `main`. Moving `main` would then move HEAD too, and jj reads a
   * moved HEAD as "someone ran git checkout, the files already match", so the rebase never updates
   * the working copy. Detaching HEAD at the same commit changes nothing jj can see.
   */
  private async detachHead(): Promise<void> {
    let symbolic: string;
    try {
      symbolic = (await this.git(["symbolic-ref", "-q", "HEAD"])).trim();
    } catch {
      return; // already detached
    }
    if (symbolic === "") return;
    const commit = (await this.git(["rev-parse", "HEAD"])).trim();
    await this.git(["update-ref", "--no-deref", "HEAD", commit]);
  }

  /** `jj resolve --list` prints one line per conflicted file in `@`: the path, spaces, "N-sided conflict". */
  async conflictedFiles(): Promise<string[]> {
    let out: string;
    try {
      out = await this.jj(["resolve", "--list"]);
    } catch {
      return []; // "No conflicts found" exits non-zero
    }
    return out
      .split("\n")
      .map((line) => /^(.*?)\s{2,}\d+-sided conflict/.exec(line)?.[1]?.trim() ?? "")
      .filter((path) => path.length > 0)
      .map((path) => path.replace(/\\/g, "/"));
  }

  async hasChanges(): Promise<boolean> {
    await this.jj(["util", "snapshot"]);
    const out = await this.jj(["log", "-r", "@", "--no-graph", "-T", 'if(empty, "empty", "changed")']);
    return out.trim() === "changed";
  }

  async treeFiles(rev: "main" | "@"): Promise<Map<string, string>> {
    const commit = rev === "@" ? await this.workingCopyCommit() : `refs/heads/${this.bookmark}`;
    const paths = (await this.git(["ls-tree", "-r", "-z", "--name-only", commit]))
      .split("\0")
      .filter((p) => p.length > 0 && !p.startsWith(".pitstop/") && !p.split("/").includes("node_modules"));
    const files = new Map<string, string>();
    for (const path of paths) files.set(path, await this.git(["show", `${commit}:${path}`]));
    return files;
  }

  /** Snapshots the working copy and returns the git commit of `@`. */
  private async workingCopyCommit(): Promise<string> {
    await this.jj(["util", "snapshot"]);
    return (await this.jj(["log", "-r", "@", "--no-graph", "-T", "commit_id"])).trim();
  }

  async diffAgainstMain(): Promise<FileChange[]> {
    const at = await this.workingCopyCommit();
    const out = await this.git(["diff", "--name-status", "-M", "-z", `refs/heads/${this.bookmark}`, at]);
    const fields = out.split("\0");
    const files: FileChange[] = [];
    // The daemon's own directory is never part of a commit, even if git happens to track it.
    const own = (path: string) => path === ".pitstop" || path.startsWith(".pitstop/");
    for (let i = 0; i < fields.length; ) {
      const status = fields[i];
      if (status === undefined || status === "") break;
      if (status.startsWith("R")) {
        const fromPath = fields[i + 1] ?? "";
        const path = fields[i + 2] ?? "";
        i += 3;
        if (own(path) || own(fromPath)) continue;
        files.push({ path, op: "rename", fromPath, ...(await this.contentOf(at, path)) });
        continue;
      }
      const path = fields[i + 1] ?? "";
      i += 2;
      if (own(path)) continue;
      if (status.startsWith("D")) files.push({ path, op: "delete" });
      else files.push({ path, op: status.startsWith("A") ? "add" : "modify", ...(await this.contentOf(at, path)) });
    }
    return files;
  }

  private async contentOf(commit: string, path: string): Promise<{ content: string; blob: string }> {
    const content = await this.git(["show", `${commit}:${path}`]);
    return { content, blob: blobHash(content) };
  }

  private async buildCommit(parent: string, cs: Changeset): Promise<string> {
    const gitDir = (await this.git(["rev-parse", "--absolute-git-dir"])).trim();
    const index = join(gitDir, "pitstop-index");
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(["read-tree", parent], { env });
      for (const f of cs.files) {
        if (f.op === "delete") {
          await this.git(["update-index", "--force-remove", "--", f.path], { env });
          continue;
        }
        if (f.op === "rename" && f.fromPath !== undefined) {
          await this.git(["update-index", "--force-remove", "--", f.fromPath], { env });
        }
        const blob =
          f.content !== undefined
            ? (await this.git(["hash-object", "-w", "--stdin"], { env, input: f.content })).trim()
            : (await this.git(["rev-parse", `${parent}:${f.fromPath ?? ""}`])).trim();
        await this.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`], { env });
      }
      const tree = (await this.git(["write-tree"], { env })).trim();
      // Author, committer and both dates come from the entry, so every worktree builds the same
      // commit id for the same entry (the git mirror in Phase 3 relies on that).
      const identity = {
        GIT_AUTHOR_NAME: cs.author.agent,
        GIT_AUTHOR_EMAIL: `${cs.author.developer}@pitstop.local`,
        GIT_AUTHOR_DATE: cs.createdAt,
        GIT_COMMITTER_NAME: "pitstop daemon",
        GIT_COMMITTER_EMAIL: "daemon@pitstop.local",
        GIT_COMMITTER_DATE: cs.createdAt,
      };
      return (await this.git(["commit-tree", tree, "-p", parent, "-m", `#${cs.lsn} ${cs.intent}`], { env: identity })).trim();
    } finally {
      await rm(index, { force: true });
    }
  }

  private jj(args: string[]): Promise<string> {
    return run(this.bin.jj, args, { cwd: this.dir });
  }

  private git(args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<string> {
    return run(this.bin.git, args, { cwd: this.dir, ...opts });
  }
}

/** Refuses what cannot be applied before anything is touched. */
function checkFile(cs: Changeset, f: FileChange): void {
  const where = `#${cs.lsn} ${f.path}`;
  if (f.op === "delete") return;
  if (f.op === "rename" && f.fromPath === undefined) throw new ApplyError(`${where}: rename without fromPath`);
  if (f.content === undefined) {
    if (f.op === "rename") return; // content unchanged: the blob is taken from fromPath
    throw new ApplyError(`${where}: ${f.op} without content; the daemon cannot write a file it never had`);
  }
  if (f.blob !== undefined && f.blob !== blobHash(f.content)) {
    throw new ApplyError(`${where}: blob ${f.blob} is not the sha256 of its content`);
  }
}
