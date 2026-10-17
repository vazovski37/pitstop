import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeJoin, typecheckGate } from "./checks.js";
import type { Tree } from "./store.js";

const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] });

const project = (): Tree =>
  new Map([
    ["tsconfig.json", tsconfig],
    ["src/a.ts", "export const a: number = 1;\n"],
    ["src/b.ts", 'import { a } from "./a.js";\nexport const b = a + 1;\n'],
  ]);

// Each run starts tsc in a child process: a few seconds, so the timeouts are generous.
describe("typecheckGate", () => {
  it("passes a tree that type-checks", async () => {
    expect(await typecheckGate(project(), [])).toEqual({ typecheck: "pass" });
  }, 60_000);

  it("fails with tsc's own errors when a commit breaks the merged tree", async () => {
    const result = await typecheckGate(project(), [{ path: "src/a.ts", op: "modify", content: 'export const a: number = "one";\n' }]);
    expect(result.typecheck).toBe("fail");
    expect(result.details).toMatch(/src\/a\.ts\(1,14\): error TS2322/);
  }, 60_000);

  it("sees the commit's files on top of the tree, including deletes", async () => {
    const result = await typecheckGate(project(), [{ path: "src/a.ts", op: "delete" }]);
    expect(result.typecheck).toBe("fail");
    expect(result.details).toContain("TS2307"); // b.ts cannot find ./a.js any more
  }, 60_000);

  it("skips a tree without a tsconfig", async () => {
    expect(await typecheckGate(new Map([["README.md", "# hi\n"]]), [])).toMatchObject({ typecheck: "skipped" });
  });

  it("refuses paths that would leave the temp folder", () => {
    const root = join(tmpdir(), "pitstop-gate-test");
    expect(() => safeJoin(root, "../escape.ts")).toThrow(/refusing/);
    expect(() => safeJoin(root, "src/../../escape.ts")).toThrow(/refusing/);
    expect(() => safeJoin(root, "/etc/passwd")).toThrow(/refusing/);
    expect(safeJoin(root, "src/a.ts")).toBe(join(root, "src", "a.ts"));
  });
});
