import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REPO, type CommitRequest } from "@pitstop/protocol";
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
    await pool.query("delete from repos where id <> $1", [DEFAULT_REPO]);
    await pool.query("insert into repos (id) values ($1) on conflict (id) do nothing", [DEFAULT_REPO]);
  });
  afterAll(() => pool.end());

  it("assigns consecutive LSNs to concurrent appends", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.append(request(`c${i}`))));
    const lsns = results.map((r) => r.lsn).sort((a, b) => a - b);
    expect(lsns).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await store.headLsn(DEFAULT_REPO)).toBe(10);
    expect(results[0]?.repo).toBe(DEFAULT_REPO);
  });

  it("returns the same changeset for a repeated idempotency key", async () => {
    const first = await store.append(request("dup"));
    const again = await store.append(request("dup"));
    expect(again).toEqual(first);
    expect(await store.headLsn(DEFAULT_REPO)).toBe(first.lsn);
  });

  it("round-trips files with content and the symbol sets", async () => {
    const sent = await store.append(request("rt", 0, { sigWriteSet: ["src/a.ts#a"] }));
    const [back] = await store.entriesAfter(DEFAULT_REPO, sent.lsn - 1, 1);
    expect(back).toEqual(sent);
    expect(back?.files[0]).toMatchObject({ path: "src/a.ts", op: "modify", blob: blobHash(content), content });
    expect(back?.readSet).toEqual(["src/b.ts#b"]);
    expect(back?.writeSet).toEqual(["src/a.ts#a"]);
    expect(back?.sigWriteSet).toEqual(["src/a.ts#a"]);
    expect(back?.checks).toEqual({ typecheck: "skipped", tests: "skipped", adr: "skipped" });
  });

  it("pages entries in LSN order", async () => {
    const page = await store.entriesAfter(DEFAULT_REPO, 2, 3);
    expect(page.map((e) => e.lsn)).toEqual([3, 4, 5]);
  });

  it("closes the intent a commit names and rejects an unknown one", async () => {
    const intent = await store.openIntent({
      author: { developer: "teammate", agent: "agent-b" },
      baseLsn: 0,
      text: "Show last-seen",
      declaredSymbols: ["src/pages/ProfilePage.tsx#ProfilePage"],
    });
    expect(intent).toMatchObject({ status: "open", repo: DEFAULT_REPO });
    await store.append(request("i1", 0, { intentId: intent.id }));
    const row = await pool.query<{ status: string }>("select status from intents where id = $1", [intent.id]);
    expect(row.rows[0]?.status).toBe("committed");
    await expect(store.append(request("i2", 0, { intentId: "int_nope" }))).rejects.toBeInstanceOf(InvalidCommit);
  });

  it("rejects a base at or beyond the next LSN", async () => {
    const head = await store.headLsn(DEFAULT_REPO);
    await expect(store.append(request("ahead", head + 1))).rejects.toBeInstanceOf(InvalidCommit);
    expect(await store.headLsn(DEFAULT_REPO)).toBe(head);
  });

  it("runs the decision inside the append with the gap after the base, and records what it returns", async () => {
    const head = await store.headLsn(DEFAULT_REPO);
    let seen: { gap: number; head: number } | undefined;
    const landed = await store.append(request("decided", head - 2), (gap, at) => {
      seen = { gap: gap.length, head: at };
      return { checks: { typecheck: "pass", tests: "skipped", adr: "skipped", details: "decided" } };
    });
    expect(seen).toEqual({ gap: 2, head });
    expect(landed.checks).toEqual({ typecheck: "pass", tests: "skipped", adr: "skipped", details: "decided" });
    const [back] = await store.entriesAfter(DEFAULT_REPO, landed.lsn - 1, 1);
    expect(back?.checks.details).toBe("decided");
  });

  it("folds the log into the tree at an LSN, with deletes and renames", async () => {
    const head = await store.headLsn(DEFAULT_REPO);
    const added = await store.append(request("tree-add", 0, { files: [{ path: "tree/x.ts", op: "add", content: "x1" }, { path: "tree/y.ts", op: "add", content: "y1" }] }));
    const edited = await store.append(request("tree-edit", 0, { files: [{ path: "tree/x.ts", op: "modify", content: "x2" }] }));
    const moved = await store.append(request("tree-move", 0, { files: [{ path: "tree/z.ts", op: "rename", fromPath: "tree/y.ts", content: "y1" }] }));
    const before = await store.treeAt(DEFAULT_REPO, head);
    expect([...before.keys()].filter((p) => p.startsWith("tree/"))).toEqual([]);
    const afterAdd = await store.treeAt(DEFAULT_REPO, added.lsn);
    expect(afterAdd.get("tree/x.ts")).toBe("x1");
    expect(afterAdd.get("tree/y.ts")).toBe("y1");
    const afterEdit = await store.treeAt(DEFAULT_REPO, edited.lsn);
    expect(afterEdit.get("tree/x.ts")).toBe("x2");
    const afterMove = await store.treeAt(DEFAULT_REPO, moved.lsn);
    expect(afterMove.has("tree/y.ts")).toBe(false);
    expect(afterMove.get("tree/z.ts")).toBe("y1");
    await store.append(request("tree-del", 0, { files: [{ path: "tree/x.ts", op: "delete" }] }));
    expect((await store.treeAt(DEFAULT_REPO, await store.headLsn(DEFAULT_REPO))).has("tree/x.ts")).toBe(false);
  });

  it("a rejecting decision appends nothing", async () => {
    const head = await store.headLsn(DEFAULT_REPO);
    await expect(
      store.append(request("refused", 0), () => {
        throw new RejectedCommit("constraint_failed", "no", [1]);
      }),
    ).rejects.toBeInstanceOf(RejectedCommit);
    expect(await store.headLsn(DEFAULT_REPO)).toBe(head);
  });

  it("keeps a log per repository, with its own LSNs, tree and intents", async () => {
    const other = "pg-test/other";
    const first = await store.createRepo(other);
    expect(first).toMatchObject({ created: true, repo: { id: other, headLsn: 0 } });
    expect(await store.createRepo(other)).toMatchObject({ created: false, repo: { id: other } });

    const defaultHead = await store.headLsn(DEFAULT_REPO);
    const landed = await store.append(request("other-1", 0, { repo: other, files: [{ path: "only/here.ts", op: "add", content: "1" }] }));
    expect(landed).toMatchObject({ repo: other, lsn: 1 });
    expect(await store.headLsn(other)).toBe(1);
    expect(await store.headLsn(DEFAULT_REPO)).toBe(defaultHead);
    expect((await store.entriesAfter(other, 0, 10)).map((e) => e.lsn)).toEqual([1]);
    expect((await store.treeAt(other, 1)).has("only/here.ts")).toBe(true);
    expect((await store.treeAt(DEFAULT_REPO, defaultHead)).has("only/here.ts")).toBe(false);

    const intent = await store.openIntent({ repo: other, author: { developer: "x", agent: "y" }, baseLsn: 1, text: "t", declaredSymbols: [] });
    expect(intent.repo).toBe(other);
    expect(await store.getRepo(other)).toMatchObject({ id: other, headLsn: 1 });
    expect((await store.listRepos()).map((r) => r.id)).toEqual(expect.arrayContaining([DEFAULT_REPO, other]));
  });

  it("refuses a repository that does not exist", async () => {
    await expect(store.append(request("nowhere", 0, { repo: "no/such" }))).rejects.toThrow(/unknown repo no\/such/);
    await expect(store.openIntent({ repo: "no/such", author: { developer: "x", agent: "y" }, baseLsn: 0, text: "t", declaredSymbols: [] })).rejects.toThrow(/unknown repo/);
    expect(await store.getRepo("no/such")).toBeUndefined();
    expect(await store.headLsn("no/such")).toBe(0);
  });
});
