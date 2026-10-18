import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stampOf } from "@pitstop/protocol";
import { DaemonClient, type PresenceAnswer, type PresenceRow } from "./client.js";
import { buildServer } from "./index.js";
import { makeWho } from "./who.js";

const row = (replica: string, agent: string, extra: Partial<PresenceRow> = {}): PresenceRow => ({
  replica,
  repo: "teamdb/demo",
  author: { developer: agent === "agent-a" ? "lbala23" : "vazovski", agent },
  state: "working",
  files: [],
  symbols: [],
  appliedLsn: 4,
  stamp: stampOf(1_760_000_000_000, 0, replica),
  ageMs: 2_000,
  ...extra,
});

/** A stand-in for the daemon's local API answering GET /presence. */
async function fakeDaemon(worktree: string, answer: PresenceAnswer): Promise<() => Promise<void>> {
  const http: Server = createServer((req, res) => {
    const found = req.method === "GET" && req.url === "/presence";
    res.writeHead(found ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(found ? answer : { error: "not_found" }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  await mkdir(join(worktree, ".pitstop"), { recursive: true });
  await writeFile(join(worktree, ".pitstop", "daemon.json"), JSON.stringify({ port: (http.address() as AddressInfo).port, pid: 1, startedAt: "" }));
  return () => new Promise<void>((r) => http.close(() => r()));
}

describe("the who tool", () => {
  let worktree: string;
  let close: () => Promise<void> = async () => undefined;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "pitstop-who-"));
  });
  afterEach(async () => {
    await close();
    close = async () => undefined;
    await rm(worktree, { recursive: true, force: true, maxRetries: 5 });
  });

  it("names every other live worktree: agent, developer, intent, files, symbols, freshness; files you share are marked", async () => {
    close = await fakeDaemon(worktree, {
      replica: "w_me",
      ttlMs: 120_000,
      entries: [
        row("w_a", "agent-a", {
          intent: "Show last-seen on the profile page",
          intentId: "int_2",
          files: ["src/pages/ProfilePage.ts", "src/auth/session.ts"],
          symbols: ["src/auth/session.ts#getCurrentUser"],
        }),
        row("w_me", "agent-b", { files: ["src/pages/ProfilePage.ts"] }),
        row("w_c", "agent-c", { state: "idle", ageMs: 95_000, appliedLsn: 3 }),
      ],
    });
    const who = makeWho(new DaemonClient(worktree));
    expect(await who()).toEqual({
      text: [
        "2 other worktrees are here:",
        'agent-a (lbala23) working on "Show last-seen on the profile page", just now, at #4',
        "  files: src/pages/ProfilePage.ts, src/auth/session.ts (you are in src/pages/ProfilePage.ts too)",
        "  symbols: src/auth/session.ts#getCurrentUser",
        "agent-c (vazovski) idle, 2m ago, at #3",
      ].join("\n"),
    });
  });

  it("says when nobody else is here, and when no daemon runs", async () => {
    close = await fakeDaemon(worktree, { replica: "w_me", ttlMs: 120_000, entries: [row("w_me", "agent-b")] });
    expect(await makeWho(new DaemonClient(worktree))()).toEqual({ text: "Nobody else is working in this repository right now." });
    await close();
    close = async () => undefined;
    await rm(join(worktree, ".pitstop"), { recursive: true, force: true });
    const missing = await makeWho(new DaemonClient(worktree))();
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/No daemon is running/);
  });

  it("is registered on the MCP server and answers through it", async () => {
    close = await fakeDaemon(worktree, { replica: "w_me", ttlMs: 120_000, entries: [row("w_a", "agent-a", { intent: "Fix session expiry" })] });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(worktree);
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain("who");
    const result = await client.callTool({ name: "who", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: '1 other worktree is here:\nagent-a (lbala23) working on "Fix session expiry", just now, at #4' }]);
    await client.close();
    await server.close();
  });
});
