/**
 * The agent side's view of the worktree's daemon: its port is in .pitstop/daemon.json, written
 * by `pitstop daemon` (daemon/src/daemon.ts). Tools and the hook talk to it, never to the server.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export class NoDaemon extends Error {
  constructor(worktree: string) {
    super(`No daemon is running in ${worktree}: start \`pitstop daemon\` there.`);
  }
}

export interface SafePointResult {
  applied: number[];
  pending: number;
  notes: string[];
}

export interface Status {
  appliedLsn: number;
  headLsn: number | null;
  pending: number;
  attached: boolean;
  intent: { id: string; text: string } | null;
  openIntents: { id: string; agent: string; text: string }[];
  worktree: string;
}

export interface Intent {
  id: string;
  text: string;
  baseLsn: number;
  declaredSymbols: string[];
}

export type CommitAnswer =
  | { status: "accepted"; changeset: { lsn: number; intent: string; files: { path: string }[]; repairs: { summary: string }[] } }
  | { status: "rejected"; reason: string; message: string; conflictsWith: number[] };

export interface WhyEntry {
  lsn: number;
  intent: string;
  agent: string;
  op: string;
  createdAt: string;
  repairs: string[];
}

export interface Ref {
  lsn: number;
  intent: string;
  agent: string;
  files: string[];
}

export class DaemonClient {
  constructor(
    readonly worktree: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  safePoint(): Promise<SafePointResult> {
    return this.call("POST", "/safe-point") as Promise<SafePointResult>;
  }

  status(): Promise<Status> {
    return this.call("GET", "/status") as Promise<Status>;
  }

  declareIntent(text: string, symbols: string[]): Promise<Intent> {
    return this.call("POST", "/intents", { text, symbols }) as Promise<Intent>;
  }

  commit(intent: string): Promise<CommitAnswer> {
    return this.call("POST", "/commit", { intent }) as Promise<CommitAnswer>;
  }

  why(path: string): Promise<WhyEntry[]> {
    return this.call("GET", `/why?path=${encodeURIComponent(path)}`) as Promise<WhyEntry[]>;
  }

  callers(symbol: string): Promise<{ readers: Ref[]; writers: Ref[] }> {
    return this.call("GET", `/callers?symbol=${encodeURIComponent(symbol)}`) as Promise<{ readers: Ref[]; writers: Ref[] }>;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    let port: number;
    try {
      const info = JSON.parse(await readFile(join(this.worktree, ".pitstop", "daemon.json"), "utf8")) as { port?: unknown };
      if (typeof info.port !== "number") throw new Error("no port");
      port = info.port;
    } catch {
      throw new NoDaemon(this.worktree);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new NoDaemon(this.worktree);
    }
    const answer: unknown = await res.json().catch(() => undefined);
    if (!res.ok && res.status !== 409) {
      const error = (answer as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
      throw new Error(`The daemon answered ${method} ${path} with: ${error}`);
    }
    return answer;
  }
}
