import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "./client.js";
import { safePointHook } from "./hook.js";
import { setupWorktree } from "./setup.js";
import { makeTools } from "./tools.js";

/** A stand-in for the daemon's local API: canned answers per route, every request recorded. */
async function fakeDaemon(worktree: string, answers: Record<string, { status?: number; body: unknown }>) {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const http: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", path: req.url ?? "", body: raw ? JSON.parse(raw) : undefined });
      const key = `${req.method} ${(req.url ?? "").split("?")[0]}`;
      const answer = answers[key] ?? { status: 404, body: { error: "not_found" } };
      res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  await mkdir(join(worktree, ".pitstop"), { recursive: true });
  await writeFile(join(worktree, ".pitstop", "daemon.json"), JSON.stringify({ port, pid: 1, startedAt: "" }));
  return { requests, close: () => new Promise<void>((r) => http.close(() => r())) };
}

describe("MCP tools against a fake daemon", () => {
  let worktree: string;
  let close: () => Promise<void> = async () => undefined;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "pitstop-mcp-"));
  });
  afterEach(async () => {
    await close();
    await rm(worktree, { recursive: true, force: true, maxRetries: 5 });
  });

  it("declare_intent, status, why and callers render short text", async () => {
    const fake = await fakeDaemon(worktree, {
      "POST /intents": { status: 201, body: { id: "int_02", text: "Show last-seen time", baseLsn: 122, declaredSymbols: ["src/pages/ProfilePage.ts#renderProfile"] } },
      "GET /status": {
        body: {
          appliedLsn: 122, headLsn: 123, pending: 1, attached: true, worktree,
          intent: { id: "int_02", text: "Show last-seen time" },
          openIntents: [{ id: "int_01", agent: "agent-a", text: "Fix session expiry" }, { id: "int_02", agent: "agent-b", text: "Show last-seen time" }],
        },
      },
      "GET /why": { body: [{ lsn: 122, intent: "Show last-seen time on ProfilePage", agent: "agent-b", op: "modify", createdAt: "2026-10-17T14:20:05Z", repairs: ["Added null check"] }] },
      "GET /callers": { body: { readers: [{ lsn: 122, intent: "Show last-seen", agent: "agent-b", files: ["src/pages/ProfilePage.ts"] }], writers: [] } },
    });
    close = fake.close;
    const tools = makeTools(new DaemonClient(worktree));

    expect(await tools.declare_intent("Show last-seen time", ["src/pages/ProfilePage.ts#renderProfile"])).toEqual({
      text: 'Intent int_02 is open at #122: "Show last-seen time". Declared: src/pages/ProfilePage.ts#renderProfile. Use the commit tool when the work is done.',
    });
    expect(fake.requests[0]).toMatchObject({ method: "POST", path: "/intents", body: { text: "Show last-seen time", symbols: ["src/pages/ProfilePage.ts#renderProfile"] } });

    expect((await tools.status()).text).toBe(
      `${worktree} is at #122 (head #123), 1 pending (applied at your next safe point); your intent int_02 "Show last-seen time" is open.\nOpen elsewhere: int_01 agent-a "Fix session expiry"`,
    );
    expect((await tools.why("src/pages/ProfilePage.ts")).text).toBe(
      '#122 agent-b "Show last-seen time on ProfilePage" (modify, 2026-10-17T14:20:05Z). Repaired: Added null check.',
    );
    expect((await tools.callers("src/auth/session.ts#getCurrentUser")).text).toBe('Read by:\n  #122 agent-b "Show last-seen" (src/pages/ProfilePage.ts)');
    expect(fake.requests.at(-1)?.path).toBe("/callers?symbol=src%2Fauth%2Fsession.ts%23getCurrentUser");
  });

  it("commit reports acceptance, and a rejection with what to do", async () => {
    const fake = await fakeDaemon(worktree, {
      "POST /commit": { status: 200, body: { status: "accepted", changeset: { lsn: 123, intent: "Show last-seen time", files: [{ path: "a" }, { path: "b" }], repairs: [{ summary: "null check" }] } } },
    });
    close = fake.close;
    const tools = makeTools(new DaemonClient(worktree));
    expect(await tools.commit("Show last-seen time")).toEqual({ text: 'Committed as #123 "Show last-seen time" (2 files); main moved to it. The server repaired it: null check.' });
    await close();

    const rejecting = await fakeDaemon(worktree, {
      "POST /commit": {
        status: 409,
        body: { status: "rejected", reason: "escalated", message: "write skew: #121 changed getCurrentUser (signature). Re-read at head #122", conflictsWith: [121] },
      },
    });
    close = rejecting.close;
    expect(await tools.commit("x")).toEqual({
      text: "Commit rejected (escalated): write skew: #121 changed getCurrentUser (signature). Re-read at head #122 Conflicts with #121. Re-read what changed, adapt your change to it, and commit again.",
      isError: true,
    });
  });

  it("declare_intent passes the brain on; brain, lease, history and callers render short text", async () => {
    const symbol = "src/auth/session.ts#getCurrentUser";
    const fake = await fakeDaemon(worktree, {
      "POST /intents": {
        status: 201,
        body: {
          id: "int_03",
          text: "Fix auth",
          baseLsn: 4,
          declaredSymbols: [symbol],
          brief: ["Brain v1: a commit that breaks one of these rules is refused.", "ADR-1 Pages never touch the database: Pages read through services. Rules: forbid_import src/pages/** -> src/db/**."],
        },
      },
      "GET /brain": { body: { version: 1, lines: ["Brain v1 of acme/app: 1 accepted ADR, 0 live leases, 0 open intents.", "ADR-1 Pages never touch the database: Pages read through services."] } },
      "POST /lease": { status: 409, body: { status: "refused", message: `${symbol} is leased to agent-a (alice) until 03:15Z: changing its return type` } },
      "GET /history": {
        body: {
          symbol,
          history: [{ lsn: 5, intent: "Fix auth", intentId: "int_01", author: { developer: "alice", agent: "agent-a" }, createdAt: "2026-10-18T03:10:00Z", signature: true, brainVersion: 1, repairs: [] }],
          declaredBy: [{ id: "int_03", text: "Fix auth", author: { developer: "bob", agent: "agent-b" } }],
          lease: { expiresAt: "2026-10-18T03:15:00Z", reason: "", holder: { developer: "alice", agent: "agent-a" } },
        },
      },
      "GET /callers": {
        body: {
          readers: [{ lsn: 6, intent: "Profile", agent: "agent-b", files: ["src/pages/Profile.tsx"], wrote: ["src/pages/Profile.tsx#Profile"] }],
          writers: [],
          note: "read sets, not a parsed call graph",
        },
      },
    });
    close = fake.close;
    const tools = makeTools(new DaemonClient(worktree));
    expect((await tools.declare_intent("Fix auth", [symbol])).text).toBe(
      `Intent int_03 is open at #4: "Fix auth". Declared: ${symbol}. Use the commit tool when the work is done.\nBrain v1: a commit that breaks one of these rules is refused.\nADR-1 Pages never touch the database: Pages read through services. Rules: forbid_import src/pages/** -> src/db/**.`,
    );
    expect((await tools.brain()).text).toBe("Brain v1 of acme/app: 1 accepted ADR, 0 live leases, 0 open intents.\nADR-1 Pages never touch the database: Pages read through services.");
    expect(await tools.lease(symbol, { reason: "rename", minutes: 10 })).toEqual({
      text: `Lease refused: ${symbol} is leased to agent-a (alice) until 03:15Z: changing its return type. Leave that symbol alone (a commit writing it is refused) or wait until the lease ends.`,
      isError: true,
    });
    expect(fake.requests.at(-1)).toMatchObject({ method: "POST", path: "/lease", body: { symbol, reason: "rename", ttlSeconds: 600 } });
    expect((await tools.history(symbol)).text).toBe(
      [
        '#5 agent-a "Fix auth" (int_01), signature changed at 2026-10-18T03:10:00Z',
        'Declared now by: agent-b "Fix auth" (int_03)',
        "Leased to agent-a (alice) until 2026-10-18T03:15:00Z",
      ].join("\n"),
    );
    expect(fake.requests.at(-1)?.path).toBe(`/history?symbol=${encodeURIComponent(symbol)}`);
    expect((await tools.callers(symbol)).text).toBe('Read by (read sets, not a parsed call graph):\n  #6 agent-b "Profile" (wrote src/pages/Profile.tsx#Profile)');
    await close();

    const granting = await fakeDaemon(worktree, {
      "POST /lease": { body: { status: "held", message: `${symbol} is yours until 03:20Z` } },
    });
    close = granting.close;
    expect((await tools.lease(symbol)).text).toMatch(/^Lease taken: src\/auth\/session\.ts#getCurrentUser is yours until 03:20Z\. /);
    await close();
    const releasing = await fakeDaemon(worktree, { "POST /lease": { body: { status: "released", message: "released" } } });
    close = releasing.close;
    expect((await tools.lease(symbol, { release: true })).text).toBe(`Released the lease on ${symbol}.`);
    expect(releasing.requests[0]?.body).toEqual({ symbol, release: true });
  });

  it("says so when no daemon runs", async () => {
    const tools = makeTools(new DaemonClient(worktree));
    expect(await tools.status()).toEqual({ text: `No daemon is running in ${worktree}: run \`pitstop start\` there.`, isError: true });
  });
});

