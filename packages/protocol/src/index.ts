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

/** Position in the write-ahead log. Strictly increasing, no gaps. */
export const Lsn = z.number().int().nonnegative();
export type Lsn = z.infer<typeof Lsn>;

/** `path#qualified.name`, e.g. `src/auth/session.ts#getCurrentUser`. */
export const SymbolId = z.string().regex(/^[^#]+#.+$/, "expected path#qualified.name");
export type SymbolId = z.infer<typeof SymbolId>;

/** Content address of a file blob: `sha256:<64 hex>`. */
export const BlobHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type BlobHash = z.infer<typeof BlobHash>;

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
  baseLsn: Lsn,
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

/** An open transaction in the catalog (section 9.3). */
export const Intent = z.object({
  id: z.string().min(1),
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
 * Order on a connection: `hello` first; then, after `subscribe`, one `entry` per log position
 * after `fromLsn`, in LSN order with no gaps; then live entries as they are appended.
 * `intent` and `warning` can arrive at any time after `hello`.
 */
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), serverVersion: z.string(), headLsn: Lsn }),
  z.object({ type: z.literal("entry"), changeset: Changeset }),
  z.object({ type: z.literal("intent"), intent: Intent }),
  z.object({
    type: z.literal("warning"),
    /** Who the warning is for. */
    agent: z.string(),
    kind: z.enum(["overlapping_intent", "similar_symbol", "dependency_changed"]),
    message: z.string(),
    symbols: z.array(SymbolId).default([]),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Messages a daemon sends to the server over the WebSocket. */
export const ClientMessage = z.discriminatedUnion("type", [
  /**
   * Start streaming every entry after `fromLsn` (the worktree's applied LSN; 0 for an empty worktree).
   * A daemon that sees a gap in LSNs subscribes again from its last applied LSN.
   */
  z.object({ type: z.literal("subscribe"), fromLsn: Lsn }),
  z.object({
    type: z.literal("heartbeat"),
    /** The open intent to keep alive, if any. */
    intentId: z.string().optional(),
    /** The LSN this worktree has applied, so the live view can show it against the head. */
    appliedLsn: Lsn.optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Response of GET /healthz. Used by the deploy smoke test. */
export const Health = z.object({
  ok: z.boolean(),
  version: z.string(),
  db: z.boolean(),
});
export type Health = z.infer<typeof Health>;
