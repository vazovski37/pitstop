import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@pitstop/protocol";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { readState, writeState } from "./state.js";
import { GAP_RETRIES, GapError, StreamClient } from "./stream.js";
import { entryAt, FakeApplier, fixtureMessages, sleep, tempDir, waitFor } from "./test-support.js";

const hello: ServerMessage = { type: "hello", serverVersion: "test", headLsn: 124 };
const threeEntries: ServerMessage[] = [
  hello,
  { type: "entry", changeset: entryAt(122) },
  { type: "entry", changeset: entryAt(123) },
  { type: "entry", changeset: entryAt(124) },
];

describe("stream client", () => {
  let worktree: string;
  let server: FakeServer | undefined;
  let client: StreamClient | undefined;
  const applier = new FakeApplier();
  const log: string[] = [];

  const start = async (extra: Partial<ConstructorParameters<typeof StreamClient>[0]> = {}) => {
    if (!server) throw new Error("start the server first");
    client = new StreamClient({
      url: server.streamUrl,
      worktree,
      applier,
      log: (line) => log.push(line),
      reconnectMs: 0,
      heartbeatMs: 0,
      ...extra,
    });
    await client.start();
    return client;
  };

  beforeEach(async () => {
    worktree = await tempDir();
    applier.applied = [];
    applier.failOn = undefined;
    log.length = 0;
  });
  afterEach(async () => {
    client?.close();
    await server?.close();
    server = undefined;
    await rm(worktree, { recursive: true, force: true });
  });

  it("subscribes from the applied LSN and applies the fixture entry", async () => {
    server = await startFakeServer({ messages: fixtureMessages() });
    await writeState(worktree, { appliedLsn: 121 });
    await start();
    await waitFor(() => applier.lsns.length === 1);
    expect(applier.lsns).toEqual([122]);
    expect(server.received[0]).toEqual({ type: "subscribe", fromLsn: 121 });
    await waitFor(() => server!.received.some((m) => m.type === "heartbeat" && m.appliedLsn === 122));
    expect(await readState(worktree)).toEqual({ appliedLsn: 122 });
    expect(log).toContain("connected to server abc1234, head #122");
    expect(log.some((l) => l.startsWith("warning for agent-b"))).toBe(true);
  });

  it("skips entries at or below the applied LSN", async () => {
    server = await startFakeServer({ messages: fixtureMessages() });
    await writeState(worktree, { appliedLsn: 122 });
    await start();
    await waitFor(() => server!.received.length >= 1);
    await sleep(100);
    expect(applier.lsns).toEqual([]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 122 });
  });

  it("applies entries strictly in order and subscribes again on a gap", async () => {
    server = await startFakeServer({ messages: threeEntries, dropOnce: 123 });
    await writeState(worktree, { appliedLsn: 121 });
    const gaps: [number, number][] = [];
    const applied: number[] = []; // onApplied fires once the state file is written
    await start({ onGap: (expected, got) => gaps.push([expected, got]), onApplied: (lsn) => applied.push(lsn) });
    await waitFor(() => applied.includes(124));
    expect(applier.lsns).toEqual([122, 123, 124]);
    expect(gaps).toEqual([[123, 124]]);
    const subscribes = server.received.filter((m) => m.type === "subscribe").map((m) => m.fromLsn);
    expect(subscribes).toEqual([121, 122]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 124 });
  });

  it("gives up when the log keeps skipping the next LSN", async () => {
    server = await startFakeServer({ messages: [hello, { type: "entry", changeset: entryAt(124) }] });
    await writeState(worktree, { appliedLsn: 121 });
    const errors: unknown[] = [];
    await start({ onError: (err) => errors.push(err) });
    await waitFor(() => errors.length === 1);
    expect(errors[0]).toBeInstanceOf(GapError);
    expect(server.received.filter((m) => m.type === "subscribe")).toHaveLength(GAP_RETRIES);
    expect(applier.lsns).toEqual([]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 121 });
  });

  it("applies entries appended while it is connected", async () => {
    server = await startFakeServer({ messages: [hello, { type: "entry", changeset: entryAt(122) }] });
    await writeState(worktree, { appliedLsn: 121 });
    await start();
    await waitFor(() => applier.lsns.length === 1);
    server.append(entryAt(123));
    await waitFor(() => applier.lsns.length === 2);
    expect(applier.lsns).toEqual([122, 123]);
  });

  it("stops applying and reports when an apply fails", async () => {
    server = await startFakeServer({ messages: threeEntries });
    await writeState(worktree, { appliedLsn: 121 });
    applier.failOn = 123;
    const errors: unknown[] = [];
    await start({ onError: (err) => errors.push(err) });
    await waitFor(() => errors.length === 1);
    expect(applier.lsns).toEqual([122]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 122 });
    expect(log.some((l) => /apply failed, stopped at #122: cannot apply #123/.test(l))).toBe(true);
  });

  it("trusts a state file advanced by another process", async () => {
    server = await startFakeServer({ messages: [hello, { type: "entry", changeset: entryAt(122) }] });
    await writeState(worktree, { appliedLsn: 121 });
    await start();
    await waitFor(() => applier.lsns.length === 1);
    // `pitstop commit` applied #123 itself and advanced the state file.
    await writeState(worktree, { appliedLsn: 123 });
    applier.failOn = 123; // never reached: the daemon re-reads the state file first
    server.append(entryAt(123));
    server.append(entryAt(124));
    await waitFor(() => applier.lsns.includes(124));
    expect(applier.lsns).toEqual([122, 124]);
  });

  it("records where unfinished work began, for readBaseLsn", async () => {
    server = await startFakeServer({ messages: threeEntries });
    await writeState(worktree, { appliedLsn: 121 });
    applier.changes = true;
    const applied: number[] = [];
    await start({ onApplied: (lsn) => applied.push(lsn) });
    await waitFor(() => applied.includes(124));
    expect(await readState(worktree)).toEqual({ appliedLsn: 124, readBaseLsn: 121 });
    applier.changes = false;
  });

  it("records nothing when @ is empty", async () => {
    server = await startFakeServer({ messages: threeEntries });
    await writeState(worktree, { appliedLsn: 121 });
    const applied: number[] = [];
    await start({ onApplied: (lsn) => applied.push(lsn) });
    await waitFor(() => applied.includes(124));
    expect(await readState(worktree)).toEqual({ appliedLsn: 124 });
  });

  it("sends the shared token", async () => {
    server = await startFakeServer({ messages: fixtureMessages(), token: "s3cret" });
    await writeState(worktree, { appliedLsn: 121 });
    await start({ token: "s3cret" });
    await waitFor(() => applier.lsns.length === 1);
    const refused = new StreamClient({ url: server.streamUrl, worktree, applier, log: (l) => log.push(l), reconnectMs: 0, heartbeatMs: 0 });
    await refused.start();
    await waitFor(() => log.some((l) => l.includes("401")));
    refused.close();
  });
});