describe("the safe-point hook", () => {
  let worktree: string;
  let close: () => Promise<void> = async () => undefined;
  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), "pitstop-hook-"));
  });
  afterEach(async () => {
    await close();
    await rm(worktree, { recursive: true, force: true, maxRetries: 5 });
  });

  it("posts a safe point and returns the notes as additional context", async () => {
    const fake = await fakeDaemon(worktree, {
      "POST /safe-point": { body: { applied: [123], pending: 0, notes: ['#123 "x" touched src/a.ts, which you are editing'] } },
    });
    close = fake.close;
    const out = await safePointHook({ cwd: worktree, tool_name: "Edit" }, {});
    expect(JSON.parse(out)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: 'Pitstop applied #123 to this worktree.\n#123 "x" touched src/a.ts, which you are editing',
      },
    });
    expect(fake.requests).toEqual([{ method: "POST", path: "/safe-point", body: undefined }]);
  });

  it("prints nothing when there is nothing to say, and nothing without a daemon", async () => {
    const fake = await fakeDaemon(worktree, { "POST /safe-point": { body: { applied: [], pending: 0, notes: [] } } });
    close = fake.close;
    expect(await safePointHook({ cwd: worktree }, {})).toBe("");
    await close();
    expect(await safePointHook({ cwd: worktree }, {})).toBe("");
  });
});

