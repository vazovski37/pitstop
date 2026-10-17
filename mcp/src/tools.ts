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

const guarded = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NoDaemon) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
};

export const DESCRIPTIONS = {
  declare_intent:
    "Open a Pitstop transaction before you start a task: say what you will do and, if you know, which symbols (path#name) you will touch. Other agents see it, and the server warns about overlapping work. The next commit closes it.",
  commit:
    "Commit your unfinished work in this worktree to the Pitstop log with a one-line intent. The server validates it against entries that landed meanwhile; a rejection tells you exactly what changed and what to do.",
  why: "Which log entries touched a file, latest first: the intent behind it, who did it, and any repair.",
  callers: "Which log entries read a symbol (its callers, as far as the log knows) and which changed it. Symbols are path#qualified.name, e.g. src/auth/session.ts#getCurrentUser.",
  status: "Where this worktree stands: applied and head LSN, pending entries, your open intent, other agents' open intents.",
} as const;

export function makeTools(client: DaemonClient) {
  return {
    declare_intent: (text: string, symbols: string[] = []) =>
      guarded(async () => {
        const intent = await client.declareIntent(text, symbols);
        const declared = intent.declaredSymbols.length > 0 ? ` Declared: ${intent.declaredSymbols.join(", ")}.` : "";
        return ok(`Intent ${intent.id} is open at #${intent.baseLsn}: "${intent.text}".${declared} Use the commit tool when the work is done.`);
      }),

    commit: (intent: string) =>
      guarded(async () => {
        const answer = await client.commit(intent);
        if (answer.status === "accepted") {
          const cs = answer.changeset;
          const repaired = cs.repairs.length > 0 ? ` The server repaired it: ${cs.repairs.map((r) => r.summary).join("; ")}.` : "";
          return ok(`Committed as #${cs.lsn} "${cs.intent}" (${cs.files.length} file${cs.files.length === 1 ? "" : "s"}); main moved to it.${repaired}`);
        }
        const conflicts = answer.conflictsWith.length > 0 ? ` Conflicts with #${answer.conflictsWith.join(", #")}.` : "";
        const advice =
          answer.reason === "constraint_failed"
            ? " Those entries have been applied to your worktree where possible; re-read the files named above, adapt your change, and commit again."
            : answer.reason === "escalated" || answer.reason === "repair_failed"
              ? " Re-read what changed, adapt your change to it, and commit again."
              : "";
        return fail(`Commit rejected (${answer.reason}): ${answer.message}${conflicts}${advice}`);
      }),

    why: (path: string) =>
      guarded(async () => {
        const entries = await client.why(path);
        if (entries.length === 0) return ok(`No entry in the log touched ${path}.`);
        const lines = entries.map((e) => {
          const repaired = e.repairs.length > 0 ? ` Repaired: ${e.repairs.join("; ")}.` : "";
          return `#${e.lsn} ${e.agent} "${e.intent}" (${e.op}, ${e.createdAt}).${repaired}`;
        });
        return ok(lines.join("\n"));
      }),

    callers: (symbol: string) =>
      guarded(async () => {
        const { readers, writers } = await client.callers(symbol);
        if (readers.length === 0 && writers.length === 0) return ok(`No entry in the log read or changed ${symbol}.`);
        const line = (r: { lsn: number; agent: string; intent: string; files: string[] }) => `  #${r.lsn} ${r.agent} "${r.intent}" (${r.files.join(", ")})`;
        const parts: string[] = [];
        if (readers.length > 0) parts.push(`Read by:\n${readers.map(line).join("\n")}`);
        if (writers.length > 0) parts.push(`Changed by:\n${writers.map(line).join("\n")}`);
        return ok(parts.join("\n"));
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
