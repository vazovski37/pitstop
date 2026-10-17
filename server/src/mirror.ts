import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Changeset, RepoId } from "@pitstop/protocol";
import { RefDiverged, type CommitInput, type CommitPerson, type GitHubClient, type TreeEntry } from "./github.js";
import type { Mirror, Store } from "./store.js";

/**
 * The git mirror per repository (build plan, Phase 3): every accepted entry becomes a commit on a
 * branch of a GitHub repository, built with the same recipe as the daemon's local commits
 * (daemon/src/jj.ts, buildCommit), so laptops and GitHub agree on every commit id.
 */

export const COMMITTER = { name: "pitstop daemon", email: "daemon@pitstop.local" };

export const commitAuthor = (cs: Changeset): CommitPerson => ({
  name: cs.author.agent,
  email: `${cs.author.developer}@pitstop.local`,
  date: cs.createdAt,
});
export const commitCommitter = (cs: Changeset): CommitPerson => ({ ...COMMITTER, date: cs.createdAt });
/** `git commit-tree -m` ends the message with a newline; so does this. */
export const commitMessage = (cs: Changeset): string => `#${cs.lsn} ${cs.intent}\n`;

/** The tree entries an entry's files make on top of its parent's tree. `blobAt` finds a blob to reuse by path. */
export async function treeEntries(cs: Changeset, blobAt: (path: string) => Promise<string | undefined>): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  for (const f of cs.files) {
    if (f.op === "delete") {
      entries.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (f.op === "rename" && f.fromPath !== undefined && f.fromPath !== f.path) {
      entries.push({ path: f.fromPath, mode: "100644", type: "blob", sha: null });
    }
    if (f.content !== undefined) {
      entries.push({ path: f.path, mode: "100644", type: "blob", content: f.content });
    } else {
      const sha = await blobAt(f.fromPath ?? f.path);
      if (sha === undefined) throw new Error(`${f.path}: the entry carries no content and the parent has no blob to reuse`);
      entries.push({ path: f.path, mode: "100644", type: "blob", sha });
    }
  }
  return entries;
}

/** What git would name this commit: the check that GitHub and the daemons agree. */
export function commitSha(input: CommitInput): string {
  const person = (p: CommitPerson) => `${p.name} <${p.email}> ${Math.floor(Date.parse(p.date) / 1000)} +0000`;
  const body =
    `tree ${input.tree}\n` +
    input.parents.map((p) => `parent ${p}\n`).join("") +
    `author ${person(input.author)}\n` +
    `committer ${person(input.committer)}\n\n` +
    input.message;
  const bytes = Buffer.from(body, "utf8");
  return createHash("sha1").update(`commit ${bytes.length}\0`).update(bytes).digest("hex");
}

/**
 * Pushes entries to their mirrors, one repository at a time, in LSN order. `kick(repo)` after an
 * append; a kick during a run queues one more run. A failed call marks the mirror `error` and is
 * retried on the next kick or tick; a branch that moved on GitHub marks it `diverged`, which only
 * a new `PUT .../mirror` clears.
 */
export class MirrorWorker {
  private readonly running = new Set<RepoId>();
  private readonly again = new Set<RepoId>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: Store,
    private readonly github: GitHubClient,
    private readonly log?: FastifyBaseLogger,
    private readonly retryMs = 30_000,
  ) {}

  /** Resumes every mirror from where it stopped, and retries errors every `retryMs`. */
  async start(): Promise<void> {
    for (const mirror of await this.store.listMirrors()) if (mirror.status !== "diverged") this.kick(mirror.repo);
    this.timer = setInterval(() => void this.retryErrors(), this.retryMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  kick(repo: RepoId): void {
    if (this.running.has(repo)) {
      this.again.add(repo);
      return;
    }
    this.running.add(repo);
    void this.drain(repo).finally(() => {
      this.running.delete(repo);
      if (this.again.delete(repo)) this.kick(repo);
    });
  }

  /** Resolves when the repository's mirror is caught up, diverged, or failed. */
  async drain(repo: RepoId): Promise<void> {
    for (;;) {
      const mirror = await this.store.getMirror(repo);
      if (mirror === undefined || mirror.status === "diverged") return;
      const batch = await this.store.entriesAfter(repo, mirror.lastLsn, 50);
      if (batch.length === 0) {
        if (mirror.status === "error") await this.store.updateMirror(repo, { status: "enabled", error: null });
        return;
      }
      let parent = mirror.lastCommit;
      for (const changeset of batch) {
        try {
          parent = await this.push(mirror, parent, changeset);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (err instanceof RefDiverged) {
            await this.store.updateMirror(repo, { status: "diverged", error: message });
            this.log?.warn({ repo, lsn: changeset.lsn }, `mirror diverged: ${message}`);
          } else {
            await this.store.updateMirror(repo, { status: "error", error: message });
            this.log?.error({ repo, lsn: changeset.lsn }, `mirror failed: ${message}`);
          }
          return;
        }
        await this.store.updateMirror(repo, { lastLsn: changeset.lsn, lastCommit: parent, status: "enabled", error: null });
        this.log?.info({ repo, lsn: changeset.lsn, commit: parent }, "mirrored");
      }
    }
  }

  private async push(mirror: Mirror, parent: string, cs: Changeset): Promise<string> {
    const base = await this.github.getCommit(mirror.githubRepo, parent);
    const reuses = cs.files.some((f) => f.op !== "delete" && f.content === undefined);
    const blobs = reuses
      ? new Map((await this.github.getTree(mirror.githubRepo, base.tree)).filter((e) => e.type === "blob").map((e) => [e.path, e.sha]))
      : new Map<string, string>();
    const entries = await treeEntries(cs, async (path) => blobs.get(path));
    const tree = entries.length === 0 ? base.tree : await this.github.createTree(mirror.githubRepo, base.tree, entries);
    const input: CommitInput = {
      message: commitMessage(cs),
      tree,
      parents: [parent],
      author: commitAuthor(cs),
      committer: commitCommitter(cs),
    };
    const sha = await this.github.createCommit(mirror.githubRepo, input);
    const expected = commitSha(input);
    if (sha !== expected) {
      this.log?.warn({ repo: mirror.repo, lsn: cs.lsn, sha, expected }, "mirror commit id differs from the daemons' recipe");
    }
    await this.github.updateRef(mirror.githubRepo, mirror.branch, sha);
    return sha;
  }

  private async retryErrors(): Promise<void> {
    for (const mirror of await this.store.listMirrors()) if (mirror.status === "error") this.kick(mirror.repo);
  }
}
