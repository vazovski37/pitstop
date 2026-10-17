import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommitRequest, type Author } from "@pitstop/protocol";
import { commit, CommitRejected } from "./commit.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";
import { readState, writeState } from "./state.js";
import { FakeApplier, fixtureCommitFiles, fixtureMessages, tempDir } from "./test-support.js";

const author: Author = { developer: "teammate", agent: "agent-b" };

describe("pitstop commit", () => {
  let worktree: string;
  let server: FakeServer;
  const applier = new FakeApplier();

  beforeEach(async () => {
    worktree = await tempDir();
    server = await startFakeServer({ messages: fixtureMessages() }); // head #122
    applier.applied = [];
    applier.files = fixtureCommitFiles();
  });
  afterEach(async () => {
    await server.close();
    await rm(worktree, { recursive: true, force: true });
  });

  const send = (intent = "Show last-seen time on ProfilePage", extra: Partial<Parameters<typeof commit>[0]> = {}) =>
    commit({ serverUrl: server.url, worktree, applier, intent, author, ...extra });

  it("sends @ as a CommitRequest with content and applies the accepted entry", async () => {
    await writeState(worktree, { appliedLsn: 122 });
    const changeset = await send();
    expect(changeset.lsn).toBe(123);
    const sent = server.commits[0];
    expect(() => CommitRequest.parse(sent)).not.toThrow();
    expect(sent).toMatchObject({ baseLsn: 122, author, intent: "Show last-seen time on ProfilePage", writeSet: [], readSet: [] });
    expect(sent?.files[0]?.content).toContain("getCurrentUser");
    expect(sent?.idempotencyKey.length).toBeGreaterThanOrEqual(8);
    expect(applier.lsns).toEqual([123]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 123 });
  });

  it("leaves entries it has not applied yet to the daemon", async () => {
    await writeState(worktree, { appliedLsn: 120 });
    const changeset = await send();
    expect(changeset.lsn).toBe(123);
    expect(applier.lsns).toEqual([]);
    expect(await readState(worktree)).toEqual({ appliedLsn: 120 });
  });

  it("refuses to commit when @ has no changes", async () => {
    applier.files = [];
    await expect(send()).rejects.toThrow(/nothing to commit/);
    expect(server.commits).toEqual([]);
  });

  it("surfaces a rejection", async () => {
    await writeState(worktree, { appliedLsn: 122 });
    await expect(send("")).rejects.toBeInstanceOf(CommitRejected);
    expect(applier.lsns).toEqual([]);
  });

  it("sends the shared token", async () => {
    await server.close();
    server = await startFakeServer({ messages: fixtureMessages(), token: "s3cret" });
    await writeState(worktree, { appliedLsn: 122 });
    await expect(send()).rejects.toThrow(/401/);
    await expect(send(undefined, { token: "s3cret" })).resolves.toMatchObject({ lsn: 123 });
  });
});
