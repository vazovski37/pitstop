import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_REPO,
  type Changeset,
  type Checks,
  type CommitRequest,
  type CommitResponse,
  type FileChange,
  type Intent,
  type IntentRequest,
  type Lsn,
  type Repair,
  type Repo,
  type RepoId,
} from "@pitstop/protocol";

/**
 * What the server needs from its storage: the repositories, each with its own log, the blobs,
 * and the open intents. `PgStore` (pg-store.ts) is the real one; `MemoryStore` serves tests and
 * laptops without Postgres. LSNs count per repository.
 */
export interface Store {
  /**
   * Appends a changeset to `repoOf(req)` at its next LSN. The same idempotency key returns the
   * same changeset. `decide`, when given, runs inside the append's critical section with every
   * entry after `gapStart(req)` (at most GAP_LIMIT + 1 of them) and the head LSN. It returns what
   * to record with the changeset, or throws `RejectedCommit` to refuse it (validate.ts).
   * An unknown repository is an `InvalidCommit`.
   */
  append(req: CommitRequest, decide?: Decide): Promise<Changeset>;
  /** Entries of `repo` with `lsn > fromLsn`, in LSN order, at most `limit` of them. */
  entriesAfter(repo: RepoId, fromLsn: Lsn, limit: number): Promise<Changeset[]>;
  headLsn(repo: RepoId): Promise<Lsn>;
  /**
   * Every file of `repo` at `lsn`, path to text: the log folded up to that entry (the latest
   * change per path, deletes and renames applied). Needs the repository to have entered the log
   * as a full import at its first entry.
   */
  treeAt(repo: RepoId, lsn: Lsn): Promise<Tree>;
  /** Creates the repository, or returns it when it exists. */
  createRepo(id: RepoId): Promise<{ repo: Repo; created: boolean }>;
  getRepo(id: RepoId): Promise<Repo | undefined>;
  listRepos(): Promise<Repo[]>;
  /** An unknown repository is an `InvalidCommit`. */
  openIntent(req: IntentRequest): Promise<Intent>;
  /** The repository's open intents: the catalog's live view (design doc 9.3), for early warnings. */
  openIntents(repo: RepoId): Promise<Intent[]>;
  /** Refreshes an open intent's heartbeat. Unknown or closed intents are ignored. */
  heartbeat(intentId: string): Promise<void>;
  getMirror(repo: RepoId): Promise<Mirror | undefined>;
  /** Creates or replaces the repository's mirror; its position starts over at `baseCommit`. */
  setMirror(repo: RepoId, config: MirrorConfig): Promise<Mirror>;
  deleteMirror(repo: RepoId): Promise<void>;
  updateMirror(repo: RepoId, patch: MirrorPatch): Promise<void>;
  listMirrors(): Promise<Mirror[]>;
}

/** Where a repository's entries are pushed as git commits (mirror.ts). */
export interface MirrorConfig {
  /** `owner/name` on github.com. */
  githubRepo: string;
  branch: string;
  /** The commit the first mirrored entry builds on: what the import was made from. */
  baseCommit: string;
}
export type MirrorStatus = "enabled" | "diverged" | "error";
export interface Mirror extends MirrorConfig {
  repo: RepoId;
  /** The last entry pushed; 0 before the first. */
  lastLsn: Lsn;
  /** Its commit; `baseCommit` before the first push. */
  lastCommit: string;
  status: MirrorStatus;
  error?: string;
  updatedAt: string;
}
export interface MirrorPatch {
  lastLsn?: Lsn;
  lastCommit?: string;
  status?: MirrorStatus;
  /** `null` clears it. */
  error?: string | null;
}

/** Path to text. */
export type Tree = Map<string, string>;

/** What a decision records with the changeset. Defaults: skipped checks, no repairs, the files as sent. */
export interface Decision {
  checks?: Checks;
  repairs?: Repair[];
  /** The files to land instead of the request's: a repair's output, hashes filled in. */
  files?: FileChange[];
}
export type Decide = (gap: Changeset[], head: Lsn) => Decision | Promise<Decision>;

/** How far behind head a commit may be before the daemon must rebase first. */
export const GAP_LIMIT = 500;

