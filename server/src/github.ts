/**
 * The slice of GitHub's Git Data API the mirror needs: read a ref, a commit and a tree; create a
 * tree, a commit; move a ref. No SDK and no git binary: the server holds no clone, so a restart
 * costs nothing and the mirror's position lives in Postgres (store.ts, `Mirror`).
 */
export interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  /** The file's text; GitHub hashes it like `git hash-object` would. */
  content?: string;
  /** An existing blob to reuse, or `null` to delete the path. */
  sha?: string | null;
}

export interface CommitPerson {
  name: string;
  email: string;
  /** ISO 8601. */
  date: string;
}

export interface CommitInput {
  message: string;
  tree: string;
  parents: string[];
  author: CommitPerson;
  committer: CommitPerson;
}

export interface GitHubClient {
  /** The commit a branch points at. */
  getRef(repo: string, branch: string): Promise<string>;
  getCommit(repo: string, sha: string): Promise<{ sha: string; tree: string }>;
  /** Every blob under a tree, recursively: path and sha. */
  getTree(repo: string, treeSha: string): Promise<{ path: string; sha: string; type: string }[]>;
  createTree(repo: string, baseTree: string, entries: TreeEntry[]): Promise<string>;
  createCommit(repo: string, input: CommitInput): Promise<string>;
  /** Fast-forward only. Throws `RefDiverged` when the branch moved somewhere else meanwhile. */
  updateRef(repo: string, branch: string, sha: string): Promise<void>;
}

/** The branch on GitHub no longer descends from the mirror's last commit: someone else pushed. */
export class RefDiverged extends Error {}

export interface GitHubOptions {
  /** A fine-grained token with "Contents: write" on the mirrored repository. */
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Default 30 s per call. */
  timeoutMs?: number;
}

export class GitHubApi implements GitHubClient {
  constructor(private readonly opts: GitHubOptions) {}

  async getRef(repo: string, branch: string): Promise<string> {
    const ref = await this.call<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    return ref.object.sha;
  }

  async getCommit(repo: string, sha: string): Promise<{ sha: string; tree: string }> {
    const commit = await this.call<{ sha: string; tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${sha}`);
    return { sha: commit.sha, tree: commit.tree.sha };
  }

  async getTree(repo: string, treeSha: string): Promise<{ path: string; sha: string; type: string }[]> {
    const tree = await this.call<{ tree: { path: string; sha: string; type: string }[]; truncated: boolean }>(
      "GET",
      `/repos/${repo}/git/trees/${treeSha}?recursive=1`,
    );
    if (tree.truncated) throw new Error(`tree ${treeSha} of ${repo} is too large for GitHub to list`);
    return tree.tree;
  }

  async createTree(repo: string, baseTree: string, entries: TreeEntry[]): Promise<string> {
    const tree = await this.call<{ sha: string }>("POST", `/repos/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
    return tree.sha;
  }

  async createCommit(repo: string, input: CommitInput): Promise<string> {
    const commit = await this.call<{ sha: string }>("POST", `/repos/${repo}/git/commits`, input);
    return commit.sha;
  }

  async updateRef(repo: string, branch: string, sha: string): Promise<void> {
    try {
      await this.call("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
    } catch (err) {
      if (err instanceof GitHubError && err.status === 422) throw new RefDiverged(`${repo}@${branch} moved on GitHub: ${err.message}`);
      throw err;
    }
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl ?? "https://api.github.com"}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "pitstop-mirror",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new GitHubError(res.status, `github answered ${res.status} to ${method} ${path}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
