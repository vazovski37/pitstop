#!/usr/bin/env node
/**
 * Wires a worktree's Claude Code config to a from-source build of Pitstop, by absolute path:
 *   .mcp.json                 the pitstop MCP server (this package's index.js), with PITSTOP_WORKTREE
 *   .claude/settings.json     a PostToolUse hook running this package's hook.js
 *
 * Usage: node mcp/dist/setup.js [worktree]   (default: the current directory)
 * Existing keys in both files are kept; only the pitstop entries are set. With pitstop-cli
 * installed, `pitstop setup` does this instead, by command name (daemon/src/wire.ts), plus
 * CLAUDE.local.md and the git excludes; each replaces the other's entries.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface SetupResult {
  mcpConfig: string;
  settings: string;
  serverScript: string;
  hookScript: string;
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

/** `scriptsDir` is where index.js and hook.js live: this package's dist/ when run from it. */
export async function setupWorktree(worktree: string, scriptsDir = dirname(fileURLToPath(import.meta.url))): Promise<SetupResult> {
  const root = resolve(worktree);
  const serverScript = join(scriptsDir, "index.js");
  const hookScript = join(scriptsDir, "hook.js");

  const mcpConfig = join(root, ".mcp.json");
  const mcp = await readJson(mcpConfig);
  const servers = (mcp.mcpServers as Json | undefined) ?? {};
  servers.pitstop = { command: "node", args: [serverScript], env: { PITSTOP_WORKTREE: root } };
  mcp.mcpServers = servers;
  await writeFile(mcpConfig, `${JSON.stringify(mcp, null, 2)}\n`);

  const settings = join(root, ".claude", "settings.json");
  await mkdir(dirname(settings), { recursive: true });
  const current = await readJson(settings);
  const hooks = (current.hooks as Json | undefined) ?? {};
  const command = `node "${hookScript}"`;
  const post = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as Json[]) : [];
  const ours = { matcher: "", hooks: [{ type: "command", command, timeout: 60 }] };
  // Ours from an earlier run, or the by-name one `pitstop setup` writes (daemon/src/wire.ts).
  const kept = post.filter((entry) => !/hook\.js|pitstop-hook/.test(JSON.stringify(entry)));
  hooks.PostToolUse = [...kept, ours];
  current.hooks = hooks;
  await writeFile(settings, `${JSON.stringify(current, null, 2)}\n`);

  return { mcpConfig, settings, serverScript, hookScript };
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  setupWorktree(process.argv[2] ?? process.cwd())
    .then((r) => {
      console.log(`wrote ${r.mcpConfig} (MCP server: ${r.serverScript})`);
      console.log(`wrote ${r.settings} (PostToolUse hook: ${r.hookScript})`);
      console.log("Start `pitstop daemon` in the worktree, then open Claude Code there.");
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
