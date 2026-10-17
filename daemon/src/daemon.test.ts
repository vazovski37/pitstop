import { afterEach, beforeEach, describe, expect, it, onTestFailed } from "vitest";
import { type Author, type ServerMessage } from "@pitstop/protocol";
import { Daemon, readDaemonInfo, type SafePointResult, type Status } from "./daemon.js";
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
    await waitFor(() => applier.lsns.includes(122));
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

  it("notes symbol-level overlap from the TypeScript project", async () => {
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
        repairs: ["Added null check: redirect to login when the session has expired"],
      },
    ]);
    expect((await api("GET", "/why?path=nope.ts")).body).toEqual([]);
    const callers = await api("GET", `/callers?symbol=${encodeURIComponent("src/auth/session.ts#getCurrentUser")}`);
    expect(callers.body).toMatchObject({ readers: [{ lsn: 122, agent: "agent-b" }], writers: [] });
    expect((await api("GET", "/callers")).status).toBe(400);
    expect((await api("GET", "/nothing")).status).toBe(404);
  });

  it("is reachable through LocalClient and the CLI's safe-point command", async () => {
    await start();
    await waitFor(() => applier.lsns.includes(122));
    const client = new LocalClient(worktree);
    expect((await client.status()).appliedLsn).toBe(122);
    expect((await client.safePoint()).applied).toEqual([]);
  });
});
