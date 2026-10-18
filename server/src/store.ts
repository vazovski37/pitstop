import { createHash, randomBytes } from "node:crypto";
import {
  DEFAULT_REPO,
  type Adr,
  type AdrRule,
  type Author,
  type Changeset,
  type Checks,
  type CommitRequest,
  type CommitResponse,
  type FileChange,
  type Intent,
  type IntentRequest,
  type Lease,
  type Lsn,
  type Repair,
  type Repo,
  type RepoId,
  type SymbolId,
} from "@pitstop/protocol";
import { globToRegExp } from "./adr-rules.js";

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
  getIntent(repo: RepoId, id: string): Promise<Intent | undefined>;
  /**
   * Refreshes an open intent's heartbeat, and renews its held leases by their time to live
   * (design doc 9.4: a lease lives while its intent does). Unknown or closed intents are ignored.
   */
  heartbeat(repo: RepoId, intentId: string): Promise<void>;
  /** Marks every open intent whose last heartbeat is before `before` stale (9.3), in every repository; returns them. */
  markStaleIntents(before: Date): Promise<Intent[]>;

  // The brain (design doc section 9, migration 009): ADRs, the brain version, leases.
  /** A proposed ADR with the repository's next number. An unknown repository is an `InvalidCommit`. */
  proposeAdr(proposal: AdrProposal): Promise<Adr>;
  /** By number. */
  listAdrs(repo: RepoId): Promise<Adr[]>;
  getAdr(repo: RepoId, number: number): Promise<Adr | undefined>;
  /**
   * An owner's verdict on an ADR, with the brain version moved in the same step when the rules in
   * force change (accepting or superseding; rejecting a proposal changes no rule).
   */
  decideAdr(repo: RepoId, number: number, verdict: AdrVerdict, by: string): Promise<AdrChange>;
  /** The repository's brain version: 0 until an ADR is accepted, then one more per accept or supersede. */
  brainVersion(repo: RepoId): Promise<number>;
  /** The ADRs that were accepted, and not yet superseded, at brain version `version` (9.2). */
  adrsInForce(repo: RepoId, version: number): Promise<Adr[]>;
  /**
   * Takes a lease atomically: granted when nobody else holds an unexpired one on the symbol (the
   * same holder renews it), refused with the holder otherwise. Held leases past their expiry on
   * the symbol are expired first. An unknown repository, or an intent that is not open, is an
   * `InvalidCommit`.
   */
  acquireLease(request: LeaseRequest, now?: Date): Promise<LeaseGrant>;
  /** Releases the held lease on the symbol, if there is one. */
  releaseLease(repo: RepoId, symbol: SymbolId, now?: Date): Promise<Lease | undefined>;
  /** Releases every lease the intent holds (it committed, or went stale). */
  releaseIntentLeases(repo: RepoId, intentId: string, now?: Date): Promise<Lease[]>;
  /** Expires every held lease past its expiry, in every repository; returns them. */
  expireLeases(now?: Date): Promise<Lease[]>;
  /** Held, unexpired leases of the repository, by symbol. */
  liveLeases(repo: RepoId, now?: Date): Promise<Lease[]>;

  // The query API (design doc section 10).
  /** Entries matching every filter given, oldest first unless `newestFirst`. */
  findEntries(repo: RepoId, query: LogQuery): Promise<LoggedEntry[]>;
  /** Every symbol the log saw written whose id starts with `prefix`, with its last writer, by id. */
  symbolStates(repo: RepoId, prefix: string, limit: number): Promise<SymbolState[]>;
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

/** What a writer proposes (`POST /repos/:o/:n/adrs`); the store gives it the next number. */
export interface AdrProposal {
  repo: RepoId;
  title: string;
  decision: string;
  reason?: string;
  consequences?: string;
  rules?: AdrRule[];
  createdBy: string;
}
/** An owner's verdict on an ADR. */
export type AdrVerdict = "accepted" | "rejected" | "superseded";
/** The status each verdict may be given from: a proposal is accepted or rejected, an accepted ADR superseded. */
export const ADR_TRANSITIONS: Record<AdrVerdict, Adr["status"]> = { accepted: "proposed", rejected: "proposed", superseded: "accepted" };
/** Whether a verdict changes the rules in force, and so moves the brain version. */
export const movesBrain = (verdict: AdrVerdict): boolean => verdict !== "rejected";
export type AdrChange =
  | { ok: true; adr: Adr; /** The repository's brain version after the change. */ version: number }
  | { ok: false; error: "not_found" }
  | { ok: false; error: "invalid_transition"; adr: Adr };

