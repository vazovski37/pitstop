import { randomBytes } from "node:crypto";
import { basename } from "node:path";
import { CommitResponse, type Author, type Changeset, type CommitRequest, type FileChange } from "@pitstop/protocol";
import { blobHash, type Applier } from "./jj.js";
import { readState, withWorktreeLock, writeState } from "./state.js";
import { EMPTY_SETS, hasTsProject, symbolSets, type SymbolSets } from "./symbols.js";

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

export interface ImportOptions extends Omit<CommitOptions, "intent"> {
  /** Defaults to `import <worktree name>`. */
  intent?: string;
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
 * `pitstop commit -m "<intent>"`: sends the agent's unfinished work in `@` as a commit request,
 * with the read and write sets from the TypeScript compiler API when the worktree has a
 * tsconfig.json (empty sets otherwise), and `readBaseLsn` when the daemon applied entries while
 * the agent worked.
 *
 * When accepted, the entry is applied here right away if it is the next one for this worktree,
 * so `main` moves to it without waiting for the stream. If other entries come first, the running
 * daemon applies them all in LSN order and this one with them.
 */
export async function commit(opts: CommitOptions): Promise<Changeset> {
  const files = await opts.applier.diffAgainstMain();
  if (files.length === 0) throw new Error("nothing to commit: @ has no changes against main");
  const state = await readState(opts.worktree);
  const sets = await setsOf(opts);
  const readBaseLsn =
    state.readBaseLsn !== undefined && state.readBaseLsn < state.appliedLsn ? state.readBaseLsn : undefined;
  return send(opts, {
    baseLsn: state.appliedLsn,
    ...(readBaseLsn === undefined ? {} : { readBaseLsn }),
    intent: opts.intent,
    files,
    ...sets,
  });
}

/**
 * `pitstop import`: the first entry of a repository, every tracked text file as an add, so the
 * server can rebuild the tree at any later entry (demo/scenario.md, "Start state"). Only for a
 * worktree that has applied nothing.
 */
export async function importWorktree(opts: ImportOptions): Promise<Changeset> {
  const state = await readState(opts.worktree);
  if (state.appliedLsn !== 0) {
    throw new Error(`this worktree is at #${state.appliedLsn}; import is only for a worktree that has applied nothing`);
  }
  const files: FileChange[] = [];
  for (const [path, content] of await opts.applier.treeFiles("@")) {
    if (content.includes("\0")) {
      opts.log?.(`skipped ${path}: binary files come later through GET /blobs`);
      continue;
    }
    files.push({ path, op: "add", blob: blobHash(content), content });
  }
  if (files.length === 0) throw new Error("nothing to import: the worktree has no text files");
  const intent = opts.intent ?? `import ${basename(opts.worktree)}`;
  return send(opts, { baseLsn: 0, intent, files, ...EMPTY_SETS });
}

async function setsOf(opts: CommitOptions): Promise<SymbolSets> {
  const after = await opts.applier.treeFiles("@");
  if (!hasTsProject(after)) {
    opts.log?.("no tsconfig.json in the worktree: empty symbol sets");
    return EMPTY_SETS;
  }
  const sets = symbolSets(await opts.applier.treeFiles("main"), after, opts.worktree);
  opts.log?.(
    `symbols: ${sets.writeSet.length} written (${sets.sigWriteSet.length} signatures), ${sets.readSet.length} read`,
  );
  return sets;
}

type Body = Omit<CommitRequest, "idempotencyKey" | "author" | "intentId">;

async function send(opts: Omit<CommitOptions, "intent">, body: Body): Promise<Changeset> {
  const request: CommitRequest = {
    idempotencyKey: `${opts.author.agent}-${randomBytes(8).toString("hex")}`,
    author: opts.author,
    ...(opts.intentId === undefined ? {} : { intentId: opts.intentId }),
    ...body,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  const res = await (opts.fetch ?? fetch)(new URL("/commit", opts.serverUrl), {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  const answer = CommitResponse.safeParse(await res.json().catch(() => undefined));
  if (!answer.success) throw new Error(`server answered ${res.status} with something that is not a CommitResponse`);
  if (answer.data.status === "rejected") {
    throw new CommitRejected(answer.data.reason, answer.data.message, answer.data.conflictsWith);
  }
  const changeset = answer.data.changeset;
  // The server has already pushed the entry to the stream, so a running daemon may be applying it
  // right now: take the lock and look at the state again. Either way the transaction is over, so
  // the state drops readBaseLsn.
  await withWorktreeLock(opts.worktree, async () => {
    const now = await readState(opts.worktree);
    if (now.appliedLsn >= changeset.lsn) {
      await writeState(opts.worktree, { appliedLsn: now.appliedLsn });
      opts.log?.(`accepted as #${changeset.lsn}; the daemon applied it`);
    } else if (changeset.lsn === now.appliedLsn + 1) {
      await opts.applier.apply(changeset);
      await writeState(opts.worktree, { appliedLsn: changeset.lsn });
      opts.log?.(`accepted as #${changeset.lsn}; main moved to it`);
    } else {
      await writeState(opts.worktree, { appliedLsn: now.appliedLsn });
      opts.log?.(
        `accepted as #${changeset.lsn}; entries #${now.appliedLsn + 1}..#${changeset.lsn - 1} come first, the daemon applies them in order`,
      );
    }
  });
  return changeset;
}
