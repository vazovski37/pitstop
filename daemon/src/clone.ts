/**
 * `pitstop clone <server-url> <owner/name> [dir]`: a fresh worktree of a repository on the server,
 * built from the log (the plan's "What as their git means"). The server has no tree endpoint
 * yet, so the clone fetches every entry and replays it through the apply sequence: the import
 * entry adds the files, later entries change them. That leaves `main` and `@` exactly where a
 * long-running daemon would, with the same entry commit ids as every other clone, since entry
 * commits are deterministic and the root commit is dated from the repository's creation.
 */
import { mkdir, readdir } from "node:fs/promises";
import { z } from "zod";
import { Changeset, DEFAULT_REPO, Repo } from "@pitstop/protocol";
import { serverHeaders, writeFileConfig } from "./config.js";
import { run } from "./exec.js";
import { binariesFromEnv, JjWorktree, type Applier, type Binaries } from "./jj.js";
import { writeState } from "./state.js";

/** The server's largest `GET /log` page. */
const PAGE = 500;

export interface CloneOptions {
  serverUrl: string;
  token?: string;
  repo: string;
  /** The directory to create; it must not exist or must be empty. */
  dir: string;
  bin?: Binaries;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface CloneResult {
  dir: string;
  repo: Repo;
  /** Entries replayed, in order. */
  entries: number;
}

/** What the clone does to the file system, replaceable in tests. */
export interface CloneHooks {
  /** Makes `dir` an empty colocated worktree with a `main` bookmark. */
  prepare: (dir: string, repo: Repo, bin: Binaries) => Promise<void>;
  applierFor: (dir: string, bin: Binaries) => Applier;
}

export const defaultHooks: CloneHooks = {
  prepare: prepareWorktree,
  applierFor: (dir, bin) => new JjWorktree(dir, bin),
};

export async function cloneRepository(opts: CloneOptions, hooks: CloneHooks = defaultHooks): Promise<CloneResult> {
  const serverUrl = opts.serverUrl.replace(/\/+$/, "");
  const bin = opts.bin ?? binariesFromEnv();
  const fetchImpl = opts.fetch ?? fetch;
  const headers = serverHeaders(opts.token);

  await ensureEmpty(opts.dir);

  // 1. The repository and where its log stands.
  const repoRes = await fetchImpl(new URL(`/repos/${opts.repo}`, serverUrl), { headers });
  if (repoRes.status === 404) throw new Error(`no repository ${opts.repo} on ${serverUrl}`);
  if (!repoRes.ok) throw new Error(`GET /repos/${opts.repo} answered ${repoRes.status}`);
  const repo = Repo.parse(await repoRes.json());
  opts.log?.(`${repo.id} is at #${repo.headLsn}`);

  // 2. The log, page by page, up to that head (entries that land meanwhile are the daemon's job).
  const entries: Changeset[] = [];
  let from = 0;
  while (from < repo.headLsn) {
    const url = new URL("/log", serverUrl);
    if (repo.id !== DEFAULT_REPO) url.searchParams.set("repo", repo.id);
    url.searchParams.set("fromLsn", String(from));
    url.searchParams.set("limit", String(PAGE));
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`GET /log answered ${res.status}`);
    const page = z.array(Changeset).parse(await res.json()).filter((e) => e.lsn <= repo.headLsn);
    if (page.length === 0) break;
    entries.push(...page);
    from = page[page.length - 1]?.lsn ?? repo.headLsn;
  }
  for (let i = 0; i < entries.length; i++) {
    const expected = i + 1;
    if (entries[i]?.lsn !== expected) throw new Error(`the log of ${repo.id} skips #${expected}; a clone needs every entry from #1`);
  }

  // 3. An empty worktree, then every entry in order.
  await hooks.prepare(opts.dir, repo, bin);
  const applier = hooks.applierFor(opts.dir, bin);
  for (const entry of entries) {
    await applier.apply(entry);
    if (entry.lsn % 10 === 0 || entry.lsn === entries.length) opts.log?.(`applied #${entry.lsn} of ${entries.length}`);
  }

  // 4. What the daemon needs to carry on from here.
  await writeFileConfig(opts.dir, {
    serverUrl,
    ...(opts.token === undefined ? {} : { token: opts.token }),
    repo: repo.id,
  });
  await writeState(opts.dir, { appliedLsn: entries.length });
  opts.log?.(`${opts.dir} is at #${entries.length}; run \`pitstop daemon\` there`);
  return { dir: opts.dir, repo, entries: entries.length };
}

async function ensureEmpty(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const present = await readdir(dir);
  if (present.length > 0) throw new Error(`${dir} is not empty`);
}

/**
 * A git repository with one empty root commit on `main`, colocated with jj. The root commit's
 * author and dates come from the repository, so two clones of the same log agree on every id.
 */
export async function prepareWorktree(dir: string, repo: Repo, bin: Binaries): Promise<void> {
  const git = (args: string[], env?: Record<string, string>) => run(bin.git, args, { cwd: dir, ...(env ? { env } : {}) });
  await git(["init", "-q", "-b", "main"]);
  const tree = (await git(["mktree"])).trim();
  const identity = {
    GIT_AUTHOR_NAME: "pitstop",
    GIT_AUTHOR_EMAIL: "daemon@pitstop.local",
    GIT_AUTHOR_DATE: repo.createdAt,
    GIT_COMMITTER_NAME: "pitstop",
    GIT_COMMITTER_EMAIL: "daemon@pitstop.local",
    GIT_COMMITTER_DATE: repo.createdAt,
  };
  const root = (await git(["commit-tree", tree, "-m", `pitstop clone ${repo.id}`], identity)).trim();
  await git(["update-ref", "refs/heads/main", root]);
  await run(bin.jj, ["git", "init", "--colocate"], { cwd: dir });
}