/** A lease asked for (`POST /repos/:o/:n/leases`, design doc 9.4). */
export interface LeaseRequest {
  repo: RepoId;
  symbol: SymbolId;
  holder: Author;
  intentId?: string;
  reason: string;
  ttlSeconds: number;
}
export type LeaseGrant =
  | { granted: true; lease: Lease; /** The holder already had it. */ renewed: boolean; /** Held leases on the symbol that had run out. */ expired: Lease[] }
  | { granted: false; /** The live lease someone else holds. */ holder: Lease; expired: Lease[] };
/** Seconds a lease lives without a heartbeat. */
export const LEASE_TTL = { default: 300, min: 60, max: 1_800 } as const;

export const sameAuthor = (a: Author, b: Author): boolean => a.developer === b.developer && a.agent === b.agent;

/** Filters for `Store.findEntries`: all given ones must hold. */
export interface LogQuery {
  /** Entries that wrote this symbol (write or signature write). */
  writes?: SymbolId;
  /** Entries whose read set holds this symbol. */
  reads?: SymbolId;
  /** Entries with a file (or a rename's old path) matching this glob (adr-rules.ts). */
  touches?: string;
  /** Entries with a file (or a rename's old path) among these. */
  paths?: string[];
  /** Only `lsn > since`. */
  since?: Lsn;
  newestFirst?: boolean;
  limit: number;
}
/** A log entry with the intent it closed, when it named one. */
export type LoggedEntry = Changeset & { intentId?: string };
/** A symbol as the log knows it: its last writer. */
export interface SymbolState {
  symbol: SymbolId;
  lsn: Lsn;
  /** Whether that entry changed its signature (or removed it). */
  signature: boolean;
  intent: string;
  intentId?: string;
  author: Author;
  createdAt: string;
}