/** The repository a request is for. */
export const repoOf = (req: { repo?: RepoId | undefined }): RepoId => req.repo ?? DEFAULT_REPO;

/** The start of the window a commit is checked against: reads may be older than the files' base. */
export const gapStart = (req: CommitRequest): Lsn => Math.min(req.baseLsn, req.readBaseLsn ?? req.baseLsn);

/** Recorded until the checks run (Phase 4). */
export const SKIPPED_CHECKS: Checks = { typecheck: "skipped", tests: "skipped", adr: "skipped" };

export const blobHash = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

export const newIntentId = (): string => `int_${randomBytes(4).toString("hex")}`;

/** The request cannot be appended as sent. The route answers `rejected` with `invalid_request`. */
export class InvalidCommit extends Error {}

export type RejectReason = Extract<CommitResponse, { status: "rejected" }>["reason"];

/** The commit is well-formed but may not land as it is: the route answers `rejected` with `reason`. */
export class RejectedCommit extends Error {
  constructor(
    readonly reason: RejectReason,
    message: string,
    readonly conflictsWith: Lsn[] = [],
  ) {
    super(message);
  }
}

export const unknownRepo = (id: RepoId): InvalidCommit => new InvalidCommit(`unknown repo ${id}: POST /repos first`);

/** Fills in a missing `blob` from `content`, and refuses a `blob` that is not its sha256. */
export function withBlobHashes(req: CommitRequest): CommitRequest {
  for (const f of req.files) {
    if (f.content === undefined || f.blob === undefined) continue;
    const hash = blobHash(f.content);
    if (f.blob !== hash) throw new InvalidCommit(`${f.path}: blob ${f.blob} is not the sha256 of its content (${hash})`);
  }
  return { ...req, files: hashedFiles(req.files) };
}

/** The same files with `blob` set from `content` wherever there is content. */
export const hashedFiles = (files: FileChange[]): FileChange[] =>
  files.map((f) => (f.content === undefined ? f : { ...f, blob: blobHash(f.content) }));

/** Applies a changeset's files to a tree, in place. A change without content keeps what was there. */
export function applyFiles(tree: Tree, files: FileChange[]): Tree {
  for (const f of files) {
    if (f.op === "delete") {
      tree.delete(f.path);
      continue;
    }
    if (f.op === "rename" && f.fromPath !== undefined) {
      const moved = tree.get(f.fromPath);
      tree.delete(f.fromPath);
      if (f.content === undefined && moved !== undefined) tree.set(f.path, moved);
    }
    if (f.content !== undefined) tree.set(f.path, f.content);
  }
  return tree;
}

export class MemoryStore implements Store {
  private readonly logs = new Map<RepoId, Changeset[]>([[DEFAULT_REPO, []]]);
  private readonly repos = new Map<RepoId, Repo>([[DEFAULT_REPO, { id: DEFAULT_REPO, headLsn: 0, createdAt: new Date().toISOString() }]]);
  private readonly byKey = new Map<string, Changeset>();
  private readonly intents = new Map<string, Intent>();
  private readonly mirrors = new Map<RepoId, Mirror>();

  async append(req: CommitRequest, decide?: Decide): Promise<Changeset> {
    const seen = this.byKey.get(req.idempotencyKey);
    if (seen) return seen;
    const repo = repoOf(req);
    const log = this.logs.get(repo);
    if (log === undefined) throw unknownRepo(repo);
    const lsn = log.length + 1;
    if (req.baseLsn >= lsn) throw new InvalidCommit(`baseLsn ${req.baseLsn} is not below the next LSN ${lsn}`);
    const intent = req.intentId === undefined ? undefined : this.intents.get(req.intentId);
    if (req.intentId !== undefined && intent === undefined) throw new InvalidCommit(`unknown intent ${req.intentId}`);
    const gap = log.filter((e) => e.lsn > gapStart(req)).slice(0, GAP_LIMIT + 1);
    const decision = decide ? await decide(gap, lsn - 1) : {};
    const changeset: Changeset = {
      repo,
      lsn,
      baseLsn: req.baseLsn,
      author: req.author,
      intent: req.intent,
      files: decision.files ?? req.files,
      writeSet: req.writeSet,
      sigWriteSet: req.sigWriteSet,
      readSet: req.readSet,
      repairs: decision.repairs ?? [],
      checks: decision.checks ?? SKIPPED_CHECKS,
      brainVersion: 0,
      createdAt: new Date().toISOString(),
    };
    log.push(changeset);
    this.byKey.set(req.idempotencyKey, changeset);
    if (intent?.status === "open") this.intents.set(intent.id, { ...intent, status: "committed" });
    return changeset;
  }

