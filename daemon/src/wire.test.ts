import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./exec.js";
import { binariesFromEnv } from "./jj.js";
import { removeDir, tempDir } from "./test-support.js";
import { excludeFromGit, localMcpCommand, mcpServerEntry, trackedWiring, wireClaudeCode, WIRING_EXCLUDES } from "./wire.js";

const bin = binariesFromEnv();
const hasGit = await run(bin.git, ["--version"], { cwd: process.cwd() }).then(
  () => true,
  () => false,
);

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));

/** Every string in a JSON value, at any depth. */
const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

const ourHook = { matcher: "", hooks: [{ type: "command", command: "pitstop-hook", timeout: 60 }] };

describe("wiring Claude Code by command name", () => {
  let dir: string;
  const at = (...p: string[]) => join(dir, ...p);
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(() => removeDir(dir));

  it("writes .mcp.json, the hook in settings.local.json and CLAUDE.local.md without a single absolute path", async () => {
    const r = await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://pitstop.example", platform: "linux" });
    expect(r).toEqual({ written: [at(".mcp.json"), at(".claude", "settings.local.json"), at("CLAUDE.local.md")], skipped: [] });
    const mcp = await readJson(at(".mcp.json"));
    expect(mcp).toEqual({ mcpServers: { pitstop: { command: "pitstop-mcp" } } });
    const settings = await readJson(at(".claude", "settings.local.json"));
    expect(settings).toEqual({ hooks: { PostToolUse: [ourHook] }, enabledMcpjsonServers: ["pitstop"] });
    // The team's settings file is not Pitstop's to write.
    expect(existsSync(at(".claude", "settings.json"))).toBe(false);
    for (const s of [...strings(mcp), ...strings(settings)]) expect(isAbsolute(s), s).toBe(false);
    const rules = await readFile(at("CLAUDE.local.md"), "utf8");
    expect(rules).toContain("team/app");
    expect(rules).toContain("declare_intent");
    expect(rules).toContain("git push");
  });

  it("uses cmd /c on Windows, where Claude Code starts the server without a shell and npm's shim is a .cmd, and keeps cmd off the checkout's own .cmd files", async () => {
    await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://pitstop.example", platform: "win32" });
    expect((await readJson(at(".mcp.json"))).mcpServers.pitstop).toEqual({
      command: "cmd",
      args: ["/c", "pitstop-mcp"],
      env: { NoDefaultCurrentDirectoryInExePath: "1" },
    });
  });

  it("keeps what the files already hold, the user's hooks included, replaces an older pitstop hook, and stays the same when run again", async () => {
    await writeFile(at(".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-mcp" } }, extra: 1 }));
    await mkdir(at(".claude"), { recursive: true });
    const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
    const oldPitstop = { matcher: "", hooks: [{ type: "command", command: 'node "C:\\pitstop\\mcp\\dist\\hook.js"', timeout: 60 }] };
    // A group the user shares with the pitstop hook, and hooks that only look like Pitstop's.
    const shared = { matcher: "", hooks: [{ type: "command", command: "pitstop-hook" }, { type: "command", command: "npx prettier --write ." }] };
    const lookalike = { matcher: "Edit", hooks: [{ type: "command", command: "node tools/mcp/dist/hook.js --lint" }, { type: "command", command: "node precommit-hook.js" }] };
    await writeFile(
      at(".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["Bash(npm test)"] },
        hooks: { PostToolUse: [userHook, oldPitstop, shared, lookalike], Stop: [userHook] },
        enabledMcpjsonServers: ["other"],
      }),
    );
    await writeFile(at("CLAUDE.local.md"), "# My notes\n\nKeep these.\n");

    const opts = { repo: "team/app", serverUrl: "https://pitstop.example", platform: "darwin" as const };
    await wireClaudeCode(dir, opts);
    const once = {
      mcp: await readFile(at(".mcp.json"), "utf8"),
      settings: await readFile(at(".claude", "settings.local.json"), "utf8"),
      rules: await readFile(at("CLAUDE.local.md"), "utf8"),
    };
    expect(JSON.parse(once.mcp)).toEqual({ mcpServers: { other: { command: "other-mcp" }, pitstop: { command: "pitstop-mcp" } }, extra: 1 });
    expect(JSON.parse(once.settings)).toEqual({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PostToolUse: [userHook, { matcher: "", hooks: [{ type: "command", command: "npx prettier --write ." }] }, lookalike, ourHook],
        Stop: [userHook],
      },
      enabledMcpjsonServers: ["other", "pitstop"],
    });
    expect(once.rules.startsWith("# My notes\n\nKeep these.\n\n<!-- pitstop:begin -->")).toBe(true);

    await wireClaudeCode(dir, opts);
    expect(await readFile(at(".mcp.json"), "utf8")).toBe(once.mcp);
    expect(await readFile(at(".claude", "settings.local.json"), "utf8")).toBe(once.settings);
    expect(await readFile(at("CLAUDE.local.md"), "utf8")).toBe(once.rules);
  });

  it("takes an earlier version's hook out of an untracked settings.json, and leaves a tracked one alone", async () => {
    await mkdir(at(".claude"), { recursive: true });
    const team = { permissions: { allow: ["Bash(npm test)"] }, hooks: { PostToolUse: [ourHook] }, enabledMcpjsonServers: ["pitstop"] };
    await writeFile(at(".claude", "settings.json"), JSON.stringify(team));
    await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x", platform: "linux", tracked: [".claude/settings.json"] });
    expect(await readJson(at(".claude", "settings.json"))).toEqual(team);

    await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x", platform: "linux" });
    expect(await readJson(at(".claude", "settings.json"))).toEqual({ permissions: { allow: ["Bash(npm test)"] } });
    // One that held nothing else goes.
    await writeFile(at(".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [ourHook] }, enabledMcpjsonServers: ["pitstop"] }));
    await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x", platform: "linux" });
    expect(existsSync(at(".claude", "settings.json"))).toBe(false);
  });

  it("leaves wiring files git tracks as they are, and says how to register the server when the team's .mcp.json lacks it", async () => {
    const teamMcp = JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } });
    await writeFile(at(".mcp.json"), teamMcp);
    await writeFile(at("CLAUDE.local.md"), "team notes\n");
    const r = await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x", platform: "win32", tracked: [".mcp.json", "CLAUDE.local.md"] });
    expect(r.skipped).toEqual([".mcp.json", "CLAUDE.local.md"]);
    expect(r.localMcp).toBe("claude mcp add --scope local pitstop -- cmd /c pitstop-mcp");
    expect(await readFile(at(".mcp.json"), "utf8")).toBe(teamMcp);
    expect(await readFile(at("CLAUDE.local.md"), "utf8")).toBe("team notes\n");
    // The hook still goes in, but the team's .mcp.json servers are not pre-approved.
    expect(await readJson(at(".claude", "settings.local.json"))).toEqual({ hooks: { PostToolUse: [ourHook] } });

    // A tracked .mcp.json that holds exactly this entry needs nothing more, and is enabled.
    await writeFile(at(".mcp.json"), JSON.stringify({ mcpServers: { pitstop: mcpServerEntry("linux") } }));
    const same = await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x", platform: "linux", tracked: [".mcp.json"] });
    expect(same.localMcp).toBeUndefined();
    expect((await readJson(at(".claude", "settings.local.json"))).enabledMcpjsonServers).toEqual(["pitstop"]);
    expect(localMcpCommand("darwin")).toBe("claude mcp add --scope local pitstop -- pitstop-mcp");
  });

  it("refuses to overwrite a settings file that is not JSON", async () => {
    await mkdir(at(".claude"), { recursive: true });
    await writeFile(at(".claude", "settings.local.json"), "{ not json");
    await expect(wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x" })).rejects.toThrow(/not valid JSON/);
  });

  it.skipIf(!hasGit)("excludes only the wiring from git, once; the rest of .claude/ stays the repository's; names wiring files git tracks", async () => {
    await run(bin.git, ["init", "-q", "-b", "main"], { cwd: dir });
    const path = await excludeFromGit(dir, WIRING_EXCLUDES, bin);
    await excludeFromGit(dir, WIRING_EXCLUDES, bin);
    const text = await readFile(path, "utf8");
    for (const line of WIRING_EXCLUDES) expect(text.split("\n").filter((l) => l === line)).toHaveLength(1);
    await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x" });
    expect((await run(bin.git, ["status", "--porcelain", "--untracked-files=all"], { cwd: dir })).trim()).toBe("");
    expect(await trackedWiring(dir, bin)).toEqual([]);

    // A team's slash command or shared settings are files like any other.
    await mkdir(at(".claude", "commands"), { recursive: true });
    await writeFile(at(".claude", "commands", "deploy.md"), "Deploy.\n");
    await writeFile(at(".claude", "settings.json"), "{}\n");
    const status = (await run(bin.git, ["status", "--porcelain", "--untracked-files=all"], { cwd: dir })).trim().split("\n").sort();
    expect(status).toEqual(["?? .claude/commands/deploy.md", "?? .claude/settings.json"]);

    await run(bin.git, ["add", "-f", ".mcp.json", ".claude/settings.json"], { cwd: dir });
    // Only the wiring's own files count; a tracked settings.json is the team's business.
    expect(await trackedWiring(dir, bin)).toEqual([".mcp.json"]);
  });
});
