import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import type { Checks, FileChange } from "@pitstop/protocol";
import { applyFiles, type Tree } from "./store.js";

const run = promisify(execFile);

/** The server's own TypeScript; the image keeps it because it is a dependency, not a dev one. */
const tscBin = createRequire(import.meta.url).resolve("typescript/bin/tsc");

export interface GateOptions {
  /** Default 60 s; a timeout counts as a failure. */
  timeoutMs?: number;
  /** How many error lines to keep in `details`. */
  maxDetailLines?: number;
}

export type GateResult = Pick<Checks, "typecheck" | "details">;

/**
 * The first constraint of section 7.4: `tsc --noEmit` on the tree at head with the commit's files
 * on top, in a temp folder. The tree must carry its own `tsconfig.json`; one that needs packages
 * from `node_modules` cannot pass here yet (the pitstop repo itself, for instance), so the gate is
 * off by default (`PITSTOP_CHECK`).
 */
export async function typecheckGate(tree: Tree, files: FileChange[], opts: GateOptions = {}): Promise<GateResult> {
  const candidate = applyFiles(new Map(tree), files);
  if (!candidate.has("tsconfig.json")) return { typecheck: "skipped", details: "no tsconfig.json at the root of the tree" };

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const dir = await mkdtemp(join(tmpdir(), "pitstop-gate-"));
  try {
    for (const [path, content] of candidate) {
      const target = safeJoin(dir, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    try {
      await run(process.execPath, [tscBin, "-p", "tsconfig.json", "--noEmit", "--pretty", "false"], {
        cwd: dir,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { typecheck: "pass" };
    } catch (err) {
      const failure = err as { stdout?: string; stderr?: string; killed?: boolean };
      if (failure.killed) return { typecheck: "fail", details: `type check timed out after ${timeoutMs} ms` };
      const lines = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
        .split(/\r?\n/)
        .filter((line) => line.trim() !== "")
        .slice(0, opts.maxDetailLines ?? 12);
      return { typecheck: "fail", details: lines.join("\n") || "tsc failed without output" };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Keeps a path from the log inside the temp folder: nothing absolute, no `..`. */
export function safeJoin(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`refusing to write ${path}`);
  const target = normalize(join(root, path));
  if (!target.startsWith(root + sep)) throw new Error(`refusing to write ${path}`);
  return target;
}
