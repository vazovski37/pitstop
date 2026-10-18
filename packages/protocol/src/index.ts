/**
 * The contract between the server and the daemons.
 *
 * Every message that crosses the network is defined here once, as a zod schema
 * (checked at runtime) and the TypeScript type derived from it (checked at build time).
 * Change this file only when both owners agree: it is the interface between the two halves.
 *
 * Design reference: the technical design doc (written when the project was called Agent Git), sections 5.2 (changeset), 6.2 (intents and commits) and 8.2 (stream).
 */
import { z } from "zod";
import { PresenceEntry } from "./presence.js";

export * from "./presence.js";

/** Position in the write-ahead log. Strictly increasing, no gaps. */
export const Lsn = z.number().int().nonnegative();
export type Lsn = z.infer<typeof Lsn>;

/** `path#qualified.name`, e.g. `src/auth/session.ts#getCurrentUser`. */
export const SymbolId = z.string().regex(/^[^#]+#.+$/, "expected path#qualified.name");
export type SymbolId = z.infer<typeof SymbolId>;

/** Content address of a file blob: `sha256:<64 hex>`. */
export const BlobHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type BlobHash = z.infer<typeof BlobHash>;

/** A repository on the server: `owner/name`, lowercase, e.g. `vazovski37/pitstop`. LSNs count per repository. */
export const RepoId = z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/, "expected owner/name in lowercase");
export type RepoId = z.infer<typeof RepoId>;

/** The repository a request without `repo` means: one server, one repo, as in Phase 1. */
export const DEFAULT_REPO: RepoId = "local/default";

/** A repository as the server lists it (`GET /repos`, `POST /repos`). */
export const Repo = z.object({
  id: RepoId,
  headLsn: Lsn,
  createdAt: z.string().datetime(),
});
export type Repo = z.infer<typeof Repo>;

export const Author = z.object({
  developer: z.string().min(1),
  agent: z.string().min(1),
});
export type Author = z.infer<typeof Author>;

export const FileChange = z.object({
  path: z.string().min(1),
  op: z.enum(["add", "modify", "delete", "rename"]),
  /** Absent for deletes. */
  blob: BlobHash.optional(),
  /**
   * The file's text (utf-8), so a daemon can write a file it never had.
   * Present on adds, modifies and renames that change content; absent for deletes.
   * The server stores it in `blobs` under `blob`. Binary files come later through `GET /blobs/:hash`.
   */
  content: z.string().optional(),
  /** Only for renames. */
  fromPath: z.string().optional(),
});
export type FileChange = z.infer<typeof FileChange>;

export const Repair = z.object({
  againstLsn: Lsn,
  kind: z.enum(["structural", "semantic"]),
  summary: z.string(),
});
export type Repair = z.infer<typeof Repair>;

export const CheckResult = z.enum(["pass", "fail", "skipped"]);

export const Checks = z.object({
  typecheck: CheckResult,
  tests: CheckResult,
  adr: CheckResult,
  details: z.string().optional(),
});
export type Checks = z.infer<typeof Checks>;

/** What a daemon sends to ask for a commit (section 6.2, step 5). */
export const CommitRequest = z.object({
  /** Same key on a retry = same commit; the server never appends it twice. */
  idempotencyKey: z.string().min(8),
  /** The repository to commit to. Absent means `DEFAULT_REPO`. */
  repo: RepoId.optional(),
  /** The entry the file contents are based on: the worktree's applied LSN when the commit was made. */
  baseLsn: Lsn,
  /**
   * The entry the transaction began at, when the daemon applied entries to the worktree while the
   * agent worked. The server checks reads from here and writes from `baseLsn` (section 7.3).
   * Absent means the same as `baseLsn`.
   */
  readBaseLsn: Lsn.optional(),
  author: Author,
  intent: z.string().min(1),
  /** The open intent this commit closes (from `POST /intents`). Absent when none was declared. */
  intentId: z.string().optional(),
  files: z.array(FileChange).min(1),
  writeSet: z.array(SymbolId),
  /** Symbols whose public shape (parameters, return type) changed. Subset of writeSet. */
  sigWriteSet: z.array(SymbolId).default([]),
  readSet: z.array(SymbolId),
});
export type CommitRequest = z.infer<typeof CommitRequest>;

/** A changeset as stored in the log (section 5.2). */
export const Changeset = z.object({
  repo: RepoId,
  lsn: Lsn,
  baseLsn: Lsn,
  author: Author,
  intent: z.string(),
  files: z.array(FileChange),
  writeSet: z.array(SymbolId),
  sigWriteSet: z.array(SymbolId),
  readSet: z.array(SymbolId),
  repairs: z.array(Repair),
  checks: Checks,
  brainVersion: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});
export type Changeset = z.infer<typeof Changeset>;

/** Server's answer to a commit request. */
export const CommitResponse = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), changeset: Changeset }),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum(["constraint_failed", "repair_failed", "escalated", "invalid_request"]),
    message: z.string(),
    /** The entries the commit conflicted with, if any. */
    conflictsWith: z.array(Lsn).default([]),
  }),
]);
export type CommitResponse = z.infer<typeof CommitResponse>;

/**
 * A rule an ADR makes checkable (section 9.1). Mechanical rules run on every commit whose files
 * match `files` (a glob such as `src/ui/**`); `ai_review` is advisory and asked of a model only
 * when one is configured.
 */