/** What a decision records with the changeset. Defaults: skipped checks, no repairs, the files as sent. */
export interface Decision {
  checks?: Checks;
  repairs?: Repair[];
  /** The files to land instead of the request's: a repair's output, hashes filled in. */
  files?: FileChange[];
  /** The repository's brain version the commit was validated against (9.2); default the current one. */
  brainVersion?: number;
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
  /** `${repo}\n${lsn}` to the intent the entry closed. */
  private readonly entryIntents = new Map<string, string>();
  private readonly adrs = new Map<RepoId, Adr[]>();
  /** Each repository's brain version moves, in order. */
  private readonly brainLog = new Map<RepoId, { version: number; adr: number; status: "accepted" | "superseded" }[]>();
  private readonly leases: { lease: Lease; ttlSeconds: number }[] = [];

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
      brainVersion: decision.brainVersion ?? (await this.brainVersion(repo)),
      createdAt: new Date().toISOString(),
    };
    log.push(changeset);
    this.byKey.set(req.idempotencyKey, changeset);
    if (req.intentId !== undefined) this.entryIntents.set(`${repo}\n${lsn}`, req.intentId);
    // A stale intent whose agent came back and committed is closed too.
    if (intent?.status === "open" || intent?.status === "stale") this.intents.set(intent.id, { ...intent, status: "committed" });
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

  async getIntent(repo: RepoId, id: string): Promise<Intent | undefined> {
    const intent = this.intents.get(id);
    return intent?.repo === repo ? intent : undefined;
  }

  async heartbeat(repo: RepoId, intentId: string): Promise<void> {
    const intent = this.intents.get(intentId);
    if (intent?.status !== "open" || intent.repo !== repo) return;
    const now = Date.now();
    this.intents.set(intentId, { ...intent, heartbeatAt: new Date(now).toISOString() });
    for (const held of this.leases) {
      const l = held.lease;
      if (l.repo !== repo || l.intentId !== intentId || l.status !== "held" || Date.parse(l.expiresAt) <= now) continue;
      const renewed = now + held.ttlSeconds * 1000;
      if (renewed > Date.parse(l.expiresAt)) held.lease = { ...l, expiresAt: new Date(renewed).toISOString() };
    }
  }

  async markStaleIntents(before: Date): Promise<Intent[]> {
    const stale: Intent[] = [];
    for (const intent of this.intents.values()) {
      if (intent.status !== "open" || Date.parse(intent.heartbeatAt) >= before.getTime()) continue;
      const next: Intent = { ...intent, status: "stale" };
      this.intents.set(intent.id, next);
      stale.push(next);
    }
    return stale;
  }

  async proposeAdr(p: AdrProposal): Promise<Adr> {
    if (!this.repos.has(p.repo)) throw unknownRepo(p.repo);
    const list = this.adrs.get(p.repo) ?? [];
    const adr: Adr = {
      repo: p.repo,
      number: list.length + 1,
      title: p.title,
      status: "proposed",
      decision: p.decision,
      reason: p.reason ?? "",
      consequences: p.consequences ?? "",
      rules: p.rules ?? [],
      version: 0,
      createdBy: p.createdBy,
      createdAt: new Date().toISOString(),
    };
    this.adrs.set(p.repo, [...list, adr]);
    return adr;
  }

  async listAdrs(repo: RepoId): Promise<Adr[]> {
    return [...(this.adrs.get(repo) ?? [])];
  }

  async getAdr(repo: RepoId, number: number): Promise<Adr | undefined> {
    return this.adrs.get(repo)?.find((a) => a.number === number);
  }

  async decideAdr(repo: RepoId, number: number, verdict: AdrVerdict, by: string): Promise<AdrChange> {
    const list = this.adrs.get(repo) ?? [];
    const at = list.findIndex((a) => a.number === number);
    const adr = list[at];
    if (adr === undefined) return { ok: false, error: "not_found" };
    if (adr.status !== ADR_TRANSITIONS[verdict]) return { ok: false, error: "invalid_transition", adr };
    let version = await this.brainVersion(repo);
    if (movesBrain(verdict)) {
      version += 1;
      this.brainLog.set(repo, [...(this.brainLog.get(repo) ?? []), { version, adr: number, status: verdict as "accepted" | "superseded" }]);
    }
    const next: Adr = { ...adr, status: verdict, version: movesBrain(verdict) ? version : adr.version, decidedBy: by, decidedAt: new Date().toISOString() };
    list[at] = next;
    return { ok: true, adr: next, version };
  }

  async brainVersion(repo: RepoId): Promise<number> {
    return this.brainLog.get(repo)?.at(-1)?.version ?? 0;
  }

  async adrsInForce(repo: RepoId, version: number): Promise<Adr[]> {
    const last = new Map<number, string>();
    for (const move of this.brainLog.get(repo) ?? []) if (move.version <= version) last.set(move.adr, move.status);
    return (this.adrs.get(repo) ?? []).filter((a) => last.get(a.number) === "accepted");
  }

  async acquireLease(req: LeaseRequest, now = new Date()): Promise<LeaseGrant> {
    if (!this.repos.has(req.repo)) throw unknownRepo(req.repo);
    if (req.intentId !== undefined) {
      const intent = this.intents.get(req.intentId);
      if (intent === undefined || intent.repo !== req.repo) throw new InvalidCommit(`unknown intent ${req.intentId}`);
      if (intent.status !== "open") throw new InvalidCommit(`intent ${req.intentId} is ${intent.status}, not open`);
    }
    const expired = this.endLeases(
      (l) => l.repo === req.repo && l.symbol === req.symbol && l.status === "held" && Date.parse(l.expiresAt) <= now.getTime(),
      "expired",
    );
    const expiresAt = new Date(now.getTime() + req.ttlSeconds * 1000).toISOString();
    const held = this.leases.find((h) => h.lease.repo === req.repo && h.lease.symbol === req.symbol && h.lease.status === "held");
    if (held !== undefined) {
      if (!sameAuthor(held.lease.holder, req.holder)) return { granted: false, holder: held.lease, expired };
      const intentId = req.intentId ?? held.lease.intentId;
      held.lease = { ...held.lease, reason: req.reason, expiresAt, ...(intentId === undefined ? {} : { intentId }) };
      held.ttlSeconds = req.ttlSeconds;
      return { granted: true, lease: held.lease, renewed: true, expired };
    }
    const lease: Lease = {
      repo: req.repo,
      symbol: req.symbol,
      holder: req.holder,
      ...(req.intentId === undefined ? {} : { intentId: req.intentId }),
      reason: req.reason,
      status: "held",
      expiresAt,
      createdAt: now.toISOString(),
    };
    this.leases.push({ lease, ttlSeconds: req.ttlSeconds });
    return { granted: true, lease, renewed: false, expired };
  }

  async releaseLease(repo: RepoId, symbol: SymbolId): Promise<Lease | undefined> {
    return this.endLeases((l) => l.repo === repo && l.symbol === symbol && l.status === "held", "released")[0];
  }

  async releaseIntentLeases(repo: RepoId, intentId: string): Promise<Lease[]> {
    return this.endLeases((l) => l.repo === repo && l.intentId === intentId && l.status === "held", "released");
  }

  async expireLeases(now = new Date()): Promise<Lease[]> {
    return this.endLeases((l) => l.status === "held" && Date.parse(l.expiresAt) <= now.getTime(), "expired");
  }

  async liveLeases(repo: RepoId, now = new Date()): Promise<Lease[]> {
    return this.leases
      .map((h) => h.lease)
      .filter((l) => l.repo === repo && l.status === "held" && Date.parse(l.expiresAt) > now.getTime())
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  }

  private endLeases(match: (lease: Lease) => boolean, status: "released" | "expired"): Lease[] {
    const ended: Lease[] = [];
    for (const held of this.leases) {
      if (!match(held.lease)) continue;
      held.lease = { ...held.lease, status };
      ended.push(held.lease);
    }
    return ended;
  }

  async findEntries(repo: RepoId, q: LogQuery): Promise<LoggedEntry[]> {
    const touches = q.touches === undefined ? undefined : globToRegExp(q.touches);
    const paths = q.paths === undefined ? undefined : new Set(q.paths);
    const fileHit = (f: FileChange, hit: (path: string) => boolean) => hit(f.path) || (f.fromPath !== undefined && hit(f.fromPath));
    const found = (this.logs.get(repo) ?? []).filter(
      (e) =>
        e.lsn > (q.since ?? 0) &&
        (q.writes === undefined || e.writeSet.includes(q.writes) || e.sigWriteSet.includes(q.writes)) &&
        (q.reads === undefined || e.readSet.includes(q.reads)) &&
        (touches === undefined || e.files.some((f) => fileHit(f, (p) => touches.test(p)))) &&
        (paths === undefined || e.files.some((f) => fileHit(f, (p) => paths.has(p)))),
    );
    return (q.newestFirst ? found.reverse() : found).slice(0, q.limit).map((e) => this.logged(e));
  }

  async symbolStates(repo: RepoId, prefix: string, limit: number): Promise<SymbolState[]> {
    const latest = new Map<SymbolId, Changeset>();
    for (const e of this.logs.get(repo) ?? []) {
      for (const symbol of new Set([...e.writeSet, ...e.sigWriteSet])) if (symbol.startsWith(prefix)) latest.set(symbol, e);
    }
    return [...latest.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, limit)
      .map(([symbol, e]) => {
        const intentId = this.entryIntents.get(`${repo}\n${e.lsn}`);
        return {
          symbol,
          lsn: e.lsn,
          signature: e.sigWriteSet.includes(symbol),
          intent: e.intent,
          ...(intentId === undefined ? {} : { intentId }),
          author: e.author,
          createdAt: e.createdAt,
        };
      });
  }

  private logged(e: Changeset): LoggedEntry {
    const intentId = this.entryIntents.get(`${e.repo}\n${e.lsn}`);
    return intentId === undefined ? e : { ...e, intentId };
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
