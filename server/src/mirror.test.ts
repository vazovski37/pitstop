import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REPO, type Changeset, type CommitRequest } from "@pitstop/protocol";
import { RefDiverged, type CommitInput, type GitHubClient, type TreeEntry } from "./github.js";
import { commitAuthor, commitCommitter, commitMessage, commitSha, MirrorWorker, treeEntries } from "./mirror.js";
import { MemoryStore, SKIPPED_CHECKS } from "./store.js";

const run = promisify(execFile);

const entry = (lsn: number, over: Partial<Changeset> = {}): Changeset => ({
  repo: DEFAULT_REPO,
  lsn,
  baseLsn: lsn - 1,
  author: { developer: "vazovski", agent: "claude-code" },
  intent: `change ${lsn}`,
  files: [{ path: `src/${lsn}.ts`, op: "add", content: `export const n = ${lsn};\n` }],
  writeSet: [],
  sigWriteSet: [],
  readSet: [],
  repairs: [],
  checks: SKIPPED_CHECKS,
  brainVersion: 0,
  createdAt: "2026-10-17T14:20:05.804Z",
  ...over,
});

/** A GitHub that remembers everything and names objects predictably. */
class FakeGitHub implements GitHubClient {
  readonly trees = new Map<string, TreeEntry[]>();
  readonly commits = new Map<string, CommitInput>();
  readonly refs = new Map<string, string>();
  readonly calls: string[] = [];
  divergeOnce = false;
  failOnce = false;
  private n = 0;

  constructor(repo: string, branch: string, base: string) {
    this.refs.set(`${repo}@${branch}`, base);
    this.commits.set(base, { message: "base\n", tree: "tree-base", parents: [], author: nobody, committer: nobody });
    this.trees.set("tree-base", [{ path: "README.md", mode: "100644", type: "blob", sha: "blob-readme" }]);
  }
  async getRef(repo: string, branch: string) {
    this.calls.push(`getRef ${branch}`);
    return this.refs.get(`${repo}@${branch}`) ?? "";
  }
  async getCommit(_repo: string, sha: string) {
    this.calls.push(`getCommit ${sha}`);
    const c = this.commits.get(sha);
    if (!c) throw new Error(`no commit ${sha}`);
    return { sha, tree: c.tree };
  }
  async getTree(_repo: string, treeSha: string) {
    this.calls.push(`getTree ${treeSha}`);
    return (this.trees.get(treeSha) ?? []).map((e) => ({ path: e.path, sha: e.sha ?? `blob-${e.path}`, type: "blob" }));
  }
  async createTree(_repo: string, baseTree: string, entries: TreeEntry[]) {
    this.calls.push(`createTree on ${baseTree}: ${entries.map((e) => `${e.sha === null ? "-" : "+"}${e.path}`).join(" ")}`);
    const sha = `tree-${++this.n}`;
    this.trees.set(sha, [...(this.trees.get(baseTree) ?? []).filter((b) => !entries.some((e) => e.path === b.path)), ...entries.filter((e) => e.sha !== null)]);
    return sha;
  }
  async createCommit(_repo: string, input: CommitInput) {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error("github is down");
    }
    const sha = commitSha(input);
    this.calls.push(`createCommit ${input.message.trim()} on ${input.parents.join(",")}`);
    this.commits.set(sha, input);
    return sha;
  }
  async updateRef(repo: string, branch: string, sha: string) {
    if (this.divergeOnce) {
      this.divergeOnce = false;
      throw new RefDiverged("someone pushed");
    }
    this.calls.push(`updateRef ${branch} -> ${sha.slice(0, 7)}`);
    this.refs.set(`${repo}@${branch}`, sha);
  }
}
const nobody = { name: "x", email: "x@x", date: "2026-01-01T00:00:00Z" };
const BASE = "a".repeat(40);

describe("treeEntries", () => {
  it("turns adds, modifies, deletes and renames into tree entries", async () => {
    const cs = entry(5, {
      files: [
        { path: "a.ts", op: "add", content: "a" },
        { path: "b.ts", op: "modify", content: "b2" },
        { path: "c.ts", op: "delete" },
        { path: "e.ts", op: "rename", fromPath: "d.ts" },
        { path: "g.ts", op: "rename", fromPath: "f.ts", content: "g" },
      ],
    });
    const entries = await treeEntries(cs, async (path) => (path === "d.ts" ? "blob-d" : undefined));
    expect(entries).toEqual([
      { path: "a.ts", mode: "100644", type: "blob", content: "a" },
      { path: "b.ts", mode: "100644", type: "blob", content: "b2" },
      { path: "c.ts", mode: "100644", type: "blob", sha: null },
      { path: "d.ts", mode: "100644", type: "blob", sha: null },
      { path: "e.ts", mode: "100644", type: "blob", sha: "blob-d" },
      { path: "f.ts", mode: "100644", type: "blob", sha: null },
      { path: "g.ts", mode: "100644", type: "blob", content: "g" },
    ]);
  });

  it("refuses a change with neither content nor a blob to reuse", async () => {
    await expect(treeEntries(entry(1, { files: [{ path: "x.ts", op: "modify" }] }), async () => undefined)).rejects.toThrow(/no content/);
  });
});

