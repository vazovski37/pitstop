import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const dist = join(pkg, "dist");

const node = (args: string[], opts: { cwd?: string; input?: string } = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, args, { cwd: opts.cwd ?? pkg, timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ code: err ? Number((err as { code?: unknown }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(opts.input ?? "");
  });

describe("the pitstop-cli bundle", { timeout: 60_000 }, () => {
  let elsewhere: string;
  beforeAll(async () => {
    const built = await node(["build.mjs"]);
    expect(built.code, built.stderr).toBe(0);
    elsewhere = await mkdtemp(join(tmpdir(), "pitstop-cli-"));
  }, 60_000);
  afterAll(() => rm(elsewhere, { recursive: true, force: true, maxRetries: 5 }));

  it("has a shebang on every bin and runs them with node", async () => {
    const version = (JSON.parse(await readFile(join(pkg, "package.json"), "utf8")) as { version: string }).version;
    for (const bin of ["pitstop.js", "pitstop-mcp.js", "pitstop-hook.js"]) {
      expect((await readFile(join(dist, bin), "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    }
    const usage = await node([join(dist, "pitstop.js")], { cwd: elsewhere });
    expect(usage.code).toBe(2);
    // once: the daemon's own "am I main?" check must not run the CLI a second time inside the bundle
    expect(usage.stderr.match(/usage:/g)).toHaveLength(1);
    expect(usage.stderr).toContain("pitstop setup <server-url> <owner/name>");
    expect((await node([join(dist, "pitstop.js"), "--version"])).stdout.trim()).toBe(`pitstop ${version}`);
    expect((await node([join(dist, "pitstop-mcp.js"), "--help"])).stdout).toContain(`pitstop-mcp ${version}`);
    expect((await node([join(dist, "pitstop-hook.js"), "--help"])).stdout).toContain(`pitstop-hook ${version}`);
    // the hook outside a Pitstop checkout: nothing, exit 0
    expect(await node([join(dist, "pitstop-hook.js")], { cwd: elsewhere, input: JSON.stringify({ cwd: elsewhere }) })).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("serves MCP over stdio: the handshake carries the house rules, and the six tools are listed", async () => {
    const child = spawn(process.execPath, [join(dist, "pitstop-mcp.js")], { cwd: elsewhere, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const answers: Record<number, unknown> = {};
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at !== -1; at = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, at)) as { id?: number };
        buffer = buffer.slice(at + 1);
        if (typeof message.id === "number") answers[message.id] = message;
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const answer = async (id: number) => {
      const until = Date.now() + 20_000;
      while (answers[id] === undefined && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      return answers[id] as { result: Record<string, unknown> };
    };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
      const init = await answer(1);
      expect(init.result.serverInfo).toMatchObject({ name: "pitstop" });
      expect(init.result.instructions).toMatch(/declare_intent[\s\S]*commit tool[\s\S]*git push/);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (await answer(2)).result.tools as { name: string }[];
      expect(tools.map((t) => t.name).sort()).toEqual(["callers", "commit", "declare_intent", "status", "who", "why"]);
    } finally {
      child.kill();
    }
  });
});
