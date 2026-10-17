import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readState, withWorktreeLock, writeState } from "./state.js";
import { removeDir, tempDir } from "./test-support.js";

describe("daemon state", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(() => removeDir(dir));

  it("starts at LSN 0 in a worktree the daemon never saw", async () => {
    expect(await readState(dir)).toEqual({ appliedLsn: 0 });
  });

  it("round-trips the applied LSN and hides itself from version control", async () => {
    await writeState(dir, { appliedLsn: 122 });
    expect(await readState(dir)).toEqual({ appliedLsn: 122 });
    expect(await readFile(join(dir, ".pitstop", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("keeps readBaseLsn only while it is set", async () => {
    await writeState(dir, { appliedLsn: 122, readBaseLsn: 120 });
    expect(await readState(dir)).toEqual({ appliedLsn: 122, readBaseLsn: 120 });
    await writeState(dir, { appliedLsn: 123 });
    expect(await readState(dir)).toEqual({ appliedLsn: 123 });
  });

  it("runs locked sections one at a time and takes over a stale lock", async () => {
    const order: string[] = [];
    const section = (name: string, ms: number) =>
      withWorktreeLock(dir, async () => {
        order.push(`${name} in`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${name} out`);
      });
    const a = section("a", 60);
    await new Promise((r) => setTimeout(r, 15)); // a holds the lock before b asks for it
    await Promise.all([a, section("b", 10)]);
    expect(order).toEqual(["a in", "a out", "b in", "b out"]);

    const fs = await import("node:fs/promises");
    const lock = join(dir, ".pitstop", "lock");
    await fs.writeFile(lock, "dead\n");
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);
    await expect(withWorktreeLock(dir, async () => "ran", 60_000)).resolves.toBe("ran");
    await expect(fs.stat(lock)).rejects.toThrow();
  });

  it("refuses a file that is not a state file", async () => {
    await writeState(dir, { appliedLsn: 1 });
    await (await import("node:fs/promises")).writeFile(join(dir, ".pitstop", "state.json"), '{"appliedLsn":"x"}');
    await expect(readState(dir)).rejects.toThrow(/not a daemon state file/);
  });
});
