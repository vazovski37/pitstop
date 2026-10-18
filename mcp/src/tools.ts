/**
 * The tools as plain functions returning the text the agent sees, so they can be tested without
 * the MCP transport. index.ts registers them. Outputs stay short: they land in the agent's context.
 */
import { DaemonClient, NoDaemon } from "./client.js";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ text });
const fail = (text: string): ToolResult => ({ text, isError: true });

export interface ToolOptions {
  /**
   * Starts the worktree's daemon when a tool finds none (autostart.ts); true when one answers
   * afterwards, and the tool is tried once more.
   */
  ensureDaemon?: () => Promise<boolean>;
}

/** Runs a tool: a missing daemon is started once (when `ensureDaemon` is given), any failure becomes the tool's error text. */
export const guard =
  (opts: ToolOptions) =>
  async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof NoDaemon) || opts.ensureDaemon === undefined) throw err;
        if (!(await opts.ensureDaemon())) return fail(`${err.message} Starting one did not work: .pitstop/daemon.log there says why.`);
        return await fn();
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

export const DESCRIPTIONS = {
  declare_intent:
    "Open a Pitstop transaction before you start a task: say what you will do and, if you know, which symbols (path#name) you will touch. Other agents see it, and the server warns about overlapping work. The next commit closes it.",
  commit:
    "Commit your unfinished work in this worktree to the Pitstop log with a one-line intent. The server validates it against entries that landed meanwhile; a rejection tells you exactly what changed and what to do.",
  why: "Which log entries touched a file, latest first: the intent behind it, who did it, and any repair.",
  callers: "Which log entries read a symbol (its callers, as far as the log knows: from read sets, not a call graph) and what they changed, and which entries changed the symbol. Symbols are path#qualified.name, e.g. src/auth/session.ts#getCurrentUser.",
  status: "Where this worktree stands: applied and head LSN, pending entries, your open intent, other agents' open intents.",
  brain:
    "The repository's brain: its version, the accepted architecture decisions (ADRs) with the rules every commit is checked against, the live leases on symbols, and the open intents.",
  lease:
    "Take a short lease on one hot symbol (path#name) before a risky change to it, with a reason: while you hold it, another agent's commit that writes it is refused. Declare your intent first: the lease lasts while that intent is open (your daemon renews it) and is released when you commit; release it early with release: true. Refused when another agent holds it.",
  history: "Every change to a symbol (path#name), newest first: who, which intent, whether its signature changed, and who has it declared or leased now.",
} as const;

/**
 * A refused commit as the agent reads it: the prefix once, the server's message, the entries it
 * conflicts with, and advice only where the server gives none. A held (parked) or bounced-back
 * write skew, a commit waiting for the resolver, and ADR and lease refusals say what to do
 * themselves; a generic "commit again" would contradict the first two.
 */
export function refusal(answer: { reason: string; message: string; conflictsWith: number[] }): string {
  // A daemon started before 0.1.6 sends its own `commit rejected (<reason>): ` line.
  const message = answer.message.replace(/^commit rejected \([^)]*\): /, "").trimEnd();
  const stop = /[.!?]$/.test(message) ? "" : ".";
  const conflicts = answer.conflictsWith.length > 0 ? ` Conflicts with #${answer.conflictsWith.join(", #")}.` : "";
  let advice = "";
  if (answer.reason === "constraint_failed" && answer.conflictsWith.length > 0) {
    // Write-write: the server says "rebase and retry", which the daemon does at a safe point.
    advice = " Pitstop applies those entries to your worktree by your next tool call (do not rebase or merge yourself); then re-read the files named above, adapt your change, and commit again.";
  } else if (answer.reason === "constraint_failed" && message.startsWith("type check failed")) {
    advice = " Fix those errors in your change and commit again.";
  }
  return `Commit rejected (${answer.reason}): ${message}${stop}${conflicts}${advice}`;
}

