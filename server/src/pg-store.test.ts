import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommitRequest } from "@pitstop/protocol";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { PgStore } from "./pg-store.js";
import { blobHash, InvalidCommit, RejectedCommit, withBlobHashes } from "./store.js";

// Runs only when a database is available: in CI (Postgres service container)
// or locally after `npm run db:up` with DATABASE_URL set.
const url = process.env.DATABASE_URL;

const content = "export const a = 1;\n";
const request = (key: string, baseLsn = 0, extra: Partial<CommitRequest> = {}): CommitRequest =>
  withBlobHashes({
    idempotencyKey: `pg-store-${key}`,
    baseLsn,
    author: { developer: "vazovski", agent: "agent-a" },
    intent: `change ${key}`,
    files: [{ path: "src/a.ts", op: "modify", content }],
    writeSet: ["src/a.ts#a"],
    sigWriteSet: [],
    readSet: ["src/b.ts#b"],
    ...extra,
  });

describe.skipIf(!url)("PgStore against a real Postgres", () => {
  const pool = createPool(url ?? "");
  const store = new PgStore(pool);

  beforeAll(async () => {
    await migrate(pool);
    await pool.query("truncate changesets, changeset_files, changeset_symbols, blobs, intents, leases cascade");
  });
  afterAll(() => pool.end());

  it("assigns consecutive LSNs to concurrent appends", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.append(request(`c${i}`))));
    const lsns = results.map((r) => r.lsn).sort((a, b) => a - b);
    expect(lsns).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await store.headLsn()).toBe(10);
  });

  it("returns the same changeset for a repeated idempotency key", async () => {
    const first = await store.append(request("dup"));
    const again = await store.append(request("dup"));
    expect(again).toEqual(first);
    expect(await store.headLsn()).toBe(first.lsn);
  });

  it("round-trips files with content and the symbol sets", async () => {
    const sent = await store.append(request("rt", 0, { sigWriteSet: ["src/a.ts#a"] }));
    const [back] = await store.entriesAfter(sent.lsn - 1, 1);
    expect(back).toEqual(sent);
    expect(back?.files[0]).toMatchObject({ path: "src/a.ts", op: "modify", blob: blobHash(content), content });
    expect(back?.readSet).toEqual(["src/b.ts#b"]);
    expect(back?.writeSet).toEqual(["src/a.ts#a"]);
    expect(back?.sigWriteSet).toEqual(["src/a.ts#a"]);
    expect(back?.checks).toEqual({ typecheck: "skipped", tests: "skipped", adr: "skipped" });
  });

  it("pages entries in LSN order", async () => {
    const page = await store.entriesAfter(2, 3);
    expect(page.map((e) => e.lsn)).toEqual([3, 4, 5]);
  });

  it("closes the intent a commit names and rejects an unknown one", async () => {
    const intent = await store.openIntent({
      author: { developer: "teammate", agent: "agent-b" },
      baseLsn: 0,
      text: "Show last-seen",
      declaredSymbols: ["src/pages/ProfilePage.tsx#ProfilePage"],
    });
    expect(intent.status).toBe("open");
    await store.append(request("i1", 0, { intentId: intent.id }));
    const row = await pool.query<{ status: string }>("select status from intents where id = $1", [intent.id]);
    expect(row.rows[0]?.status).toBe("committed");
    await expect(store.append(request("i2", 0, { intentId: "int_nope" }))).rejects.toBeInstanceOf(InvalidCommit);
  });

  it("rejects a base at or beyond the next LSN", async () => {
    const head = await store.headLsn();
    await expect(store.append(request("ahead", head + 1))).rejects.toBeInstanceOf(InvalidCommit);
    expect(await store.headLsn()).toBe(head);
  });

  it("runs the decision inside the append with the gap after the base, and records what it returns", async () => {
    const head = await store.headLsn();
    let seen: { gap: number; head: number } | undefined;
    const landed = await store.append(request("decided", head - 2), (gap, at) => {
      seen = { gap: gap.length, head: at };
      return { checks: { typecheck: "pass", tests: "skipped", adr: "skipped", details: "decided" } };
    });
    expect(seen).toEqual({ gap: 2, head });
    expect(landed.checks).toEqual({ typecheck: "pass", tests: "skipped", adr: "skipped", details: "decided" });
    const [back] = await store.entriesAfter(landed.lsn - 1, 1);
    expect(back?.checks.details).toBe("decided");
  });

  it("a rejecting decision appends nothing", async () => {
    const head = await store.headLsn();
    await expect(
      store.append(request("refused", 0), () => {
        throw new RejectedCommit("constraint_failed", "no", [1]);
      }),
    ).rejects.toBeInstanceOf(RejectedCommit);
    expect(await store.headLsn()).toBe(head);
  });
});
