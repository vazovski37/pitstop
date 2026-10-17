import { randomBytes } from "node:crypto";
import { CommitResponse, type Author, type Changeset, type CommitRequest } from "@pitstop/protocol";
import type { Applier } from "./jj.js";
import { readState, writeState } from "./state.js";

export interface CommitOptions {
  /** The server's base URL, `http://` or `https://`. */
  serverUrl: string;
  token?: string;
  worktree: string;
  applier: Applier;
  intent: string;
  author: Author;
  /** The open intent this commit closes, when one was declared. */
  intentId?: string;
  log?: (line: string) => void;
  fetch?: typeof fetch;
}

export class CommitRejected extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly conflictsWith: number[],
  ) {
    super(`commit rejected (${reason}): ${message}`);
  }
}

/**
 * `pitstop commit -m "<intent>"`: sends the agent's unfinished work in `@` as a commit request.
 * Phase 1 sends empty read and write sets; Phase 2 fills them from the TypeScript compiler API.
 *
 * When accepted, the entry is applied here right away if it is the next one for this worktree,
 * so `main` moves to it without waiting for the stream. If other entries come first, the running
 * daemon applies them all in LSN order and this one with them.
 */
export async function commit(opts: CommitOptions): Promise<Changeset> {
  const files = await opts.applier.diffAgainstMain();
  if (files.length === 0) throw new Error("nothing to commit: @ has no changes against main");
  const { appliedLsn } = await readState(opts.worktree);
  const request: CommitRequest = {
    idempotencyKey: `${opts.author.agent}-${randomBytes(8).toString("hex")}`,
    baseLsn: appliedLsn,
    author: opts.author,
    intent: opts.intent,
    ...(opts.intentId === undefined ? {} : { intentId: opts.intentId }),
    files,
    writeSet: [],
    sigWriteSet: [],
    readSet: [],
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  const res = await (opts.fetch ?? fetch)(new URL("/commit", opts.serverUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  const body = CommitResponse.safeParse(await res.json().catch(() => undefined));
  if (!body.success) throw new Error(`server answered ${res.status} with something that is not a CommitResponse`);
  if (body.data.status === "rejected") {
    throw new CommitRejected(body.data.reason, body.data.message, body.data.conflictsWith);
  }
  const changeset = body.data.changeset;
  if (changeset.lsn === appliedLsn + 1) {
    await opts.applier.apply(changeset);
    await writeState(opts.worktree, { appliedLsn: changeset.lsn });
    opts.log?.(`accepted as #${changeset.lsn}; main moved to it`);
  } else {
    opts.log?.(
      `accepted as #${changeset.lsn}; entries #${appliedLsn + 1}..#${changeset.lsn - 1} come first, the daemon applies them in order`,
    );
  }
  return changeset;
}