describe("commitSha: the daemon's recipe, as git would name it", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("matches git commit-tree with the daemon's author, committer, dates and message", async () => {
    try {
      await run("git", ["--version"]);
    } catch {
      return; // no git here: nothing to compare with
    }
    dir = await mkdtemp(join(tmpdir(), "pitstop-mirror-"));
    const git = async (args: string[], env: Record<string, string> = {}, input?: string) => {
      const child = execFile("git", args, { cwd: dir, env: { ...process.env, ...env } });
      let out = "";
      child.stdout?.on("data", (d) => (out += d));
      if (input !== undefined) child.stdin?.end(input);
      await new Promise<void>((resolve, reject) => child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited ${code}`)))));
      return out.trim();
    };
    await git(["init", "-q"]);
    const cs = entry(7, { intent: "add seven" });
    const blob = await git(["hash-object", "-w", "--stdin"], {}, cs.files[0]?.content);
    const index = { GIT_INDEX_FILE: join(dir, "idx") };
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},src/7.ts`], index);
    const tree = await git(["write-tree"], index);
    const author = commitAuthor(cs);
    const committer = commitCommitter(cs);
    const fromGit = await git(["commit-tree", tree, "-m", `#${cs.lsn} ${cs.intent}`], {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: author.date,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: committer.date,
    });
    expect(commitSha({ message: commitMessage(cs), tree, parents: [], author, committer })).toBe(fromGit);
  }, 30_000);
});

describe("MirrorWorker", () => {
  const request = (lsn: number): CommitRequest => ({
    idempotencyKey: `mirror-${lsn}-0000`,
    baseLsn: lsn - 1,
    author: { developer: "vazovski", agent: "claude-code" },
    intent: `change ${lsn}`,
    files: [{ path: `src/${lsn}.ts`, op: "add", content: `export const n = ${lsn};\n` }],
    writeSet: [],
    sigWriteSet: [],
    readSet: [],
  });

  const setup = async () => {
    const store = new MemoryStore();
    const github = new FakeGitHub("vazovski37/pitstop", "main", BASE);
    await store.setMirror(DEFAULT_REPO, { githubRepo: "vazovski37/pitstop", branch: "main", baseCommit: BASE });
    const worker = new MirrorWorker(store, github, undefined, 60_000);
    return { store, github, worker };
  };

  it("pushes entries in order, each on the previous one, and remembers where it is", async () => {
    const { store, github, worker } = await setup();
    await store.append(request(1));
    await store.append(request(2));
    await worker.drain(DEFAULT_REPO);
    const mirror = await store.getMirror(DEFAULT_REPO);
    expect(mirror).toMatchObject({ lastLsn: 2, status: "enabled" });
    expect(github.refs.get("vazovski37/pitstop@main")).toBe(mirror?.lastCommit);
    const second = github.commits.get(mirror?.lastCommit ?? "");
    expect(second?.message).toBe("#2 change 2\n");
    expect(second?.author).toEqual({ name: "claude-code", email: "vazovski@pitstop.local", date: expect.any(String) });
    expect(second?.committer).toMatchObject({ name: "pitstop daemon", email: "daemon@pitstop.local" });
    const first = github.commits.get(second?.parents[0] ?? "");
    expect(first?.message).toBe("#1 change 1\n");
    expect(first?.parents).toEqual([BASE]);
    expect(github.calls.filter((c) => c.startsWith("createTree"))).toEqual([
      "createTree on tree-base: +src/1.ts",
      "createTree on tree-1: +src/2.ts",
    ]);
  });

  it("resumes from its position and does nothing when caught up", async () => {
    const { store, github, worker } = await setup();
    await store.append(request(1));
    await worker.drain(DEFAULT_REPO);
    const before = github.calls.length;
    await worker.drain(DEFAULT_REPO);
    expect(github.calls.length).toBe(before);
    await store.append(request(2));
    await worker.drain(DEFAULT_REPO);
    expect((await store.getMirror(DEFAULT_REPO))?.lastLsn).toBe(2);
  });

  it("marks a branch that moved on GitHub as diverged and stops", async () => {
    const { store, github, worker } = await setup();
    await store.append(request(1));
    github.divergeOnce = true;
    await worker.drain(DEFAULT_REPO);
    expect(await store.getMirror(DEFAULT_REPO)).toMatchObject({ status: "diverged", lastLsn: 0, error: "someone pushed" });
    await worker.drain(DEFAULT_REPO); // diverged: nothing happens
    expect((await store.getMirror(DEFAULT_REPO))?.lastLsn).toBe(0);
  });

  it("records an error and recovers on the next run", async () => {
    const { store, github, worker } = await setup();
    await store.append(request(1));
    github.failOnce = true;
    await worker.drain(DEFAULT_REPO);
    expect(await store.getMirror(DEFAULT_REPO)).toMatchObject({ status: "error", lastLsn: 0, error: "github is down" });
    await worker.drain(DEFAULT_REPO);
    expect(await store.getMirror(DEFAULT_REPO)).toMatchObject({ status: "enabled", lastLsn: 1 });
    expect((await store.getMirror(DEFAULT_REPO))?.error).toBeUndefined();
  });

  it("a kick during a run queues one more run", async () => {
    const { store, github, worker } = await setup();
    await store.append(request(1));
    worker.kick(DEFAULT_REPO);
    await store.append(request(2));
    worker.kick(DEFAULT_REPO);
    for (let i = 0; i < 50 && (await store.getMirror(DEFAULT_REPO))?.lastLsn !== 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await store.getMirror(DEFAULT_REPO))?.lastLsn).toBe(2);
    expect(github.refs.get("vazovski37/pitstop@main")).toBe((await store.getMirror(DEFAULT_REPO))?.lastCommit);
  });
});
