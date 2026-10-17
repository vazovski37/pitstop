/**
 * Wires a checkout's Claude Code to Pitstop, with command names instead of paths, so the files
 * work on any laptop that installed pitstop-cli (`npm install -g <server>/pitstop-cli.tgz`):
 *   .mcp.json               the `pitstop` MCP server, `pitstop-mcp` (`cmd /c pitstop-mcp` on Windows)
 *   .claude/settings.json   a PostToolUse hook running `pitstop-hook`; the server enabled
 *   CLAUDE.local.md         the house rules for the agent, between pitstop markers
 * Whatever else those files hold is kept. All three go into `.git/info/exclude`, so jj never
 * snapshots them into the agent's work and no commit carries them.
 *
 * mcp/src/setup.ts (`pitstop-agent-setup`) writes the same two config files with absolute paths to
 * a from-source build instead; each replaces the other's entries.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { run } from "./exec.js";
import type { Binaries } from "./jj.js";

type Json = Record<string, unknown>;

export const MCP_COMMAND = "pitstop-mcp";
export const HOOK_COMMAND = "pitstop-hook";

/** The paths the wiring writes, relative to the checkout, as `.git/info/exclude` lines. */
export const WIRING_EXCLUDES = ["/.mcp.json", "/.claude/", "/CLAUDE.local.md"];

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
    "- `status`, `why <path>` and `callers <path#name>` answer where the checkout stands and who changed what.",
    END,
  ].join("\n");
}

async function readJson(path: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
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

const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

/** A hook entry that runs Pitstop's hook: ours by name, or the absolute-path one from mcp/src/setup.ts. */
const isPitstopHook = (entry: unknown): boolean => strings(entry).some((s) => /pitstop-hook|[\\/]mcp[\\/](dist|src)[\\/]hook\.(js|ts)/.test(s));

export interface WireOptions {
  repo: string;
  serverUrl: string;
  /** Default this machine's. On Windows Claude Code starts an MCP server without a shell, so an npm bin shim (a .cmd) needs `cmd /c`. */
  platform?: NodeJS.Platform;
}

export interface WireResult {
  mcpConfig: string;
  settings: string;
  rules: string;
}

export async function wireClaudeCode(checkout: string, opts: WireOptions): Promise<WireResult> {
  const root = resolve(checkout);
  const windows = (opts.platform ?? process.platform) === "win32";

  const mcpConfig = join(root, ".mcp.json");
  const mcp = await readJson(mcpConfig);
  const servers = asObject(mcp.mcpServers);
  servers.pitstop = windows ? { command: "cmd", args: ["/c", MCP_COMMAND] } : { command: MCP_COMMAND };
  mcp.mcpServers = servers;
  await writeJson(mcpConfig, mcp);

  const settings = join(root, ".claude", "settings.json");
  const current = await readJson(settings);
  const hooks = asObject(current.hooks);
  const kept = asArray(hooks.PostToolUse).filter((entry) => !isPitstopHook(entry));
  hooks.PostToolUse = [...kept, { matcher: "", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 60 }] }];
  current.hooks = hooks;
  // The project's .mcp.json server, without Claude Code's "use this server?" question.
  const enabled = asArray(current.enabledMcpjsonServers).filter((s): s is string => typeof s === "string");
  current.enabledMcpjsonServers = enabled.includes("pitstop") ? enabled : [...enabled, "pitstop"];
  await writeJson(settings, current);

  const rules = join(root, "CLAUDE.local.md");
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

  return { mcpConfig, settings, rules };
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

/** Which of the wiring's paths git already tracks: excludes do not apply to them, so changes to them would be committed. */
export async function trackedWiring(checkout: string, bin: Pick<Binaries, "git">): Promise<string[]> {
  const out = await run(bin.git, ["ls-files", "--", ".mcp.json", ".claude", "CLAUDE.local.md"], { cwd: checkout }).catch(() => "");
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
