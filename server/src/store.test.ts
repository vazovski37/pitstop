import { describe, expect, it } from "vitest";
import { DEFAULT_REPO, type CommitRequest } from "@pitstop/protocol";
import { applyFiles, MemoryStore } from "./store.js";

const request = (key: string, baseLsn: number, files: CommitRequest["files"]): CommitRequest => ({
  idempotencyKey: `idem-${key}-01`,
  baseLsn,
  author: { developer: "vazovski", agent: "agent-a" },
  intent: key,
  files,
  writeSet: [],
  sigWriteSet: [],
  readSet: [],
});

describe("applyFiles", () => {
  it("adds, modifies, deletes and renames", () => {
    const tree = new Map([["a.ts", "a"], ["b.ts", "b"], ["c.ts", "c"]]);
    applyFiles(tree, [
      { path: "a.ts", op: "modify", content: "a2" },
      { path: "b.ts", op: "delete" },
      { path: "d.ts", op: "rename", fromPath: "c.ts" },
      { path: "e.ts", op: "add", content: "e" },
    ]);
    expect([...tree.entries()].sort()).toEqual([["a.ts", "a2"], ["d.ts", "c"], ["e.ts", "e"]]);
  });

  it("keeps a file a change without content points at", () => {
    const tree = new Map([["a.ts", "a"]]);
    applyFiles(tree, [{ path: "a.ts", op: "modify", blob: `sha256:${"0".repeat(64)}` }]);
    expect(tree.get("a.ts")).toBe("a");
  });
});

describe("MemoryStore.treeAt", () => {
  it("folds the log up to the entry asked for", async () => {
    const store = new MemoryStore();
    await store.append(request("import", 0, [{ path: "src/a.ts", op: "add", content: "1" }, { path: "src/b.ts", op: "add", content: "1" }]));
    await store.append(request("edit", 1, [{ path: "src/a.ts", op: "modify", content: "2" }]));
    await store.append(request("move", 2, [{ path: "src/c.ts", op: "rename", fromPath: "src/b.ts", content: "1" }]));
    expect(await store.treeAt(DEFAULT_REPO, 1)).toEqual(new Map([["src/a.ts", "1"], ["src/b.ts", "1"]]));
    expect(await store.treeAt(DEFAULT_REPO, 3)).toEqual(new Map([["src/a.ts", "2"], ["src/c.ts", "1"]]));
    expect(await store.treeAt(DEFAULT_REPO, 0)).toEqual(new Map());
  });
});

describe("MemoryStore repositories", () => {
  it("keeps a log per repository and refuses unknown ones", async () => {
    const store = new MemoryStore();
    expect(await store.createRepo("acme/app")).toMatchObject({ created: true, repo: { id: "acme/app", headLsn: 0 } });
    expect(await store.createRepo("acme/app")).toMatchObject({ created: false });
    await store.append(request("default-1", 0, [{ path: "a.ts", op: "add", content: "a" }]));
    const other = await store.append({ ...request("acme-1", 0, [{ path: "b.ts", op: "add", content: "b" }]), repo: "acme/app" });
    expect(other).toMatchObject({ repo: "acme/app", lsn: 1 });
    expect(await store.headLsn(DEFAULT_REPO)).toBe(1);
    expect(await store.headLsn("acme/app")).toBe(1);
    expect((await store.treeAt("acme/app", 1)).has("a.ts")).toBe(false);
    expect((await store.listRepos()).map((r) => r.id)).toEqual(["acme/app", DEFAULT_REPO]);
    await expect(store.append({ ...request("nowhere", 0, []), repo: "no/such" })).rejects.toThrow(/unknown repo/);
  });
});
