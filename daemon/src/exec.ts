import { execFile } from "node:child_process";

export interface RunOptions {
  cwd: string;
  /** Written to the command's stdin, then stdin is closed. */
  input?: string;
  /** Added to the daemon's own environment. */
  env?: Record<string, string>;
}

export class CommandError extends Error {
  constructor(
    readonly command: string,
    readonly code: number | string | null,
    readonly stderr: string,
  ) {
    super(`${command} failed (${code ?? "no exit code"}): ${stderr.trim()}`);
  }
}

/** Runs `file args...` without a shell and resolves with its stdout. Rejects with `CommandError` on a non-zero exit. */
export function run(file: string, args: string[], opts: RunOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code ?? null;
          reject(new CommandError(`${file} ${args.join(" ")}`, code, stderr || err.message));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(opts.input ?? "");
  });
}
