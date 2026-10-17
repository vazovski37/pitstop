import { createHash, randomBytes } from "node:crypto";
import type { Changeset, Checks, CommitRequest, Intent, IntentRequest, Lsn } from "@pitstop/protocol";

/**
 * What the server needs from its storage: the log, the blobs and the open intents.
 * `PgStore` (pg-store.ts) is the real one; `MemoryStore` serves tests and laptops without Postgres.
 */
export interface Store {
  /** Appends a changeset at the next LSN. The same idempotency key returns the same changeset. */
  append(req: CommitRequest): Promise<Changeset>;
  /** Entries with `lsn > fromLsn`, in LSN order, at most `limit` of them. */
  entriesAfter(fromLsn: Lsn, limit: number): Promise<Changeset[]>;
  headLsn(): Promise<Lsn>;
  openIntent(req: IntentRequest): Promise<Intent>;
  /** Refreshes an open intent's heartbeat. Unknown or closed intents are ignored. */
  heartbeat(intentId: string): Promise<void>;
}

/** Phase 1 appends without validating; the validator fills these in from Phase 4. */
export const SKIPPED_CHECKS: Checks = { typecheck: "skipped", tests: "skipped", adr: "skipped" };

export const blobHash = (content: string): string =>
  `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

export const newIntentId = (): string => `int_${randomBytes(4).toString("hex")}`;

/** The request cannot be appended as sent. The route answers `rejected` with `invalid_request`. */
export class InvalidCommit extends Error {}

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

export class MemoryStore implements Store {
  private readonly entries: Changeset[] = [];
  private readonly byKey = new Map<string, Changeset>();
  private readonly intents = new Map<string, Intent>();

  async append(req: CommitRequest): Promise<Changeset> {
    const seen = this.byKey.get(req.idempotencyKey);
    if (seen) return seen;
    const lsn = this.entries.length + 1;
    if (req.baseLsn >= lsn) throw new InvalidCommit(`baseLsn ${req.baseLsn} is not below the next LSN ${lsn}`);
    if (req.intentId !== undefined && !this.intents.has(req.intentId)) {
      throw new InvalidCommit(`unknown intent ${req.intentId}`);
    }
    const changeset: Changeset = {
      lsn,
      baseLsn: req.baseLsn,
      author: req.author,
      intent: req.intent,
      files: req.files,
      writeSet: req.writeSet,
      sigWriteSet: req.sigWriteSet,
      readSet: req.readSet,
      repairs: [],
      checks: SKIPPED_CHECKS,
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