export function makeTools(client: DaemonClient, opts: ToolOptions = {}) {
  const guarded = guard(opts);
  return {
    declare_intent: (text: string, symbols: string[] = []) =>
      guarded(async () => {
        const intent = await client.declareIntent(text, symbols);
        const declared = intent.declaredSymbols.length > 0 ? ` Declared: ${intent.declaredSymbols.join(", ")}.` : "";
        const brief = intent.brief === undefined || intent.brief.length === 0 ? "" : `\n${intent.brief.join("\n")}`;
        return ok(`Intent ${intent.id} is open at #${intent.baseLsn}: "${intent.text}".${declared} Use the commit tool when the work is done.${brief}`);
      }),

    commit: (intent: string) =>
      guarded(async () => {
        const answer = await client.commit(intent);
        if (answer.status === "accepted") {
          const cs = answer.changeset;
          const repaired = cs.repairs.length > 0 ? ` The server repaired it: ${cs.repairs.map((r) => r.summary).join("; ")}.` : "";
          return ok(`Committed as #${cs.lsn} "${cs.intent}" (${cs.files.length} file${cs.files.length === 1 ? "" : "s"}); main moved to it.${repaired}`);
        }
        return fail(refusal(answer));
      }),

    why: (path: string) =>
      guarded(async () => {
        const entries = await client.why(path);
        if (entries.length === 0) return ok(`No entry in the log touched ${path}.`);
        const lines = entries.map((e) => {
          const repaired = e.repairs.length > 0 ? ` Repaired: ${e.repairs.join("; ")}.` : "";
          const brain = e.brainVersion === undefined || e.brainVersion === 0 ? "" : `, brain v${e.brainVersion}`;
          return `#${e.lsn} ${e.agent} "${e.intent}" (${e.op}, ${e.createdAt}${brain}).${repaired}`;
        });
        return ok(lines.join("\n"));
      }),

    callers: (symbol: string) =>
      guarded(async () => {
        const { readers, writers, note } = await client.callers(symbol);
        if (readers.length === 0 && writers.length === 0) return ok(`No entry in the log read or changed ${symbol}.`);
        const line = (r: { lsn: number; agent: string; intent: string; files: string[]; wrote?: string[] }) =>
          `  #${r.lsn} ${r.agent} "${r.intent}" (${r.wrote !== undefined && r.wrote.length > 0 ? `wrote ${r.wrote.join(", ")}` : r.files.join(", ")})`;
        const parts: string[] = [];
        if (readers.length > 0) parts.push(`Read by${note === undefined ? "" : ` (${note})`}:\n${readers.map(line).join("\n")}`);
        if (writers.length > 0) parts.push(`Changed by:\n${writers.map(line).join("\n")}`);
        return ok(parts.join("\n"));
      }),

    brain: () =>
      guarded(async () => {
        const { lines } = await client.brain();
        return ok(lines.join("\n"));
      }),

    lease: (symbol: string, opts: { reason?: string; minutes?: number; release?: boolean } = {}) =>
      guarded(async () => {
        const answer = await client.lease(symbol, {
          ...(opts.reason === undefined ? {} : { reason: opts.reason }),
          ...(opts.minutes === undefined ? {} : { ttlSeconds: Math.round(opts.minutes * 60) }),
          ...(opts.release === true ? { release: true } : {}),
        });
        if (answer.status === "leased") return fail(`Lease refused: ${answer.message}. Leave that symbol alone (a commit writing it is refused) or wait until the lease ends.`);
        if (answer.status === "not_held") return ok(`You hold no lease on ${symbol} (it expired or was released); nothing to release.`);
        if (answer.status === "invalid") {
          const closed = /not open/.test(answer.message) ? " Your intent is closed or stale: call declare_intent again, then take the lease." : "";
          return fail(`Lease not taken: ${answer.message.replace(/\.$/, "")}.${closed}`);
        }
        if (answer.status === "released") return ok(`Released the lease on ${symbol}.`);
        return ok(`Lease taken: ${answer.message}. Other agents' commits that write it are refused until you commit (which releases it) or it expires; your daemon renews it while your intent is open.`);
      }),

    history: (symbol: string) =>
      guarded(async () => {
        const h = await client.history(symbol);
        const lines = h.history.map((e) => `#${e.lsn} ${e.author.agent} "${e.intent}"${e.intentId === undefined ? "" : ` (${e.intentId})`}${e.signature ? ", signature changed" : ""} at ${e.createdAt}`);
        if (h.declaredBy.length > 0) lines.push(`Declared now by: ${h.declaredBy.map((i) => `${i.author.agent} "${i.text}" (${i.id})`).join("; ")}`);
        if (h.lease !== undefined) lines.push(`Leased to ${h.lease.holder.agent} (${h.lease.holder.developer}) until ${h.lease.expiresAt}${h.lease.reason ? `: ${h.lease.reason}` : ""}`);
        return ok(lines.length === 0 ? `No entry in the log changed ${symbol}.` : lines.join("\n"));
      }),

    status: () =>
      guarded(async () => {
        const s = await client.status();
        const head = s.headLsn === null ? "head unknown" : `head #${s.headLsn}`;
        const pending = s.pending === 0 ? "nothing pending" : `${s.pending} pending (applied at your next safe point)`;
        const mine = s.intent ? `your intent ${s.intent.id} "${s.intent.text}" is open` : "no open intent of yours";
        const others = s.openIntents.filter((i) => i.id !== s.intent?.id);
        const elsewhere = others.length === 0 ? "" : `\nOpen elsewhere: ${others.map((i) => `${i.id} ${i.agent} "${i.text}"`).join("; ")}`;
        return ok(`${s.worktree} is at #${s.appliedLsn} (${head}), ${pending}; ${mine}.${elsewhere}`);
      }),
  };
}

export type Tools = ReturnType<typeof makeTools>;
