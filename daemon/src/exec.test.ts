import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CommandError, run } from "./exec.js";

describe("run", () => {
  it("resolves with stdout and feeds the input to stdin", async () => {
    const out = await run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { cwd: tmpdir(), input: "hi" });
    expect(out).toBe("hi");
  });

  it("rejects with CommandError on a non-zero exit, with stderr", async () => {
    const failing = run(process.execPath, ["-e", "console.error('boom'); process.exit(3)"], { cwd: tmpdir() });
    await expect(failing).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining("boom") });
  });

  it("rejects with CommandError when the executable does not exist, and raises nothing else", async () => {
    // Before stdin had an error handler, the write to the never-started child's stdin surfaced as
    // an unhandled EPIPE, failing whole CI runs where jj or Mergiraf are not installed.
    await expect(run("pitstop-no-such-command", ["--version"], { cwd: tmpdir() })).rejects.toBeInstanceOf(CommandError);
  });
});