export const AdrRule = z.discriminatedUnion("kind", [
  /** Files matching `files` may not import a module matching `target` (a path glob such as `src/db/**`, or a package name). */
  z.object({ kind: z.literal("forbid_import"), files: z.string().min(1), target: z.string().min(1) }),
  /** Files matching `files` may not call `call` (an identifier, or `object.method`). */
  z.object({ kind: z.literal("forbid_call"), files: z.string().min(1), call: z.string().min(1) }),
  /** Files matching `files` may not contain text matching `pattern` (a regular expression). */
  z.object({ kind: z.literal("forbid_pattern"), files: z.string().min(1), pattern: z.string().min(1), message: z.string().optional() }),
  /** A question a model answers about changes to files matching `files`; never refuses a commit on its own. */
  z.object({ kind: z.literal("ai_review"), files: z.string().min(1), question: z.string().min(1) }),
]);
export type AdrRule = z.infer<typeof AdrRule>;

/**
 * An architecture decision record (section 9.1): text every agent receives at the start of a
 * task, and rules every commit is checked against. Accepting, superseding or rejecting one moves
 * the repository's brain version (section 9.2); each changeset records the version it passed.
 */
export const Adr = z.object({
  repo: RepoId,
  /** ADR-<number>, per repository, from 1. */
  number: z.number().int().positive(),
  title: z.string().min(1).max(200),
  status: z.enum(["proposed", "accepted", "superseded", "rejected"]),
  /** The decision, in a sentence or two. */
  decision: z.string().min(1),
  /** Why. */
  reason: z.string().default(""),
  consequences: z.string().default(""),
  rules: z.array(AdrRule).default([]),
  /** The brain version its last status change produced; 0 while proposed. */
  version: z.number().int().nonnegative(),
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().datetime().optional(),
});
export type Adr = z.infer<typeof Adr>;

/**
 * A lease (section 9.4): a short, expiring lock on one symbol, granted by the server to exactly
 * one agent. While it is held, a commit by anyone else that writes the symbol is refused.
 */
export const Lease = z.object({
  repo: RepoId,
  symbol: SymbolId,
  holder: Author,
  /** The intent it belongs to: committing or abandoning it releases the lease. */
  intentId: z.string().optional(),
  reason: z.string().default(""),
  status: z.enum(["held", "released", "expired"]),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type Lease = z.infer<typeof Lease>;

/** An open transaction in the catalog (section 9.3). */
export const Intent = z.object({
  id: z.string().min(1),
  repo: RepoId,
  author: Author,
  baseLsn: Lsn,
  text: z.string().min(1),
  declaredSymbols: z.array(SymbolId).default([]),
  status: z.enum(["open", "committed", "abandoned", "stale"]),
  heartbeatAt: z.string().datetime(),
});
export type Intent = z.infer<typeof Intent>;

/** What a daemon sends to open a transaction: `POST /intents`, answered with an `Intent` (section 6.2, step 1). */
export const IntentRequest = z.object({
  /** Absent means `DEFAULT_REPO`. */
  repo: RepoId.optional(),
  author: Author,
  baseLsn: Lsn,
  text: z.string().min(1),
  /** Symbols the agent expects to touch; the server uses them for early warnings (section 9.3). */
  declaredSymbols: z.array(SymbolId).default([]),
});
export type IntentRequest = z.infer<typeof IntentRequest>;

/**
 * Messages the server pushes to daemons over the WebSocket (section 8.2).
 *
 * Order on a connection: `hello` first (its `headLsn` is `DEFAULT_REPO`'s); then, after
 * `subscribe`, a `head` for the subscribed repository, one `entry` per log position after
 * `fromLsn`, in LSN order with no gaps, then live entries as they are appended. A socket follows
 * one repository. `intent` and `warning` for that repository can arrive at any time after `hello`.
 */
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), serverVersion: z.string(), headLsn: Lsn }),
  /** Answers `subscribe`: where the repository's log stands at that moment. */
  z.object({ type: z.literal("head"), repo: RepoId, headLsn: Lsn }),
  z.object({ type: z.literal("entry"), changeset: Changeset }),
  z.object({ type: z.literal("intent"), intent: Intent }),
  z.object({
    type: z.literal("warning"),
    repo: RepoId,
    /** Who the warning is for. */
    agent: z.string(),
    kind: z.enum(["overlapping_intent", "similar_symbol", "dependency_changed"]),
    message: z.string(),
    symbols: z.array(SymbolId).default([]),
  }),
  /** The brain changed (section 9.2): an ADR was proposed, accepted, superseded or rejected; `version` is the repository's brain version now. */
  z.object({ type: z.literal("brain"), repo: RepoId, version: z.number().int().nonnegative(), adr: Adr }),
  /** A lease was granted, released or expired (section 9.4). */
  z.object({ type: z.literal("lease"), lease: Lease }),
  /**
   * Presence (section 9.5, `presence.ts`): entries to merge into the repository's presence
   * document. After `subscribe`, the whole document; then each update as it is merged.
   */
  z.object({ type: z.literal("presence"), repo: RepoId, entries: z.array(PresenceEntry) }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Messages a daemon sends to the server over the WebSocket. */
export const ClientMessage = z.discriminatedUnion("type", [
  /**
   * Start streaming every entry after `fromLsn` (the worktree's applied LSN; 0 for an empty worktree).
   * A daemon that sees a gap in LSNs subscribes again from its last applied LSN.
   */
  z.object({
    type: z.literal("subscribe"),
    /** Absent means `DEFAULT_REPO`. */
    repo: RepoId.optional(),
    fromLsn: Lsn,
  }),
  z.object({
    type: z.literal("heartbeat"),
    /** The open intent to keep alive, if any. */
    intentId: z.string().optional(),
    /** The LSN this worktree has applied, so the live view can show it against the head. */
    appliedLsn: Lsn.optional(),
  }),
  /** This worktree's presence (section 9.5): the server merges it into the repository's document and passes it on. */
  z.object({ type: z.literal("presence"), entry: PresenceEntry }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Response of GET /healthz. Used by the deploy smoke test. */
export const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.boolean(),
});
export type Health = z.infer<typeof Health>;
