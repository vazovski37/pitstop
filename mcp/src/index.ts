#!/usr/bin/env node
/**
 * The Pitstop MCP server for coding agents (Claude Code for the hackathon), over stdio.
 * Tools: declare_intent, commit, why, callers, status. Each talks to the worktree's daemon
 * (its port in .pitstop/daemon.json), never to the server. `similar` waits for the server's
 * semantic endpoint.
 *
 * The worktree is PITSTOP_WORKTREE or the current directory (Claude Code starts MCP servers in
 * the project directory). Setup: `pitstop-agent-setup <worktree>` writes .mcp.json and the hook
 * into the worktree's Claude Code config (setup.ts).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DaemonClient } from "./client.js";
import { DESCRIPTIONS, makeTools, type ToolResult } from "./tools.js";

export { DaemonClient, NoDaemon } from "./client.js";
export { DESCRIPTIONS, makeTools } from "./tools.js";

export const worktreeFromEnv = (env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string =>
  resolve(env.PITSTOP_WORKTREE ?? cwd);

const asContent = (result: ToolResult) => ({
  content: [{ type: "text" as const, text: result.text }],
  ...(result.isError ? { isError: true } : {}),
});

export function buildServer(worktree: string): McpServer {
  const tools = makeTools(new DaemonClient(worktree));
  const server = new McpServer({ name: "pitstop", version: "0.1.0" });

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
    "status",
    { title: "Pitstop status", description: DESCRIPTIONS.status, inputSchema: {} },
    async () => asContent(await tools.status()),
  );

  return server;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const worktree = worktreeFromEnv();
  buildServer(worktree)
    .connect(new StdioServerTransport())
    .then(() => console.error(`[pitstop-mcp] serving tools for ${worktree}`))
    .catch((err: unknown) => {
      console.error(`[pitstop-mcp] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
