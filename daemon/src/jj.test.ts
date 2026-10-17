import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./exec.js";
import { ApplyError, binariesFromEnv, blobHash, JjWorktree } from "./jj.js";
import { writeState } from "./state.js";
import { entryAt, tempDir } from "./test-support.js";

// Runs only where jj and git are installed (PITSTOP_JJ_BIN / PITSTOP_GIT_BIN point at them when not on PATH).
const bin = binariesFromEnv();
const available = await Promise.all([
  run(bin.jj, ["--version"], { cwd: tmpdir() }),
  run(bin.git, ["--version"], { cwd: tmpdir() }),
]).then(
  () => true,
  () => false,
);

describe.skipIf(!available)("JjWorktree against a real colocated repo", () => {
  let dir: string;
  let wt: JjWorktree;
  const git = (...args: string[]) => run(bin.git, args, { cwd: dir });
  const jj = (...args: string[]) => run(bin.jj, args, { cwd: dir, env: { JJ_USER: "agent", JJ_EMAIL: "agent@test" } });
  const file = (name: string) => readFile(join(dir, name), "utf8");

  beforeEach(async () => {
    dir = await tempDir();
    await git("init", "-q", "-b", "main");
    await git("config", "user.name", "test");
    await git("config", "user.email", "test@test");
    await jj("git", "init", "--colocate");
    await writeFile(join(dir, "a.txt"), "a1\na2\na3\n");
    await writeFile(join(dir, "b.txt"), "b1\nb2\n");
    await jj("describe", "-m", "base");
    await jj("bookmark", "create", "main", "-r", "@");
    await jj("new");
    process.env.JJ_USER = "agent";
    process.env.JJ_EMAIL = "agent@test";
    wt = new JjWorktree(dir, bin);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const entry = (lsn: number, path: string, content: string) =>
    entryAt(lsn, { files: [{ path, op: "modify", blob: blobHash(content), content }] });

  it("applies an entry: writes the file, moves main, keeps the agent's unfinished edit", async () => {
    await writeFile(join(dir, "b.txt"), "b1\nb2-local\n");
    const result = await wt.apply(entry(122, "a.txt", "a1\na2-server\na3\n"));
    expect(result.conflicted).toEqual([]);
    expect(await file("a.txt")).toBe("a1\na2-server\na3\n");
    expect(await file("b.txt")).toBe("b1\nb2-local\n");
    expect((await git("log", "-1", "--format=%s", "main")).trim()).toBe("#122 entry #122");
    expect((await git("rev-parse", "main")).trim()).toBe(result.commit);
  });

  it("reports a conflict and keeps both sides in the working copy", async () => {
    await writeFile(join(dir, "a.txt"), "a1\na2-local\na3\n");
    const result = await wt.apply(entry(122, "a.txt", "a1\na2-server\na3\n"));
    expect(result.conflicted).toHaveLength(1);
    const text = await file("a.txt");
    expect(text).toContain("<<<<<<<");
    expect(text).toContain("a2-local");
    expect(text).toContain("a2-server");
  });

  it("handles add, delete and rename", async () => {
    const cs = entryAt(122, {
      files: [
        { path: "c.txt", op: "add", content: "c1\n", blob: blobHash("c1\n") },
        { path: "b.txt", op: "delete" },
        { path: "d.txt", op: "rename", fromPath: "a.txt" },
      ],
    });
    await wt.apply(cs);
    expect(await file("c.txt")).toBe("c1\n");
    expect(await file("d.txt")).toBe("a1\na2\na3\n");
    await expect(file("a.txt")).rejects.toThrow();
    await expect(file("b.txt")).rejects.toThrow();
  });

  it("refuses an entry without content or with a wrong blob before touching anything", async () => {
    const before = (await git("rev-parse", "main")).trim();
    await expect(wt.apply(entryAt(122, { files: [{ path: "a.txt", op: "modify" }] }))).rejects.toBeInstanceOf(ApplyError);
    await expect(
      wt.apply(entryAt(122, { files: [{ path: "a.txt", op: "modify", content: "x\n", blob: blobHash("y\n") }] })),
    ).rejects.toBeInstanceOf(ApplyError);
    expect((await git("rev-parse", "main")).trim()).toBe(before);
  });

  it("rolls back to the operation before the apply when a step fails", async () => {
    const before = (await git("rev-parse", "main")).trim();
    const broken = new JjWorktree(dir, { ...bin, git: bin.git }, "main");
    // Rename from a path that does not exist fails inside buildCommit, after the snapshot.
    await expect(
      broken.apply(entryAt(122, { files: [{ path: "z.txt", op: "rename", fromPath: "missing.txt" }] })),
    ).rejects.toThrow();
    expect((await git("rev-parse", "main")).trim()).toBe(before);
    expect(await file("a.txt")).toBe("a1\na2\na3\n");
  });

  it("lists @ against main as file changes with content, ignoring the state directory", async () => {
    await writeState(dir, { appliedLsn: 121 });
    await writeFile(join(dir, "a.txt"), "a1\na2-local\na3\n");
    await rm(join(dir, "b.txt"));
    await writeFile(join(dir, "c.txt"), "c1\n");
    const files = await wt.diffAgainstMain();
    expect(files.map((f) => `${f.op} ${f.path}`).sort()).toEqual(["add c.txt", "delete b.txt", "modify a.txt"]);
    const a = files.find((f) => f.path === "a.txt");
    expect(a).toMatchObject({ content: "a1\na2-local\na3\n", blob: blobHash("a1\na2-local\na3\n") });
    expect(files.find((f) => f.path === "b.txt")?.content).toBeUndefined();
    expect(files.some((f) => f.path.startsWith(".pitstop"))).toBe(false);
  });

  it("reports nothing when @ is empty", async () => {
    expect(await wt.diffAgainstMain()).toEqual([]);
  });
});
