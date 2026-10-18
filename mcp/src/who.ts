/**
 * The `who` tool: who else is working in this repository right now (design doc 9.5, presence).
 * It reads the daemon's `GET /presence`, the live entries of the repository's presence document
 * (a CRDT every worktree's daemon writes its own key of), and says per agent: its developer,
 * working or idle, its intent, the files and symbols it is in, how fresh that is, and where its
 * worktree stands in the log. Files this worktree is in too are marked. A heads-up, never a lock.
 */
import type { DaemonClient, PresenceRow } from "./client.js";
import { guard, type ToolOptions, type ToolResult } from "./tools.js";

export const WHO_DESCRIPTION =
  "Who else is working in this repository right now: each agent, its developer, what it is doing (its intent), the files and symbols it is in, and how fresh that is. Use it before you start, or when a note says another agent is in your files. A heads-up, not a lock.";

const fresh = (ms: number): string => (ms < 5_000 ? "just now" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.round(ms / 60_000)}m ago`);

/** Up to `max` items, then how many more. */
const some = (items: string[], max = 8): string =>
  items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} and ${items.length - max} more`;

function line(e: PresenceRow, mine: PresenceRow | undefined): string {
  const doing = e.intent === undefined ? e.state : `${e.state} on "${e.intent}"`;
  const out = [`${e.author.agent} (${e.author.developer}) ${doing}, ${fresh(e.ageMs)}, at #${e.appliedLsn}`];
  if (e.files.length > 0) {
    const shared = mine === undefined ? [] : e.files.filter((f) => mine.files.includes(f));
    out.push(`  files: ${some(e.files)}${shared.length > 0 ? ` (you are in ${some(shared, 3)} too)` : ""}`);
  }
  if (e.symbols.length > 0) out.push(`  symbols: ${some(e.symbols)}`);
  return out.join("\n");
}

export function makeWho(client: DaemonClient, opts: ToolOptions = {}): () => Promise<ToolResult> {
  const guarded = guard(opts);
  return () =>
    guarded(async () => {
      const answer = await client.presence();
      const mine = answer.entries.find((e) => e.replica === answer.replica);
      const others = answer.entries.filter((e) => e.replica !== answer.replica);
      if (others.length === 0) return { text: "Nobody else is working in this repository right now." };
      const head = others.length === 1 ? "1 other worktree is here:" : `${others.length} other worktrees are here:`;
      return { text: [head, ...others.map((e) => line(e, mine))].join("\n") };
    });
}
