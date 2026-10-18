#!/usr/bin/env node
/**
 * The Pitstop MCP server for coding agents (Claude Code for the hackathon), over stdio.
 * Tools: declare_intent, commit, why, callers, history, brain, lease, status. Each talks to the
 * worktree's daemon (its port in .pitstop/daemon.json), never to the server.
 *
 * The worktree is PITSTOP_WORKTREE, else the nearest directory at or above the current one with
 * `.pitstop/config.json` (Claude Code starts MCP servers in the project directory). When no daemon
 * answers there, the server starts one (autostart.ts). Wiring: `pitstop setup` writes .mcp.json and
 * the hook by command name (daemon/src/wire.ts); `pitstop-agent-setup <worktree>` (setup.ts) does it
 * with absolute paths to a from-source build.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ensureDaemon, findWorktree, type EnsureResult } from "./autostart.js";
import { BUNDLED } from "./build-info.js";
import { DaemonClient } from "./client.js";
import { DESCRIPTIONS, makeTools, type ToolResult } from "./tools.js";

export { DaemonClient, NoDaemon } from "./client.js";
export { DESCRIPTIONS, makeTools } from "./tools.js";
export { ensureDaemon, findWorktree } from "./autostart.js";

export const worktreeFromEnv = (env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string =>
  env.PITSTOP_WORKTREE ? resolve(env.PITSTOP_WORKTREE) : findWorktree(cwd);

/** The house rules, in the MCP handshake; `pitstop setup` also writes them to CLAUDE.local.md (daemon/src/wire.ts). */
export const INSTRUCTIONS = [
  "This checkout is a live replica of a Pitstop repository: other agents commit to the same ordered log, and their entries land here between your tool calls.",
  "Before changing code, call declare_intent with one line on what you will do (and the path#name symbols you expect to touch, when you know them).",
  "Commit only with the commit tool. Never run git commit, git push, jj commit or jj git push, and never move or reset main: the daemon owns them.",
  "A refused commit says what changed meanwhile: re-read the files and symbols it names, adapt your change, and commit again. Do not work around it.",
  'A note starting with "Pitstop" after a tool call means entries landed here: re-read what it names before going on.',
  "declare_intent answers with the repository's architecture decisions (ADRs): follow them, a commit that breaks one is refused. A symbol another agent leased is theirs until the lease ends; take a lease (lease tool) before a risky change to a symbol others use.",
].join("\n");

const asContent = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  ...(result.isError ? { isError: true } : {}),
});

export interface ServerOptions {
  /** Starts the daemon when a tool finds none; true when one answers afterwards. */
  ensureDaemon?: () => Promise<boolean>;
}

export function buildServer(worktree: string, opts: ServerOptions = {}): McpServer {
  const tools = makeTools(new DaemonClient(worktree), opts.ensureDaemon === undefined ? {} : { ensureDaemon: opts.ensureDaemon });
  const server = new McpServer({ name: "pitstop", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "declare_intent",
    {
      title: "Declare an intent",
      description: DESCRIPTIONS.declare_intent,
      inputSchema: {
        text: z.string().min(1).describe("What you are about to do, one line"),
        symbols: z.array(z.string()).optional().describe("Symbols you expect to touch, as path#qualified.name"),
      },
    },
    async ({ text, symbols }) => asContent(await tools.declare_intent(text, symbols ?? [])),
  );

  server.registerTool(
    "commit",
    {
      title: "Commit to the Pitstop log",
      description: DESCRIPTIONS.commit,
      inputSchema: { intent: z.string().min(1).describe("One line: what this change does") },
    },
    async ({ intent }) => asContent(await tools.commit(intent)),
  );

  server.registerTool(
    "why",
    {
      title: "Why does a file look like this",
      description: DESCRIPTIONS.why,
      inputSchema: { path: z.string().min(1).describe("Path relative to the worktree, e.g. src/auth/session.ts") },
    },
    async ({ path }) => asContent(await tools.why(path)),
  );

  server.registerTool(
    "callers",
    {
      title: "Who reads or changed a symbol",
      description: DESCRIPTIONS.callers,
      inputSchema: { symbol: z.string().min(1).describe("path#qualified.name") },
    },
    async ({ symbol }) => asContent(await tools.callers(symbol)),
  );

  server.registerTool(
    "history",
    {
      title: "Every change to a symbol",
      description: DESCRIPTIONS.history,
      inputSchema: { symbol: z.string().min(1).describe("path#qualified.name") },
    },
    async ({ symbol }) => asContent(await tools.history(symbol)),
  );

  server.registerTool(
    "brain",
    { title: "The repository's brain: ADRs, leases, intents", description: DESCRIPTIONS.brain, inputSchema: {} },
    async () => asContent(await tools.brain()),
  );

  server.registerTool(
    "lease",
    {
      title: "Lease a hot symbol",
      description: DESCRIPTIONS.lease,
      inputSchema: {
        symbol: z.string().min(1).describe("path#qualified.name"),
        reason: z.string().optional().describe("Why you need it, one line; other agents see it"),
        minutes: z.number().min(1).max(30).optional().describe("How long without a heartbeat before it expires (default 5)"),
        release: z.boolean().optional().describe("true to release your lease instead"),
      },
    },
    async ({ symbol, reason, minutes, release }) =>
      asContent(
        await tools.lease(symbol, {
          ...(reason === undefined ? {} : { reason }),
          ...(minutes === undefined ? {} : { minutes }),
          ...(release === undefined ? {} : { release }),
        }),
      ),
  );

  server.registerTool(
    "status",
    { title: "Pitstop status", description: DESCRIPTIONS.status, inputSchema: {} },
    async () => asContent(await tools.status()),
  );

  return server;
}

/**
 * Serves the tools over stdio for the worktree, and makes sure its daemon runs: at once, so it is
 * up before the first safe point, and again whenever a tool finds none. packages/cli's
 * `pitstop-mcp` calls this.
 */
export function startServer(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): void {
  const worktree = worktreeFromEnv(env, cwd);
  const say = (line: string) => console.error(`[pitstop-mcp] ${line}`);
  let inflight: Promise<EnsureResult> | undefined;
  const ensure = (): Promise<EnsureResult> =>
    (inflight ??= ensureDaemon(worktree).finally(() => {
      inflight = undefined;
    }));
  buildServer(worktree, { ensureDaemon: async () => ["running", "started"].includes(await ensure()) })
    .connect(new StdioServerTransport())
    .then(() => {
      say(`serving tools for ${worktree}`);
      void ensure().then((result) => {
        if (result === "started") say(`started the daemon in ${worktree}`);
        else if (result !== "running") say(`no daemon in ${worktree} (${result})`);
      });
    })
    .catch((err: unknown) => {
      say(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}

// From source or dist/; in the bundle every module shares its file name, so its entry calls startServer.
const isMain = !BUNDLED && process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) startServer();
