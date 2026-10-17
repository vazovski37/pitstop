import { createHash, randomBytes } from "node:crypto";
import type {
  Changeset,
  Checks,
  CommitRequest,
  CommitResponse,
  FileChange,
  Intent,
  IntentRequest,
  Lsn,
  Repair,
} from "@pitstop/protocol";

/**
 * What the server needs from its storage: the log, the blobs and the open intents.
 * `PgStore` (pg-store.ts) is the real one; `MemoryStore` serves tests and laptops without Postgres.
 */
export interface Store {
  /**
   * Appends a changeset at the next LSN. The same idempotency key returns the same changeset.
   * `decide`, when given, runs inside the append's critical section with every entry after
   * `gapStart(req)` (at most GAP_LIMIT + 1 of them) and the head LSN. It returns what to record
   * with the changeset, or throws `RejectedCommit` to refuse it. The validator lives there (validate.ts).
   */
  append(req: CommitRequest, decide?: Decide): Promise<Changeset>;
  /** Entries with `lsn > fromLsn`, in LSN order, at most `limit` of them. */
  entriesAfter(fromLsn: Lsn, limit: number): Promise<Changeset[]>;
  headLsn(): Promise<Lsn>;
  /**
   * Every file at `lsn`, path to text: the log folded up to that entry (the latest change per
   * path, deletes and renames applied). Needs the repository to have entered the log as a full
   * import at its first entry.
   */
  treeAt(lsn: Lsn): Promise<Tree>;
  openIntent(req: IntentRequest): Promise<Intent>;
  /** Refreshes an open intent's heartbeat. Unknown or closed intents are ignored. */
  heartbeat(intentId: string): Promise<void>;
}

/** Path to text. */
export type Tree = Map<string, string>;

/** What a decision records with the changeset. Defaults: skipped checks, no repairs. */
export interface Decision {
  checks?: Checks;
  repairs?: Repair[];
}
export type Decide = (gap: Changeset[], head: Lsn) => Decision | Promise<Decision>;

/** How far behind head a commit may be before the daemon must rebase first. */
export const GAP_LIMIT = 500;

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

/** Fills in a missing `blob` from `content`, and refuses a `blob` that is not its sha256. */
export function withBlobHashes(req: CommitRequest): CommitRequest {
  const files = req.files.map((f) => {
    if (f.content === undefined) return f;
    const hash = blobHash(f.content);
    if (f.blob !== undefined && f.blob !== hash) {
      throw new InvalidCommit(`${f.path}: blob ${f.blob} is not the sha256 of its content (${hash})`);
    }
    return { ...f, blob: hash };
  });
  return { ...req, files };
}

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
  private readonly entries: Changeset[] = [];
  private readonly byKey = new Map<string, Changeset>();
  private readonly intents = new Map<string, Intent>();

  async append(req: CommitRequest, decide?: Decide): Promise<Changeset> {
    const seen = this.byKey.get(req.idempotencyKey);
    if (seen) return seen;
    const lsn = this.entries.length + 1;
    if (req.baseLsn >= lsn) throw new InvalidCommit(`baseLsn ${req.baseLsn} is not below the next LSN ${lsn}`);
    if (req.intentId !== undefined && !this.intents.has(req.intentId)) {
      throw new InvalidCommit(`unknown intent ${req.intentId}`);
    }
    const gap = this.entries.filter((e) => e.lsn > gapStart(req)).slice(0, GAP_LIMIT + 1);
    const decision = decide ? await decide(gap, lsn - 1) : {};
    const changeset: Changeset = {
      lsn,
      baseLsn: req.baseLsn,
      author: req.author,
      intent: req.intent,
      files: req.files,
      writeSet: req.writeSet,
      sigWriteSet: req.sigWriteSet,
      readSet: req.readSet,
      repairs: decision.repairs ?? [],
      checks: decision.checks ?? SKIPPED_CHECKS,
      brainVersion: 0,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(changeset);
    this.byKey.set(req.idempotencyKey, changeset);
    const intent = req.intentId === undefined ? undefined : this.intents.get(req.intentId);
    if (intent?.status === "open") this.intents.set(intent.id, { ...intent, status: "committed" });
    return changeset;
  }

  async entriesAfter(fromLsn: Lsn, limit: number): Promise<Changeset[]> {
    return this.entries.filter((e) => e.lsn > fromLsn).slice(0, limit);
  }

  async headLsn(): Promise<Lsn> {
    return this.entries.length;
  }

  async treeAt(lsn: Lsn): Promise<Tree> {
    const tree: Tree = new Map();
    for (const entry of this.entries) if (entry.lsn <= lsn) applyFiles(tree, entry.files);
    return tree;
  }

  async openIntent(req: IntentRequest): Promise<Intent> {
    const intent: Intent = {
      id: newIntentId(),
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

  async heartbeat(intentId: string): Promise<void> {
    const intent = this.intents.get(intentId);
    if (intent?.status === "open") this.intents.set(intentId, { ...intent, heartbeatAt: new Date().toISOString() });
  }

  /** For tests. */
  intent(id: string): Intent | undefined {
    return this.intents.get(id);
  }
}
