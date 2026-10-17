import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./exec.js";
import { binariesFromEnv } from "./jj.js";
import { removeDir, tempDir } from "./test-support.js";
import { excludeFromGit, trackedWiring, wireClaudeCode, WIRING_EXCLUDES } from "./wire.js";

const bin = binariesFromEnv();
const hasGit = await run(bin.git, ["--version"], { cwd: process.cwd() }).then(
  () => true,
  () => false,
);

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));

/** Every string in a JSON value, at any depth. */
const strings = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];

describe("wiring Claude Code by command name", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(() => removeDir(dir));

  it("writes .mcp.json, the hook and CLAUDE.local.md without a single absolute path", async () => {
    const r = await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://pitstop.example", platform: "linux" });
    const mcp = await readJson(r.mcpConfig);
    expect(mcp).toEqual({ mcpServers: { pitstop: { command: "pitstop-mcp" } } });
    const settings = await readJson(r.settings);
    expect(settings).toEqual({
      hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "pitstop-hook", timeout: 60 }] }] },
      enabledMcpjsonServers: ["pitstop"],
    });
    for (const s of [...strings(mcp), ...strings(settings)]) expect(isAbsolute(s), s).toBe(false);
    const rules = await readFile(r.rules, "utf8");
    expect(rules).toContain("team/app");
    expect(rules).toContain("declare_intent");
    expect(rules).toContain("git push");
  });

  it("uses cmd /c on Windows, where Claude Code starts the server without a shell and npm's shim is a .cmd", async () => {
    const r = await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://pitstop.example", platform: "win32" });
    expect((await readJson(r.mcpConfig)).mcpServers.pitstop).toEqual({ command: "cmd", args: ["/c", "pitstop-mcp"] });
  });

  it("keeps what the files already hold, replaces an older pitstop hook, and stays the same when run again", async () => {
    await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other-mcp" } }, extra: 1 }));
    await mkdir(join(dir, ".claude"), { recursive: true });
    const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
    const oldPitstop = { matcher: "", hooks: [{ type: "command", command: 'node "C:\\pitstop\\mcp\\dist\\hook.js"', timeout: 60 }] };
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PostToolUse: [userHook, oldPitstop], Stop: [userHook] }, enabledMcpjsonServers: ["other"] }),
    );
    await writeFile(join(dir, "CLAUDE.local.md"), "# My notes\n\nKeep these.\n");

    const opts = { repo: "team/app", serverUrl: "https://pitstop.example", platform: "darwin" as const };
    await wireClaudeCode(dir, opts);
    const once = {
      mcp: await readFile(join(dir, ".mcp.json"), "utf8"),
      settings: await readFile(join(dir, ".claude", "settings.json"), "utf8"),
      rules: await readFile(join(dir, "CLAUDE.local.md"), "utf8"),
    };
    expect(JSON.parse(once.mcp)).toEqual({ mcpServers: { other: { command: "other-mcp" }, pitstop: { command: "pitstop-mcp" } }, extra: 1 });
    expect(JSON.parse(once.settings)).toEqual({
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PostToolUse: [userHook, { matcher: "", hooks: [{ type: "command", command: "pitstop-hook", timeout: 60 }] }], Stop: [userHook] },
      enabledMcpjsonServers: ["other", "pitstop"],
    });
    expect(once.rules.startsWith("# My notes\n\nKeep these.\n\n<!-- pitstop:begin -->")).toBe(true);

    await wireClaudeCode(dir, opts);
    expect(await readFile(join(dir, ".mcp.json"), "utf8")).toBe(once.mcp);
    expect(await readFile(join(dir, ".claude", "settings.json"), "utf8")).toBe(once.settings);
    expect(await readFile(join(dir, "CLAUDE.local.md"), "utf8")).toBe(once.rules);
  });

  it("refuses to overwrite a settings file that is not JSON", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "settings.json"), "{ not json");
    await expect(wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x" })).rejects.toThrow(/not valid JSON/);
  });

  it.skipIf(!hasGit)("excludes the wiring from git once, and names wiring files git already tracks", async () => {
    await run(bin.git, ["init", "-q", "-b", "main"], { cwd: dir });
    const path = await excludeFromGit(dir, WIRING_EXCLUDES, bin);
    await excludeFromGit(dir, WIRING_EXCLUDES, bin);
    const text = await readFile(path, "utf8");
    for (const line of WIRING_EXCLUDES) expect(text.split("\n").filter((l) => l === line)).toHaveLength(1);
    await wireClaudeCode(dir, { repo: "team/app", serverUrl: "https://x" });
    expect((await run(bin.git, ["status", "--porcelain", "--untracked-files=all"], { cwd: dir })).trim()).toBe("");
    expect(await trackedWiring(dir, bin)).toEqual([]);

    await run(bin.git, ["add", "-f", ".mcp.json"], { cwd: dir });
    expect(await trackedWiring(dir, bin)).toEqual([".mcp.json"]);
  });
});
