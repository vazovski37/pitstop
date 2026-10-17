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
  /** The repository on the server; absent means its default one. */
  repo?: string;
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
  // The intent declared for this task (daemon state) unless the caller names one.
  const intentId = opts.intentId ?? state.intentId;
  return send({ ...opts, ...(intentId === undefined ? {} : { intentId }) }, {
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
    ...(opts.repo === undefined ? {} : { repo: opts.repo }),
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
    const { reason, message, conflictsWith } = answer.data;
    if ((reason === "escalated" || reason === "repair_failed") && conflictsWith.length > 0) {
      await reread(opts.worktree, conflictsWith, opts.log);
    }
    throw new CommitRejected(reason, message, conflictsWith);
  }
  const changeset = answer.data.changeset;
  // The server has already pushed the entry to the stream, so a running daemon may be applying it
  // right now: take the lock and look at the state again. Either way the transaction is over, so
  // the state drops readBaseLsn and the intent.
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

/**
 * A skew refusal names the entries whose changes the agent read past and tells it to re-read
 * them at head. From here the agent knows them, so the next commit's reads are checked from the
 * last of them rather than from where the work began, which would refuse the adapted commit for
 * the same skew, forever. The notes at a safe point are a heads-up (they only see the agent's
 * edits, not what it read before editing); the server's refusal is the authority. The value may
 * run ahead of the applied LSN while the daemon holds those entries for the next safe point.
 */
async function reread(worktree: string, conflictsWith: number[], log?: (line: string) => void): Promise<void> {
  await withWorktreeLock(worktree, async () => {
    const state = await readState(worktree);
    const readBaseLsn = Math.max(state.readBaseLsn ?? 0, ...conflictsWith);
    if (readBaseLsn === state.readBaseLsn) return;
    await writeState(worktree, { ...state, readBaseLsn });
    log?.(`reads are checked from #${readBaseLsn} from now on: the server named what to re-read`);
  });
}
