/** The agent side's view of a running daemon: find its port in .pitstop/daemon.json and call it. */
import { readDaemonInfo, type SafePointResult, type Status } from "./daemon.js";

export class NoDaemon extends Error {
  constructor(worktree: string) {
    super(`no daemon is running in ${worktree} (start one with \`pitstop start\`)`);
  }
}

export class LocalClient {
  constructor(
    readonly worktree: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async safePoint(): Promise<SafePointResult> {
    return (await this.call("POST", "/safe-point")) as SafePointResult;
  }

  async status(): Promise<Status> {
    return (await this.call("GET", "/status")) as Status;
  }

  async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const info = await readDaemonInfo(this.worktree);
    if (!info) throw new NoDaemon(this.worktree);
    let res: Response;
    try {
      res = await this.fetchImpl(`http://127.0.0.1:${info.port}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NoDaemon(this.worktree);
    }
    const answer: unknown = await res.json().catch(() => undefined);
    if (!res.ok && res.status !== 409) {
      const error = (answer as { error?: string } | undefined)?.error ?? `${res.status}`;
      throw new Error(`daemon answered ${method} ${path} with ${error}`);
    }
    return answer;
  }
}
