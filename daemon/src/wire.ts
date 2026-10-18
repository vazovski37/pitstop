/**
 * Wires a checkout's Claude Code to Pitstop, with command names instead of paths, so the files
 * work on any laptop that installed pitstop-cli (`npm install -g <server>/pitstop-cli.tgz`):
 *   .mcp.json                    the `pitstop` MCP server, `pitstop-mcp` (`cmd /c pitstop-mcp` on Windows)
 *   .claude/settings.local.json  a PostToolUse hook running `pitstop-hook`; the server enabled, its tools allowed
 *   CLAUDE.local.md              the house rules for the agent, between pitstop markers
 * Whatever else those files hold is kept. All three go into `.git/info/exclude`, so jj never
 * snapshots them into the agent's work and no commit carries them. The rest of `.claude/` (the
 * team's settings.json, commands, agents, skills) is left to the repository.
 *
 * A wiring file git already tracks is the team's, and excludes do not apply to it: it is left
 * alone. For a tracked `.mcp.json` the result says how to register the server in Claude Code's
 * local scope instead (`claude mcp add --scope local`), unless it already holds this very entry.
 *
 * mcp/src/setup.ts (`pitstop-agent-setup`) writes the same entries with absolute paths to a
 * from-source build instead; each replaces the other's.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { run } from "./exec.js";
import type { Binaries } from "./jj.js";

type Json = Record<string, unknown>;

export const MCP_COMMAND = "pitstop-mcp";
export const HOOK_COMMAND = "pitstop-hook";
/** Claude Code's permission rule for every tool of the `pitstop` MCP server. */
export const PITSTOP_TOOLS = "mcp__pitstop";

/** `settings` with the pitstop tools in `permissions.allow`, once; everything else kept. */
export function allowPitstopTools(settings: Json): Json {
  const permissions = asObject(settings.permissions);
  const allow = asArray(permissions.allow).filter((s): s is string => typeof s === "string");
  return { ...settings, permissions: { ...permissions, allow: allow.includes(PITSTOP_TOOLS) ? allow : [...allow, PITSTOP_TOOLS] } };
}

/** The files the wiring writes, relative to the checkout, posix. */
export const WIRING_FILES = [".mcp.json", ".claude/settings.local.json", "CLAUDE.local.md"];
/** The same as `.git/info/exclude` lines. */
export const WIRING_EXCLUDES = WIRING_FILES.map((p) => `/${p}`);
/** Where an earlier version wrote the hook; cleaned of Pitstop's hooks when git does not track it. */
export const SHARED_SETTINGS = ".claude/settings.json";

const BEGIN = "<!-- pitstop:begin -->";
const END = "<!-- pitstop:end -->";

/** The house rules, for CLAUDE.local.md. The MCP server's `instructions` (mcp/src/index.ts) say the same, shorter. */
export function houseRules(repo: string, serverUrl: string): string {
  return [
    BEGIN,
    "## Pitstop: how changes land in this checkout",
    "",
    `This checkout is a live replica of the Pitstop repository \`${repo}\` on ${serverUrl}. Other agents commit to the same ordered log; their entries are applied here between your tool calls, and the \`pitstop\` MCP server is how your work joins the log. (Written by \`pitstop setup\`; this section is replaced when it runs again.)`,
    "",
    "- Before you change code, declare an intent with the pitstop `declare_intent` tool: one line on what you will do, and the symbols you expect to touch (`path#name`) when you know them.",
    "- Commit only with the pitstop `commit` tool, with a one-line intent. Never run `git commit`, `git push`, `jj commit`, `jj git push`, and never move or reset `main`: the daemon owns them.",
    "- A refused commit says what changed meanwhile. Re-read the files and symbols it names, adapt your change to them, and call `commit` again. Do not work around a refusal.",
    "- A note starting with \"Pitstop\" after a tool call means entries landed in this checkout: re-read what it names before you go on.",
    "- `declare_intent` answers with the repository's architecture decisions (ADRs, also the `brain` tool). Follow them: a commit that breaks one is refused with the file, the line and what to do instead. A symbol another agent holds a lease on is theirs until the lease ends; before a risky change to a symbol others use, take one yourself with `lease`.",
    "- `status`, `why <path>`, `callers <path#name>` and `history <path#name>` answer where the checkout stands and who changed what, and why.",
    END,
  ].join("\n");
}

