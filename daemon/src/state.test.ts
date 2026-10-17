import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readState, writeState } from "./state.js";
import { tempDir } from "./test-support.js";

describe("daemon state", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

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

  it("refuses a file that is not a state file", async () => {
    await writeState(dir, { appliedLsn: 1 });
    await (await import("node:fs/promises")).writeFile(join(dir, ".pitstop", "state.json"), '{"appliedLsn":"x"}');
    await expect(readState(dir)).rejects.toThrow(/not a daemon state file/);
  });
});
