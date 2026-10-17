import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_REPO,
  type Author,
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
  heartbeat(repo: RepoId, intentId: string): Promise<void>;
  getMirror(repo: RepoId): Promise<Mirror | undefined>;
  /** Creates or replaces the repository's mirror; its position starts over at `baseCommit`. */
  setMirror(repo: RepoId, config: MirrorConfig): Promise<Mirror>;
  deleteMirror(repo: RepoId): Promise<void>;
  updateMirror(repo: RepoId, patch: MirrorPatch): Promise<void>;
  listMirrors(): Promise<Mirror[]>;

  // Accounts (migration 005): users, their personal tokens, repository members.
  /** Creates the user on first sign-in, refreshes login, name and avatar on later ones. */
  upsertUser(input: UserInput): Promise<User>;
  getUser(id: string): Promise<User | undefined>;
  getUserByLogin(login: string): Promise<User | undefined>;
  /** A new personal token; the secret is returned once and stored only as its hash. */
  createToken(userId: string, name: string): Promise<{ token: Token; secret: string }>;
  /** The user behind a personal token, when it exists and is not revoked; records the use. */
  userForToken(secret: string): Promise<User | undefined>;
  listTokens(userId: string): Promise<Token[]>;
  revokeToken(userId: string, tokenId: string): Promise<boolean>;
  setMember(repo: RepoId, userId: string, role: Role): Promise<void>;
  removeMember(repo: RepoId, userId: string): Promise<boolean>;
  listMembers(repo: RepoId): Promise<Member[]>;
  roleOf(repo: RepoId, userId: string): Promise<Role | undefined>;
  /** Marks a member as one the repository's conflicts go to; false when they are not a member. */
  setResolver(repo: RepoId, userId: string, resolver: boolean): Promise<boolean>;
  // Invites (migration 006): a GitHub login that has not signed in yet, with the role it gets.
  setInvite(repo: RepoId, login: string, role: Role, invitedBy?: string): Promise<void>;
  listInvites(repo: RepoId): Promise<Invite[]>;
  deleteInvite(repo: RepoId, login: string): Promise<boolean>;
  /** Turns the user's pending invites into memberships; the repositories they joined. */
  acceptInvites(user: User): Promise<RepoId[]>;
  // Parked commits (migration 007): write skew waiting for the repository's resolver.
  park(input: ParkInput): Promise<Parked>;
  /** Newest first. */
  listParked(repo: RepoId): Promise<Parked[]>;
  getParked(repo: RepoId, id: string): Promise<Parked | undefined>;
  /** The author's commit still waiting in the repository, if any. */
  openParkedBy(repo: RepoId, author: Author): Promise<Parked | undefined>;
  /** Records the decision on an open parked commit; false when it was not open. */
  decideParked(repo: RepoId, id: string, decision: ParkDecision): Promise<boolean>;
  visibility(repo: RepoId): Promise<Visibility | undefined>;
  setVisibility(repo: RepoId, visibility: Visibility): Promise<void>;
}

export interface User {
  id: string;
  githubId: number;
  /** The GitHub login; also `author.developer` on commits made with the user's tokens. */
  login: string;
  name?: string;
  avatarUrl?: string;
  createdAt: string;
}
export interface UserInput {
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
}
export interface Token {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}
export type Role = "owner" | "writer" | "reader";
export const ROLE_RANK: Record<Role, number> = { reader: 1, writer: 2, owner: 3 };
export interface Member {
  repo: RepoId;
  userId: string;
  login: string;
  role: Role;
  /** The repository's conflicts go to this member (migration 006). */
  resolver: boolean;
}
export interface Invite {
  repo: RepoId;
  /** Lowercased. */
  login: string;
  role: Role;
  createdAt: string;
}
export interface ParkInput {
  repo: RepoId;
  /** The committer, when a signed-in user. */
  userId?: string;
  request: CommitRequest;
  /** What the validator found, for people (`describeSkew`). */
  skew: string;
  conflictsWith: Lsn[];
  headLsn: Lsn;
}
export type ParkStatus = "open" | "accepted" | "sent_back";
export interface Parked extends ParkInput {
  id: string;
  author: Author;
  status: ParkStatus;
  note?: string;
  /** The resolver's login. */
  decidedBy?: string;
  landedLsn?: Lsn;
  createdAt: string;
  decidedAt?: string;
}
export interface ParkDecision {
  status: Exclude<ParkStatus, "open">;
  decidedBy: string;
  note?: string;
  landedLsn?: Lsn;
}
export const newParkedId = (): string => `pk_${randomBytes(4).toString("hex")}`;
export type Visibility = "private" | "public";

