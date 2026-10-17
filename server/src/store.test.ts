import { describe, expect, it } from "vitest";
import type { CommitRequest } from "@pitstop/protocol";
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
    expect(await store.treeAt(1)).toEqual(new Map([["src/a.ts", "1"], ["src/b.ts", "1"]]));
    expect(await store.treeAt(3)).toEqual(new Map([["src/a.ts", "2"], ["src/c.ts", "1"]]));
    expect(await store.treeAt(0)).toEqual(new Map());
  });
});
