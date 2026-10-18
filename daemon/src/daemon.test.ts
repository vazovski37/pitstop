import { afterEach, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { type Adr, type Author, type Lease, type ServerMessage } from "@pitstop/protocol";
import { Daemon, NO_INTENT_FOR_LEASE, readDaemonInfo, type SafePointResult, type Status } from "./daemon.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { LocalClient, NoDaemon } from "./local-client.js";
import { readState, writeState } from "./state.js";
import type { Tree } from "./symbols.js";
import { entryAt, FakeApplier, fixtureCommitFiles, fixtureMessages, removeDir, sleep, tempDir, waitFor } from "./test-support.js";

const author: Author = { developer: "teammate", agent: "agent-b" };

describe("daemon with its local API", () => {
  let worktree: string;
  let server: FakeServer;
  let daemon: Daemon;
  let port: number;
  const applier = new FakeApplier();
  const log: string[] = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const status = async () => (await api("GET", "/status")).body as Status;
  const safePoint = async () => (await api("POST", "/safe-point")).body as SafePointResult;

  const start = async (messages: ServerMessage[] = fixtureMessages(), appliedLsn = 121, extra: Partial<ConstructorParameters<typeof Daemon>[0]> = {}) => {
    server = await startFakeServer({ messages });
    await writeState(worktree, { appliedLsn });
    daemon = new Daemon({
      serverUrl: server.url,
      worktree,
      applier,
      author,
      log: (l) => log.push(l),
      reconnectMs: 0,
      heartbeatMs: 0,
      attachMs: 60_000,
      ...extra,
    });
    port = await daemon.start();
  };

  beforeEach(async () => {
    onTestFailed(() => console.log(["--- daemon log:", ...log].join("\n")));
    worktree = await tempDir();
    applier.applied = [];
    applier.files = [];
    applier.changes = false;
    applier.conflictOn = undefined;
    applier.trees = { main: new Map(), "@": new Map() };
    log.length = 0;
  });
  afterEach(async () => {
    await daemon?.close();
    await server?.close();
    await removeDir(worktree);
  });

  it("writes daemon.json, applies as entries arrive while no agent is attached, and answers /status", async () => {
    await start();
    expect(await readDaemonInfo(worktree)).toMatchObject({ port, pid: process.pid });
    await waitFor(() => applier.lsns.includes(122));
    await waitFor(async () => (await readState(worktree)).appliedLsn === 122);
    const s = await status();
    expect(s).toMatchObject({ appliedLsn: 122, headLsn: 122, pending: 0, attached: false, intent: null, worktree });
    expect(s.openIntents).toEqual([{ id: "int_01", agent: "agent-a", text: "Fix session expiry in getCurrentUser" }]);
    await daemon.close();
    expect(await readDaemonInfo(worktree)).toBeUndefined();
    await expect(new LocalClient(worktree).status()).rejects.toBeInstanceOf(NoDaemon);
  });

  it("starts in a fresh worktree with no .pitstop yet", async () => {
    server = await startFakeServer({ messages: fixtureMessages() });
    daemon = new Daemon({ serverUrl: server.url, worktree, applier, author, reconnectMs: 0, heartbeatMs: 0 });
    port = await daemon.start();
    expect(await readDaemonInfo(worktree)).toMatchObject({ port });
  });

  it("keeps the read base where the work began through a safe point; only a skew refusal moves it", async () => {
    await start();
    // The daemon writes the state file after the apply returns: wait for that write, or it lands
    // after ours and drops the read base (seen under load).
    await waitFor(async () => (await readState(worktree)).appliedLsn === 122);
    await writeState(worktree, { appliedLsn: 122, readBaseLsn: 120, intentId: "int_09" });
    await safePoint(); // attaches the agent, applies nothing
    server.append(entryAt(123));
    await waitFor(async () => (await status()).pending === 1);
    expect((await safePoint()).applied).toEqual([123]);
    // The notes only see edits, not what the agent read before editing: the server still checks from #120.
    expect(await readState(worktree)).toEqual({ appliedLsn: 123, readBaseLsn: 120, intentId: "int_09" });
  });

  it("holds entries between safe points once an agent is attached", async () => {
    await start();
    await waitFor(() => applier.lsns.includes(122));
    expect((await safePoint()).applied).toEqual([]);
    expect((await status()).attached).toBe(true);
    server.append(entryAt(123));
    await waitFor(async () => (await status()).pending === 1);
    await sleep(50);
    expect(applier.lsns).toEqual([122]);
    const result = await safePoint();
    expect(result.applied).toEqual([123]);
    expect(result.pending).toBe(0);
    expect(applier.lsns).toEqual([122, 123]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 123 });
  });

  it("declares an intent, heartbeats it, and the commit closes it", async () => {
    await start(fixtureMessages(), 122, { heartbeatMs: 20 });
    const declared = await api("POST", "/intents", { text: "Show last-seen time on ProfilePage", symbols: ["src/pages/ProfilePage.ts#renderProfile"] });
    expect(declared.body).toMatchObject({ id: "int_01", status: "open", baseLsn: 122, declaredSymbols: ["src/pages/ProfilePage.ts#renderProfile"] });
    expect(declared.status).toBe(201);
    expect(server.intents[0]?.text).toBe("Show last-seen time on ProfilePage");
    expect(await readState(worktree)).toEqual({ appliedLsn: 122, readBaseLsn: 122, intentId: "int_01" });
    expect((await status()).intent).toEqual({ id: "int_01", text: "Show last-seen time on ProfilePage" });
    await waitFor(() => server.received.some((m) => m.type === "heartbeat" && m.intentId === "int_01"));

    applier.files = fixtureCommitFiles();
    const committed = await api("POST", "/commit", { intent: "Show last-seen time on ProfilePage" });
    expect(committed.body).toMatchObject({ status: "accepted", changeset: { lsn: 123 } });
    expect(committed.status).toBe(200);
    expect(server.commits[0]).toMatchObject({ intentId: "int_01", baseLsn: 122 });
    expect(await readState(worktree)).toEqual({ appliedLsn: 123 });
    expect((await status()).intent).toBeNull();
  });

  it("relays a rejection verbatim: reason, message and conflictsWith", async () => {
    await start(fixtureMessages(), 122);
    applier.files = fixtureCommitFiles();
    server.rejectNextCommit({
      reason: "escalated",
      message: "write skew: #121 changed src/auth/session.ts#getCurrentUser (signature). Re-read at head #122 and commit again",
      conflictsWith: [121],
    });
    const answer = await api("POST", "/commit", { intent: "Show last-seen time on ProfilePage" });
    expect(answer.status).toBe(409);
    expect(answer.body).toEqual({
      status: "rejected",
      reason: "escalated",
      message: "commit rejected (escalated): write skew: #121 changed src/auth/session.ts#getCurrentUser (signature). Re-read at head #122 and commit again",
      conflictsWith: [121],
    });
    expect(applier.lsns).toEqual([]);
    // The refusal told the agent what to re-read, so its reads are checked from there next time.
    expect(await readState(worktree)).toEqual({ appliedLsn: 122, readBaseLsn: 121 });
  });

  it("notes an applied entry that touched a file the agent is editing, and conflicts it left", async () => {
    await start();
    await waitFor(() => applier.lsns.includes(122));
    await safePoint();
    applier.files = [{ path: "src/pages/ProfilePage.tsx", op: "modify", content: "x" }];
    applier.conflictOn = 123;
    server.append(entryAt(123, { intent: "Rename the profile heading" }));
    await waitFor(async () => (await status()).pending === 1);
    const result = await safePoint();
    expect(result).toEqual({
      applied: [123],
      pending: 0,
      notes: [
        '#123 "Rename the profile heading" touched src/pages/ProfilePage.tsx, which you are editing',
        "#123 left conflict markers in a.txt: resolve them before you commit",
      ],
    });
  });

  it("notes symbol-level overlap from the TypeScript project", { timeout: 30_000 }, async () => {
    const tsconfig = JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] });
    const main: Tree = new Map([
      ["tsconfig.json", tsconfig],
      ["src/a.ts", "export function f(x: number): number {\n  return x;\n}\nexport function g(): number {\n  return 1;\n}\nexport function h(): number {\n  return 2;\n}\n"],
    ]);
    const at: Tree = new Map(main);
    at.set("src/a.ts", "export function f(x: number): number {\n  return x + g();\n}\nexport function g(): number {\n  return 1;\n}\nexport function h(): number {\n  return 3;\n}\n");
    await start();
    await waitFor(() => applier.lsns.includes(122));
    await safePoint();
    applier.files = [{ path: "src/a.ts", op: "modify", content: at.get("src/a.ts") ?? "" }];
    applier.trees = { main, "@": at };
    server.append(entryAt(123, { intent: "g returns a string", writeSet: ["src/a.ts#g", "src/a.ts#h"], sigWriteSet: ["src/a.ts#g"], readSet: [] }));
    await waitFor(async () => (await status()).pending === 1);
    const result = await safePoint();
    expect(result.notes).toEqual([
      '#123 "g returns a string" changed src/a.ts#h, which you also changed; changed src/a.ts#g (signature), which your change reads',
    ]);
  });

  it("passes the server's warnings for this agent at the next safe point, once", async () => {
    await start();
    await waitFor(() => log.some((l) => l.startsWith("warning for agent-b")));
    const first = await safePoint();
    expect(first.notes).toEqual([
      "warning: #121 changed getCurrentUser: now returns null for expired sessions (intent: fix session expiry).",
    ]);
    expect((await safePoint()).notes).toEqual([]);
  });

  it("answers why and callers from the log", async () => {
    await start();
    await waitFor(() => applier.lsns.includes(122));
    const why = await api("GET", "/why?path=src/pages/ProfilePage.tsx");
    expect(why.body).toEqual([
      {
        lsn: 122,
        intent: "Show last-seen time on ProfilePage",
        agent: "agent-b",
        op: "modify",
        createdAt: "2026-10-17T14:20:05Z",
        brainVersion: 37, // the fixture entry's
        repairs: ["Added null check: redirect to login when the session has expired"],
      },
    ]);
    expect((await api("GET", "/why?path=nope.ts")).body).toEqual([]);
    const callers = await api("GET", `/callers?symbol=${encodeURIComponent("src/auth/session.ts#getCurrentUser")}`);
    expect(callers.body).toMatchObject({
      readers: [{ lsn: 122, agent: "agent-b", wrote: ["src/pages/ProfilePage.tsx#ProfilePage"] }],
      writers: [],
      note: expect.stringMatching(/not a parsed call graph/),
    });
    expect((await api("GET", "/callers")).status).toBe(400);
    expect((await api("GET", "/nothing")).status).toBe(404);
  });

  describe("the brain", () => {
    const symbol = "src/auth/session.ts#getCurrentUser";
    const adr: Adr = {
      repo: "local/default",
      number: 1,
      title: "Pages never touch the database",
      status: "accepted",
      decision: "Pages read data through src/services.",
      reason: "",
      consequences: "",
      rules: [{ kind: "forbid_import", files: "src/pages/**", target: "src/db/**" }],
      version: 1,
      createdBy: "vazovski37",
      createdAt: "2026-10-18T03:00:00Z",
    };
    const leaseOf = (holder: Author, sym = symbol, extra: Partial<Lease> = {}): Lease => ({
      repo: "local/default",
      symbol: sym,
      holder,
      reason: "changing its return type",
      status: "held",
      expiresAt: "2026-10-18T03:15:00.000Z",
      createdAt: "2026-10-18T03:05:00.000Z",
      ...extra,
    });
    const agentA: Author = { developer: "vazovski", agent: "agent-a" };

    it("gives the agent the brain in brief when it declares an intent: the ADRs, and leases others hold on its symbols", async () => {
      await start(fixtureMessages(), 122);
      server.setBrain({ version: 1, adrs: [adr, { ...adr, number: 2, status: "proposed", title: "Not yet" }] });
      server.leases.set(symbol, leaseOf(agentA));
      server.leases.set("src/other.ts#x", leaseOf(agentA, "src/other.ts#x"));
      const declared = await api("POST", "/intents", { text: "Show last-seen", symbols: [symbol] });
      expect(declared.status).toBe(201);
      expect((declared.body as { brief: string[] }).brief).toEqual([
        "Brain v1: a commit that breaks one of these rules is refused.",
        "ADR-1 Pages never touch the database: Pages read data through src/services. Rules: forbid_import src/pages/** -> src/db/**.",
        `Leased by another agent (your commit writing it is refused until it is released or expires): ${symbol} leased to agent-a (vazovski) until 03:15Z: changing its return type.`,
      ]);
      server.setBrain({ version: 0, adrs: [] });
      server.leases.clear();
      expect(((await api("POST", "/intents", { text: "again" })).body as { brief: string[] }).brief).toEqual(["Brain v0: no accepted ADRs."]);
    });

    it("notes at a safe point an ADR accepted or superseded, and leases taken or released on the agent's symbols", async () => {
      await start(fixtureMessages(), 122);
      await api("POST", "/intents", { text: "Show last-seen", symbols: [symbol] });
      await safePoint(); // attaches; the fixture's warning goes out with it
      applier.files = [{ path: "src/pages/ProfilePage.tsx", op: "modify", content: "x" }];
      server.broadcast({ type: "brain", repo: "local/default", version: 1, adr });
      server.broadcast({ type: "brain", repo: "local/default", version: 1, adr: { ...adr, number: 2, status: "proposed" } });
      server.broadcast({ type: "lease", lease: leaseOf(agentA) });
      server.broadcast({ type: "lease", lease: leaseOf(agentA, "src/pages/ProfilePage.tsx#ProfilePage", { reason: "" }) });
      server.broadcast({ type: "lease", lease: leaseOf(agentA, "src/elsewhere.ts#e") });
      server.broadcast({ type: "lease", lease: leaseOf(author, "src/pages/ProfilePage.tsx#Mine") });
      server.broadcast({ type: "brain", repo: "local/default", version: 2, adr: { ...adr, status: "superseded", version: 2 } });
      await waitFor(() => log.filter((l) => l.startsWith("brain v") || l.startsWith("lease on")).length === 7);
      expect((await safePoint()).notes).toEqual([
        "brain v1: ADR-1 accepted: Pages never touch the database: Pages read data through src/services. Rules: forbid_import src/pages/** -> src/db/**.",
        "brain v2: ADR-1 superseded: Pages never touch the database no longer applies",
        `lease: agent-a (vazovski) holds ${symbol} until 03:15Z (changing its return type); a commit of yours that changes it is refused until then, so leave it alone or wait`,
        "lease: agent-a (vazovski) holds src/pages/ProfilePage.tsx#ProfilePage until 03:15Z; a commit of yours that changes it is refused until then, so leave it alone or wait",
      ]);
      server.broadcast({ type: "lease", lease: leaseOf(agentA, symbol, { status: "released" }) });
      await waitFor(() => log.filter((l) => l.startsWith("lease on")).length === 5);
      expect((await safePoint()).notes).toEqual([`lease: ${symbol} is free again (agent-a (vazovski)'s lease released)`]);
      expect((await safePoint()).notes).toEqual([]);
    });

    it("takes and releases a lease for the open intent, and answers the brain and a symbol's history from the server", async () => {
      await start(fixtureMessages(), 122);
      await waitFor(() => applier.lsns.length === 0 && log.some((l) => l.includes("is at #")));
      // No open intent: no lease (it would outlive the task, unrenewed and unreleased).
      expect(await api("POST", "/lease", { symbol: "src/pages/ProfilePage.tsx#ProfilePage" })).toMatchObject({ status: 200, body: { status: "invalid", message: NO_INTENT_FOR_LEASE } });
      await writeState(worktree, { appliedLsn: 122, intentId: "int_07" });
      const taken = await api("POST", "/lease", { symbol: "src/pages/ProfilePage.tsx#ProfilePage", reason: "reshaping it" });
      expect(taken).toMatchObject({ status: 200, body: { status: "held", renewed: false, lease: { holder: author, intentId: "int_07", reason: "reshaping it" } } });
      expect((taken.body as { message: string }).message).toMatch(/^src\/pages\/ProfilePage\.tsx#ProfilePage is yours until \d\d:\d\dZ$/);
      server.leases.set(symbol, leaseOf(agentA));
      const refused = await api("POST", "/lease", { symbol });
      expect(refused).toMatchObject({ status: 409, body: { status: "leased", lease: { holder: agentA } } });
      expect((refused.body as { message: string }).message).toMatch(/is leased to agent-a \(vazovski\)/);
      expect(await api("POST", "/lease", { symbol, release: true })).toMatchObject({ status: 409, body: { status: "leased" } });
      expect(await api("POST", "/lease", { symbol: "src/pages/ProfilePage.tsx#ProfilePage", release: true })).toMatchObject({ status: 200, body: { status: "released" } });
      expect(await api("POST", "/lease", { symbol: "src/pages/ProfilePage.tsx#ProfilePage", release: true })).toMatchObject({ status: 200, body: { status: "not_held" } });
      expect((await api("POST", "/lease", { symbol: "no-hash" })).status).toBe(400);

      server.setBrain({ version: 1, adrs: [adr] });
      expect((await api("GET", "/brain")).body).toEqual({
        version: 1,
        lines: [
          "Brain v1 of local/default: 1 accepted ADR, 1 live lease, 0 open intents.",
          "ADR-1 Pages never touch the database: Pages read data through src/services. Rules: forbid_import src/pages/** -> src/db/**.",
          `Lease: ${symbol} leased to agent-a (vazovski) until 03:15Z: changing its return type`,
        ],
      });
      const history = await api("GET", `/history?symbol=${encodeURIComponent("src/pages/ProfilePage.tsx#ProfilePage")}`);
      expect(history.body).toMatchObject({ symbol: "src/pages/ProfilePage.tsx#ProfilePage", history: [{ lsn: 122, intent: "Show last-seen time on ProfilePage", signature: false }], declaredBy: [] });
      expect((await api("GET", "/history")).status).toBe(400);
    });

    it("renews its own leases by asking the server again once half their time is gone, and only while their intent is open", async () => {
      await start(fixtureMessages(), 122);
      await waitFor(() => log.some((l) => l.includes("is at #")));
      await writeState(worktree, { appliedLsn: 122, intentId: "int_07" });
      const mine = "src/pages/ProfilePage.tsx#ProfilePage";
      await api("POST", "/lease", { symbol: mine, ttlSeconds: 120 });
      const first = server.leases.get(mine)?.expiresAt ?? "";
      const soon = new Date(Date.now() + 20_000).toISOString();
      server.leases.set(symbol, leaseOf(agentA, symbol, { expiresAt: soon }));
      await daemon.renewLeases(); // more than half its time left: nothing to do
      expect(server.leases.get(mine)?.expiresAt).toBe(first);
      const runningOut = () => server.leases.set(mine, { ...(server.leases.get(mine) as Lease), expiresAt: soon });
      runningOut(); // 20 s left of 120
      await daemon.renewLeases();
      expect(Date.parse(server.leases.get(mine)?.expiresAt ?? "")).toBeGreaterThan(Date.now() + 100_000);
      expect(server.leases.get(mine)).toMatchObject({ intentId: "int_07", holder: author });
      expect(server.leases.get(symbol)).toMatchObject({ holder: agentA, expiresAt: soon }); // another's lease is never touched
      await writeState(worktree, { appliedLsn: 122 }); // the intent closed
      runningOut();
      await daemon.renewLeases();
      expect(server.leases.get(mine)?.expiresAt).toBe(soon);
    });

    it("tells the agent when its own lease ended without its asking, or its intent went stale", async () => {
      await start(fixtureMessages(), 122);
      await waitFor(() => log.some((l) => l.includes("is at #")));
      await writeState(worktree, { appliedLsn: 122, intentId: "int_07" });
      await safePoint();
      const mine = (sym: string, status: Lease["status"]) => leaseOf(author, sym, { intentId: "int_07", status });
      server.broadcast({ type: "lease", lease: mine("src/a.ts#a", "expired") });
      server.broadcast({ type: "lease", lease: mine("src/b.ts#b", "released") }); // an owner released it; the intent is still open
      server.broadcast({ type: "lease", lease: { ...mine("src/c.ts#c", "released"), intentId: "int_old" } }); // a commit's release: no news
      await waitFor(() => log.filter((l) => l.startsWith("lease on")).length >= 3);
      expect((await safePoint()).notes).toEqual([
        "your lease on src/a.ts#a ended (expired); another agent may take it. Take it again with lease if you still need it",
        "your lease on src/b.ts#b ended (released); another agent may take it. Take it again with lease if you still need it",
      ]);
      server.broadcast({ type: "intent", intent: { id: "int_07", repo: "local/default", author, baseLsn: 122, text: "t", declaredSymbols: [], status: "stale", heartbeatAt: "2026-10-18T03:00:00.000Z" } });
      server.broadcast({ type: "lease", lease: mine("src/d.ts#d", "released") });
      await waitFor(() => log.filter((l) => l.startsWith("lease on")).length >= 4);
      expect((await safePoint()).notes).toEqual([
        "your intent int_07 was marked stale (no heartbeat for 5 minutes) and its leases were released; declare_intent again before you take a lease",
      ]);
    });
  });

  it("is reachable through LocalClient and the CLI's safe-point command", async () => {
    await start();
    await waitFor(() => applier.lsns.includes(122));
    const client = new LocalClient(worktree);
    expect((await client.status()).appliedLsn).toBe(122);
    expect((await client.safePoint()).applied).toEqual([]);
  });
});