export const newUserId = (): string => `u_${randomBytes(4).toString("hex")}`;
export const newTokenId = (): string => `t_${randomBytes(4).toString("hex")}`;
/** What a daemon's `.env` holds: `pst_` and 32 hex characters. */
export const newTokenSecret = (): string => `pst_${randomBytes(16).toString("hex")}`;
export const tokenHash = (secret: string): string => createHash("sha256").update(secret, "utf8").digest("hex");

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
  private readonly users = new Map<string, User>();
  private readonly tokens = new Map<string, Token & { hash: string }>();
  private readonly members = new Map<string, Member>(); // `${repo}\n${userId}`
  private readonly invites = new Map<string, Invite>(); // `${repo}\n${login}`
  private readonly visibilities = new Map<RepoId, Visibility>();
  private readonly parked = new Map<string, Parked>();

  async append(req: CommitRequest, decide?: Decide): Promise<Changeset> {
    const seen = this.byKey.get(req.idempotencyKey);
    if (seen) {
      if (seen.repo !== repoOf(req)) throw new InvalidCommit("idempotency key already used by another commit");
      return seen;
    }
    const repo = repoOf(req);
    const log = this.logs.get(repo);
    if (log === undefined) throw unknownRepo(repo);
    const lsn = log.length + 1;
    if (req.baseLsn >= lsn) throw new InvalidCommit(`baseLsn ${req.baseLsn} is not below the next LSN ${lsn}`);
    const intent = req.intentId === undefined ? undefined : this.intents.get(req.intentId);
    if (req.intentId !== undefined && (intent === undefined || intent.repo !== repo)) throw new InvalidCommit(`unknown intent ${req.intentId}`);
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

  async heartbeat(repo: RepoId, intentId: string): Promise<void> {
    const intent = this.intents.get(intentId);
    if (intent?.status === "open" && intent.repo === repo) this.intents.set(intentId, { ...intent, heartbeatAt: new Date().toISOString() });
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

  async upsertUser(input: UserInput): Promise<User> {
    const existing = [...this.users.values()].find((u) => u.githubId === input.githubId);
    const user: User = {
      id: existing?.id ?? newUserId(),
      githubId: input.githubId,
      login: input.login,
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByLogin(login: string): Promise<User | undefined> {
    // GitHub logins are case-insensitive.
    return [...this.users.values()].find((u) => u.login.toLowerCase() === login.toLowerCase());
  }

  async createToken(userId: string, name: string): Promise<{ token: Token; secret: string }> {
    if (!this.users.has(userId)) throw new Error(`no user ${userId}`);
    const secret = newTokenSecret();
    const token: Token = { id: newTokenId(), userId, name, createdAt: new Date().toISOString() };
    this.tokens.set(token.id, { ...token, hash: tokenHash(secret) });
    return { token, secret };
  }

  async userForToken(secret: string): Promise<User | undefined> {
    const hash = tokenHash(secret);
    const token = [...this.tokens.values()].find((t) => t.hash === hash && t.revokedAt === undefined);
    if (token === undefined) return undefined;
    this.tokens.set(token.id, { ...token, lastUsedAt: new Date().toISOString() });
    return this.users.get(token.userId);
  }

  async listTokens(userId: string): Promise<Token[]> {
    return [...this.tokens.values()]
      .filter((t) => t.userId === userId)
      .map(({ hash: _hash, ...token }) => token)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const token = this.tokens.get(tokenId);
    if (token === undefined || token.userId !== userId || token.revokedAt !== undefined) return false;
    this.tokens.set(tokenId, { ...token, revokedAt: new Date().toISOString() });
    return true;
  }

  async setMember(repo: RepoId, userId: string, role: Role): Promise<void> {
    if (!this.repos.has(repo)) throw unknownRepo(repo);
    const user = this.users.get(userId);
    if (user === undefined) throw new Error(`no user ${userId}`);
    const key = `${repo}\n${userId}`;
    this.members.set(key, { repo, userId, login: user.login, role, resolver: this.members.get(key)?.resolver ?? false });
  }

  async removeMember(repo: RepoId, userId: string): Promise<boolean> {
    return this.members.delete(`${repo}\n${userId}`);
  }

  async listMembers(repo: RepoId): Promise<Member[]> {
    return [...this.members.values()].filter((m) => m.repo === repo).sort((a, b) => a.login.localeCompare(b.login));
  }

  async roleOf(repo: RepoId, userId: string): Promise<Role | undefined> {
    return this.members.get(`${repo}\n${userId}`)?.role;
  }

  async setResolver(repo: RepoId, userId: string, resolver: boolean): Promise<boolean> {
    const key = `${repo}\n${userId}`;
    const member = this.members.get(key);
    if (member === undefined) return false;
    this.members.set(key, { ...member, resolver });
    return true;
  }

  async setInvite(repo: RepoId, login: string, role: Role): Promise<void> {
    if (!this.repos.has(repo)) throw unknownRepo(repo);
    const key = `${repo}\n${login.toLowerCase()}`;
    this.invites.set(key, { repo, login: login.toLowerCase(), role, createdAt: this.invites.get(key)?.createdAt ?? new Date().toISOString() });
  }

  async listInvites(repo: RepoId): Promise<Invite[]> {
    return [...this.invites.values()].filter((i) => i.repo === repo).sort((a, b) => a.login.localeCompare(b.login));
  }

  async deleteInvite(repo: RepoId, login: string): Promise<boolean> {
    return this.invites.delete(`${repo}\n${login.toLowerCase()}`);
  }

  async park(input: ParkInput): Promise<Parked> {
    if (!this.repos.has(input.repo)) throw unknownRepo(input.repo);
    const parked: Parked = { ...input, id: newParkedId(), author: input.request.author, status: "open", createdAt: new Date().toISOString() };
    this.parked.set(parked.id, parked);
    return parked;
  }

  async listParked(repo: RepoId): Promise<Parked[]> {
    return [...this.parked.values()].filter((p) => p.repo === repo).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  async getParked(repo: RepoId, id: string): Promise<Parked | undefined> {
    const parked = this.parked.get(id);
    return parked?.repo === repo ? parked : undefined;
  }

  async openParkedBy(repo: RepoId, author: Author): Promise<Parked | undefined> {
    return [...this.parked.values()].find(
      (p) => p.repo === repo && p.status === "open" && p.author.developer === author.developer && p.author.agent === author.agent,
    );
  }

  async decideParked(repo: RepoId, id: string, decision: ParkDecision): Promise<boolean> {
    const parked = await this.getParked(repo, id);
    if (parked === undefined || parked.status !== "open") return false;
    this.parked.set(id, { ...parked, ...decision, decidedAt: new Date().toISOString() });
    return true;
  }

  async acceptInvites(user: User): Promise<RepoId[]> {
    const mine = [...this.invites.values()].filter((i) => i.login === user.login.toLowerCase());
    const joined: RepoId[] = [];
    for (const invite of mine) {
      this.invites.delete(`${invite.repo}\n${invite.login}`);
      if (this.members.has(`${invite.repo}\n${user.id}`)) continue;
      await this.setMember(invite.repo, user.id, invite.role);
      joined.push(invite.repo);
    }
    return joined;
  }

  async visibility(repo: RepoId): Promise<Visibility | undefined> {
    return this.repos.has(repo) ? (this.visibilities.get(repo) ?? "private") : undefined;
  }

  async setVisibility(repo: RepoId, visibility: Visibility): Promise<void> {
    if (!this.repos.has(repo)) throw unknownRepo(repo);
    this.visibilities.set(repo, visibility);
  }

  /** For tests. */
  intent(id: string): Intent | undefined {
    return this.intents.get(id);
  }
}
