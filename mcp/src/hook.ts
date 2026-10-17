#!/usr/bin/env node
/**
 * The Claude Code PostToolUse hook: the agent is between tools, a safe point. It tells the
 * worktree's daemon, which applies pending entries now and answers with notes for the agent
 * (entries that touched its work, conflicts, warnings). The notes go back as additional context.
 * When no daemon answers in a Pitstop checkout, it starts one (autostart.ts), waiting about three
 * seconds at most.
 *
 * It never fails the tool: without a daemon, or on any error, it prints nothing and exits 0.
 * The worktree is PITSTOP_WORKTREE, else the nearest directory with `.pitstop/config.json` at or
 * above the `cwd` Claude Code puts in the hook's input (or the current directory).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDaemon, findWorktree } from "./autostart.js";
import { BUNDLED } from "./build-info.js";
import { DaemonClient, NoDaemon } from "./client.js";

export interface HookInput {
  cwd?: string;
  tool_name?: string;
}

export interface HookOptions {
  client?: DaemonClient;
  /** Starts the daemon when none answers; true when one does afterwards. Absent: no start. */
  ensureDaemon?: (worktree: string) => Promise<boolean>;
}

/** The hook's budget for starting a daemon: a tool call waits on it. */
export const HOOK_START_WAIT_MS = 3_000;

/** What the hook prints for Claude Code, or an empty string for nothing. */
export async function safePointHook(input: HookInput, env: NodeJS.ProcessEnv = process.env, opts: HookOptions = {}): Promise<string> {
  const worktree = env.PITSTOP_WORKTREE ? resolve(env.PITSTOP_WORKTREE) : findWorktree(input.cwd ?? process.cwd());
  const client = opts.client ?? new DaemonClient(worktree);
  try {
    let result;
    try {
      result = await client.safePoint();
    } catch (err) {
      if (!(err instanceof NoDaemon) || opts.ensureDaemon === undefined || !(await opts.ensureDaemon(worktree))) return "";
      result = await client.safePoint();
    }
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

/** Runs the hook as this process: input on stdin, output on stdout, exit 0. packages/cli's `pitstop-hook` calls this. */
export function runHook(): void {
  readStdin()
    .then((text) => {
      let input: HookInput = {};
      try {
        input = JSON.parse(text) as HookInput;
      } catch {
        // no input: fine
      }
      return safePointHook(input, process.env, {
        ensureDaemon: async (worktree) => ["running", "started"].includes(await ensureDaemon(worktree, { waitMs: HOOK_START_WAIT_MS })),
      });
    })
    .then((out) => {
      if (out) process.stdout.write(`${out}\n`);
    })
    .catch(() => undefined);
}

// From source or dist/; in the bundle every module shares its file name, so its entry calls runHook.
const isMain = !BUNDLED && process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) runHook();