async function readJson(path: string): Promise<Json | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or remove it, then run setup again`);
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : {};
}

const writeJson = async (path: string, value: Json) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const asObject = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Exactly the hook commands Pitstop writes: by name here, by absolute path in mcp/src/setup.ts. */
export const isPitstopHookCommand = (command: unknown): boolean =>
  typeof command === "string" && (command.trim() === HOOK_COMMAND || /^node "[^"]*[\\/]mcp[\\/]dist[\\/]hook\.js"$/.test(command.trim()));

/**
 * The PostToolUse groups without Pitstop's hooks: each group keeps its other hooks, and a group
 * is dropped only when nothing of it is left.
 */
export function withoutPitstopHooks(groups: unknown): unknown[] {
  const out: unknown[] = [];
  for (const group of asArray(groups)) {
    const g = asObject(group);
    if (!Array.isArray(g.hooks)) {
      out.push(group);
      continue;
    }
    const hooks = g.hooks.filter((h) => !isPitstopHookCommand(asObject(h).command));
    if (hooks.length === g.hooks.length) out.push(group);
    else if (hooks.length > 0) out.push({ ...g, hooks });
  }
  return out;
}

/** The `pitstop` entry of `.mcp.json` for a platform. */
export function mcpServerEntry(platform: NodeJS.Platform): Json {
  // Claude Code starts an MCP server without a shell, and npm's bin on Windows is a .cmd shim, so
  // cmd runs it; without NoDefaultCurrentDirectoryInExePath cmd would prefer a pitstop-mcp.cmd in
  // the checkout (Claude Code's cwd), which a commit could carry, to the installed one.
  return platform === "win32"
    ? { command: "cmd", args: ["/c", MCP_COMMAND], env: { NoDefaultCurrentDirectoryInExePath: "1" } }
    : { command: MCP_COMMAND };
}

/** The command that registers the server for this user only, for a checkout whose `.mcp.json` is the team's. */
export const localMcpCommand = (platform: NodeJS.Platform): string =>
  `claude mcp add --scope local pitstop -- ${platform === "win32" ? `cmd /c ${MCP_COMMAND}` : MCP_COMMAND}`;

export interface WireOptions {
  repo: string;
  serverUrl: string;
  /** Default this machine's. On Windows Claude Code starts an MCP server without a shell, so an npm bin shim (a .cmd) needs `cmd /c`. */
  platform?: NodeJS.Platform;
  /** Wiring files (and `.claude/settings.json`) git tracks here (trackedWiring): left alone. */
  tracked?: string[];
}

export interface WireResult {
  /** The files written. */
  written: string[];
  /** Tracked wiring files left as they are. */
  skipped: string[];
  /** When `.mcp.json` is tracked and lacks this entry: the command that registers the server for this user. */
  localMcp?: string;
}

export async function wireClaudeCode(checkout: string, opts: WireOptions): Promise<WireResult> {
  const root = resolve(checkout);
  const platform = opts.platform ?? process.platform;
  const tracked = new Set(opts.tracked ?? []);
  const written: string[] = [];
  const skipped = WIRING_FILES.filter((p) => tracked.has(p));

  // .mcp.json: the server, unless the file is the team's.
  const entry = mcpServerEntry(platform);
  const mcpConfig = join(root, ".mcp.json");
  let enable = true;
  let localMcp: string | undefined;
  if (tracked.has(".mcp.json")) {
    // The team's file. Its own pitstop entry, when it is exactly ours, is trusted like ours.
    const servers = asObject((await readJson(mcpConfig))?.mcpServers);
    enable = isDeepStrictEqual(servers.pitstop, entry);
    if (!enable) localMcp = localMcpCommand(platform);
  } else {
    const mcp = (await readJson(mcpConfig)) ?? {};
    mcp.mcpServers = { ...asObject(mcp.mcpServers), pitstop: entry };
    await writeJson(mcpConfig, mcp);
    written.push(mcpConfig);
  }

  // .claude/settings.local.json: Claude Code's per-user settings; the same keys as settings.json.
  const local = join(root, ".claude", "settings.local.json");
  if (!tracked.has(".claude/settings.local.json")) {
    const current = (await readJson(local)) ?? {};
    const hooks = asObject(current.hooks);
    hooks.PostToolUse = [...withoutPitstopHooks(hooks.PostToolUse), { matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] }];
    current.hooks = hooks;
    // The project's .mcp.json server, without Claude Code's "use this server?" question.
    if (enable) {
      const enabled = asArray(current.enabledMcpjsonServers).filter((s): s is string => typeof s === "string");
      current.enabledMcpjsonServers = enabled.includes("pitstop") ? enabled : [...enabled, "pitstop"];
    }
    // The pitstop tools run without Claude Code asking before each call (the owner's choice,
    // 18 October 2026): declaring an intent and committing are the agent's normal loop.
    await writeJson(local, allowPitstopTools(current));
    written.push(local);
  }

  // .claude/settings.json: an earlier setup put the hook there; the hook must not run twice.
  if (!tracked.has(SHARED_SETTINGS)) await dropOldHook(join(root, ".claude", "settings.json"));

  // CLAUDE.local.md: the house rules between markers, the rest kept.
  const rules = join(root, "CLAUDE.local.md");
  if (!tracked.has("CLAUDE.local.md")) {
    const existing = await readFile(rules, "utf8").catch(() => "");
    const section = houseRules(opts.repo, opts.serverUrl);
    const start = existing.indexOf(BEGIN);
    const end = existing.indexOf(END);
    const next =
      start !== -1 && end > start
        ? `${existing.slice(0, start)}${section}${existing.slice(end + END.length)}`
        : existing.trim() === ""
          ? `${section}\n`
          : `${existing.trimEnd()}\n\n${section}\n`;
    await writeFile(rules, next);
    written.push(rules);
  }

  return { written, skipped, ...(localMcp === undefined ? {} : { localMcp }) };
}

/** Removes Pitstop's hooks from an untracked settings file; the file goes when nothing else is left in it. */
async function dropOldHook(path: string): Promise<void> {
  const current = await readJson(path).catch(() => undefined);
  if (current === undefined) return;
  const hooks = asObject(current.hooks);
  if (!Array.isArray(hooks.PostToolUse)) return;
  const kept = withoutPitstopHooks(hooks.PostToolUse);
  if (isDeepStrictEqual(kept, hooks.PostToolUse)) return;
  if (kept.length > 0) hooks.PostToolUse = kept;
  else delete hooks.PostToolUse;
  if (Object.keys(hooks).length > 0) current.hooks = hooks;
  else delete current.hooks;
  if (isDeepStrictEqual(current.enabledMcpjsonServers, ["pitstop"])) delete current.enabledMcpjsonServers;
  if (Object.keys(current).length === 0) await rm(path, { force: true });
  else await writeJson(path, current);
}

/**
 * Adds `lines` to the repository's `.git/info/exclude` (wherever git keeps it for this checkout),
 * each once. jj, colocated, honours the file: an excluded path is never snapshotted into `@`.
 */
export async function excludeFromGit(checkout: string, lines: string[], bin: Pick<Binaries, "git">): Promise<string> {
  const where = (await run(bin.git, ["rev-parse", "--git-path", "info/exclude"], { cwd: checkout })).trim();
  const path = isAbsolute(where) ? where : join(checkout, where);
  const text = await readFile(path, "utf8").catch(() => "");
  const present = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !present.has(l));
  if (missing.length > 0) {
    await mkdir(dirname(path), { recursive: true });
    const lead = text === "" || text.endsWith("\n") ? text : `${text}\n`;
    await writeFile(path, `${lead}# pitstop: this checkout's Claude Code wiring, never part of a commit\n${missing.join("\n")}\n`);
  }
  return path;
}

/** Which of `paths` (default the wiring's) git tracks: excludes do not apply to them, so changes to them would be committed. */
export async function trackedWiring(checkout: string, bin: Pick<Binaries, "git">, paths: string[] = WIRING_FILES): Promise<string[]> {
  const out = await run(bin.git, ["ls-files", "--", ...paths], { cwd: checkout }).catch(() => "");
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
