#!/usr/bin/env node
/**
 * The Claude Code PostToolUse hook: the agent is between tools, a safe point. It tells the
 * worktree's daemon, which applies pending entries now and answers with notes for the agent
 * (entries that touched its work, conflicts, warnings). The notes go back as additional context.
 *
 * It never fails the tool: without a daemon, or on any error, it prints nothing and exits 0.
 * The worktree is PITSTOP_WORKTREE, else the `cwd` Claude Code puts in the hook's input, else
 * the current directory.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DaemonClient } from "./client.js";

export interface HookInput {
  cwd?: string;
  tool_name?: string;
}

/** What the hook prints for Claude Code, or an empty string for nothing. */
export async function safePointHook(input: HookInput, env: NodeJS.ProcessEnv = process.env, client?: DaemonClient): Promise<string> {
  const worktree = resolve(env.PITSTOP_WORKTREE ?? input.cwd ?? process.cwd());
  try {
    const result = await (client ?? new DaemonClient(worktree)).safePoint();
    if (result.notes.length === 0) return "";
    const lead = result.applied.length > 0 ? `Pitstop applied #${result.applied.join(", #")} to this worktree.` : "Pitstop:";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: [lead, ...result.notes].join("\n"),
      },
    });
  } catch {
    return "";
  }
}

const readStdin = (): Promise<string> =>
  new Promise((resolveText) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolveText(text));
    process.stdin.on("error", () => resolveText(text));
    if (process.stdin.isTTY) resolveText("");
  });

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  readStdin()
    .then((text) => {
      let input: HookInput = {};
      try {
        input = JSON.parse(text) as HookInput;
      } catch {
        // no input: fine
      }
      return safePointHook(input);
    })
    .then((out) => {
      if (out) process.stdout.write(`${out}\n`);
    })
    .catch(() => undefined);
}