  async entriesAfter(repo: RepoId, fromLsn: Lsn, limit: number): Promise<Changeset[]> {
    return (this.logs.get(repo) ?? []).filter((e) => e.lsn > fromLsn).slice(0, limit);
  }

  async headLsn(repo: RepoId): Promise<Lsn> {
    return this.logs.get(repo)?.length ?? 0;
  }

  async treeAt(repo: RepoId, lsn: Lsn): Promise<Tree> {
    const tree: Tree = new Map();
    for (const entry of this.logs.get(repo) ?? []) if (entry.lsn <= lsn) applyFiles(tree, entry.files);
    return tree;
  }

  async createRepo(id: RepoId): Promise<{ repo: Repo; created: boolean }> {
    const existing = await this.getRepo(id);
    if (existing) return { repo: existing, created: false };
    const repo: Repo = { id, headLsn: 0, createdAt: new Date().toISOString() };
    this.repos.set(id, repo);
    this.logs.set(id, []);
    return { repo, created: true };
  }

  async getRepo(id: RepoId): Promise<Repo | undefined> {
    const repo = this.repos.get(id);
    return repo === undefined ? undefined : { ...repo, headLsn: await this.headLsn(id) };
  }

  async listRepos(): Promise<Repo[]> {
    const all = await Promise.all([...this.repos.keys()].sort().map((id) => this.getRepo(id)));
    return all.flatMap((r) => (r === undefined ? [] : [r]));
  }

  async openIntent(req: IntentRequest): Promise<Intent> {
    const repo = repoOf(req);
    if (!this.repos.has(repo)) throw unknownRepo(repo);
    const intent: Intent = {
      id: newIntentId(),
      repo,
      author: req.author,
      baseLsn: req.baseLsn,
      text: req.text,
      declaredSymbols: req.declaredSymbols,
      status: "open",
      heartbeatAt: new Date().toISOString(),
    };
    this.intents.set(intent.id, intent);
    return intent;
  }

  async openIntents(repo: RepoId): Promise<Intent[]> {
    return [...this.intents.values()].filter((i) => i.repo === repo && i.status === "open");
  }

  async heartbeat(intentId: string): Promise<void> {
    const intent = this.intents.get(intentId);
    if (intent?.status === "open") this.intents.set(intentId, { ...intent, heartbeatAt: new Date().toISOString() });
  }

  async getMirror(repo: RepoId): Promise<Mirror | undefined> {
    return this.mirrors.get(repo);
  }

  async setMirror(repo: RepoId, config: MirrorConfig): Promise<Mirror> {
    if (!this.repos.has(repo)) throw unknownRepo(repo);
    const mirror: Mirror = { repo, ...config, lastLsn: 0, lastCommit: config.baseCommit, status: "enabled", updatedAt: new Date().toISOString() };
    this.mirrors.set(repo, mirror);
    return mirror;
  }

  async deleteMirror(repo: RepoId): Promise<void> {
    this.mirrors.delete(repo);
  }

  async updateMirror(repo: RepoId, patch: MirrorPatch): Promise<void> {
    const mirror = this.mirrors.get(repo);
    if (mirror === undefined) return;
    const { error, ...rest } = patch;
    const next: Mirror = { ...mirror, ...rest, updatedAt: new Date().toISOString() };
    if (error === null) delete next.error;
    else if (error !== undefined) next.error = error;
    this.mirrors.set(repo, next);
  }

  async listMirrors(): Promise<Mirror[]> {
    return [...this.mirrors.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  }

  /** For tests. */
  intent(id: string): Intent | undefined {
    return this.intents.get(id);
  }
}