describe("setup", () => {
  it("writes the MCP server and the hook into a worktree's Claude Code config, keeping what is there", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "pitstop-setup-"));
    try {
      await writeFile(join(worktree, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
      await mkdir(join(worktree, ".claude"), { recursive: true });
      // The scripts folder as path.join spells it here, so the expectations hold on Windows and on Linux CI.
      const scripts = join(worktree, "mcp-dist");
      const ours = `node "${join(scripts, "hook.js")}"`;
      const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] };
      // A group the user shares with the pitstop hook, and a hook whose name merely looks like ours.
      const shared = { matcher: "", hooks: [{ type: "command", command: "pitstop-hook" }, { type: "command", command: "npx prettier --write ." }] };
      const lookalike = { matcher: "Edit", hooks: [{ type: "command", command: "node tools/precommit-hook.js --lint" }] };
      await writeFile(
        join(worktree, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, hooks: { PostToolUse: [userHook, shared, lookalike] } }),
      );
      // An earlier version put the hook into the team's settings.json: it comes out of there.
      await writeFile(join(worktree, ".claude", "settings.json"), JSON.stringify({ model: "x", hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: ours, timeout: 60 }] }] } }));
      const r = await setupWorktree(worktree, scripts);
      expect(r.settings).toBe(join(worktree, ".claude", "settings.local.json"));
      const mcp = JSON.parse(await readFile(r.mcpConfig, "utf8")) as { mcpServers: Record<string, unknown> };
      expect(mcp.mcpServers.other).toEqual({ command: "x" });
      expect(mcp.mcpServers.pitstop).toEqual({ command: "node", args: [join(scripts, "index.js")], env: { PITSTOP_WORKTREE: worktree } });
      const settings = JSON.parse(await readFile(r.settings, "utf8")) as { permissions: unknown; hooks: { PostToolUse: unknown[] } };
      // The pitstop tools join the allow list, which keeps what was there.
      expect(settings.permissions).toEqual({ allow: ["Bash(npm test)", "mcp__pitstop"] });
      expect(settings.hooks.PostToolUse).toEqual([
        userHook,
        { matcher: "", hooks: [{ type: "command", command: "npx prettier --write ." }] },
        lookalike,
        { matcher: "", hooks: [{ type: "command", command: ours, timeout: 60 }] },
      ]);
      expect(JSON.parse(await readFile(join(worktree, ".claude", "settings.json"), "utf8"))).toEqual({ model: "x" });
      const once = await readFile(r.settings, "utf8");
      await setupWorktree(worktree, scripts);
      expect(await readFile(r.settings, "utf8")).toBe(once);
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
