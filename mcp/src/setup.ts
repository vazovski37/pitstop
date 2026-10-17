#!/usr/bin/env node
/**
 * Wires a worktree's Claude Code config to a from-source build of Pitstop, by absolute path:
 *   .mcp.json                     the pitstop MCP server (this package's index.js), with PITSTOP_WORKTREE
 *   .claude/settings.local.json   a PostToolUse hook running this package's hook.js
 *
 * Usage: node mcp/dist/setup.js [worktree]   (default: the current directory)
 * Existing keys in both files are kept; only the pitstop entries are set. The hook goes into
 * Claude Code's per-user settings file, never the team's settings.json, where an earlier version
 * put it (it is taken out of there). With pitstop-cli installed, `pitstop setup` does this instead,
 * by command name (daemon/src/wire.ts), plus CLAUDE.local.md and the git excludes; each replaces
 * the other's entries.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export interface SetupResult {
  mcpConfig: string;
  settings: string;
  serverScript: string;
  hookScript: string;
}

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<Json | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
  } catch {
    return undefined;
  }
}

const asObject = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/**
 * Exactly the hook commands Pitstop writes: this build's, any build's `node "<abs>/mcp/dist/hook.js"`,
 * and `pitstop-hook` (daemon/src/wire.ts). Anything else in a group is the user's and stays.
 */
const isPitstopHookCommand = (command: unknown, ours: string): boolean => {
  if (typeof command !== "string") return false;
  const c = command.trim();
  return c === ours || c === "pitstop-hook" || /^node "[^"]*[\\/]mcp[\\/]dist[\\/]hook\.js"$/.test(c);
};

/** PostToolUse groups without Pitstop's hooks; a group goes only when nothing of it is left. */
function withoutPitstopHooks(groups: unknown, ours: string): unknown[] {
  const out: unknown[] = [];
  for (const group of Array.isArray(groups) ? groups : []) {
    const g = asObject(group);
    if (!Array.isArray(g.hooks)) {
      out.push(group);
      continue;
    }
    const hooks = g.hooks.filter((h) => !isPitstopHookCommand(asObject(h).command, ours));
    if (hooks.length === g.hooks.length) out.push(group);
    else if (hooks.length > 0) out.push({ ...g, hooks });
  }
  return out;
}

/** `scriptsDir` is where index.js and hook.js live: this package's dist/ when run from it. */
export async function setupWorktree(worktree: string, scriptsDir = dirname(fileURLToPath(import.meta.url))): Promise<SetupResult> {
  const root = resolve(worktree);
  const serverScript = join(scriptsDir, "index.js");
  const hookScript = join(scriptsDir, "hook.js");

  const mcpConfig = join(root, ".mcp.json");
  const mcp = (await readJson(mcpConfig)) ?? {};
  const servers = asObject(mcp.mcpServers);
  servers.pitstop = { command: "node", args: [serverScript], env: { PITSTOP_WORKTREE: root } };
  mcp.mcpServers = servers;
  await writeFile(mcpConfig, `${JSON.stringify(mcp, null, 2)}\n`);

  const command = `node "${hookScript}"`;
  const settings = join(root, ".claude", "settings.local.json");
  await mkdir(dirname(settings), { recursive: true });
  const current = (await readJson(settings)) ?? {};
  const hooks = asObject(current.hooks);
  hooks.PostToolUse = [...withoutPitstopHooks(hooks.PostToolUse, command), { matcher: "", hooks: [{ type: "command", command, timeout: 60 }] }];
  current.hooks = hooks;
  // The pitstop tools run without Claude Code asking before each call, as daemon/src/wire.ts does.
  const permissions = asObject(current.permissions);
  const allow = (Array.isArray(permissions.allow) ? permissions.allow : []).filter((s): s is string => typeof s === "string");
  permissions.allow = allow.includes("mcp__pitstop") ? allow : [...allow, "mcp__pitstop"];
  current.permissions = permissions;
  await writeFile(settings, `${JSON.stringify(current, null, 2)}\n`);

  // An earlier version wrote the hook into the shared settings.json: once is enough.
  const shared = join(root, ".claude", "settings.json");
  const old = await readJson(shared);
  const oldHooks = asObject(old?.hooks);
  if (old !== undefined && Array.isArray(oldHooks.PostToolUse)) {
    const kept = withoutPitstopHooks(oldHooks.PostToolUse, command);
    if (!isDeepStrictEqual(kept, oldHooks.PostToolUse)) {
      if (kept.length > 0) oldHooks.PostToolUse = kept;
      else delete oldHooks.PostToolUse;
      if (Object.keys(oldHooks).length > 0) old.hooks = oldHooks;
      else delete old.hooks;
      if (Object.keys(old).length === 0) await rm(shared, { force: true });
      else await writeFile(shared, `${JSON.stringify(old, null, 2)}\n`);
    }
  }

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
