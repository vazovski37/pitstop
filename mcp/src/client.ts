/**
 * The agent side's view of the worktree's daemon: its port is in .pitstop/daemon.json, written
 * by `pitstop daemon` (daemon/src/daemon.ts). Tools and the hook talk to it, never to the server.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PresenceEntry } from "@pitstop/protocol";

export class NoDaemon extends Error {
  constructor(worktree: string) {
    super(`No daemon is running in ${worktree}: run \`pitstop start\` there.`);
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
  /** The brain in brief (daemon/src/brain.ts): the ADRs, and leases others hold on the declared symbols. */
  brief?: string[];
}

export type CommitAnswer =
  | { status: "accepted"; changeset: { lsn: number; intent: string; files: { path: string }[]; repairs: { summary: string }[] } }
  | { status: "rejected"; reason: string; message: string; conflictsWith: number[] };

export interface WhyEntry {
  lsn: number;
  intent: string;
  intentId?: string;
  agent: string;
  op: string;
  createdAt: string;
  brainVersion?: number;
  repairs: string[];
}

export interface Ref {
  lsn: number;
  intent: string;
  agent: string;
  files: string[];
  /** For a reader: what its change wrote. */
  wrote?: string[];
}

export interface CallersAnswer {
  readers: Ref[];
  writers: Ref[];
  /** How callers are known (read sets, not a call graph). */
  note?: string;
}

/**
 * `leased`: another agent holds it. `not_held`: a release found no lease of yours. `invalid`: the
 * request cannot be served as asked (daemon/src/brain.ts).
 */
export interface LeaseAnswer {
  status: "held" | "leased" | "released" | "not_held" | "invalid";
  message: string;
  lease?: { symbol: string; expiresAt: string; holder: { developer: string; agent: string } };
}

export interface HistoryAnswer {
  symbol: string;
  history: { lsn: number; intent: string; intentId?: string; author: { developer: string; agent: string }; createdAt: string; signature: boolean; brainVersion: number; repairs: string[] }[];
  declaredBy: { id: string; text: string; author: { developer: string; agent: string } }[];
  lease?: { expiresAt: string; reason: string; holder: { developer: string; agent: string } };
}

/** A live presence entry as the daemon's `GET /presence` answers it: the protocol's entry plus its age. */
export type PresenceRow = PresenceEntry & { ageMs: number };

export interface PresenceAnswer {
  /** This worktree's replica, to tell it apart from the others. */
  replica: string | null;
  ttlMs: number;
  entries: PresenceRow[];
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

  callers(symbol: string): Promise<CallersAnswer> {
    return this.call("GET", `/callers?symbol=${encodeURIComponent(symbol)}`) as Promise<CallersAnswer>;
  }

  history(symbol: string): Promise<HistoryAnswer> {
    return this.call("GET", `/history?symbol=${encodeURIComponent(symbol)}`) as Promise<HistoryAnswer>;
  }

  brain(): Promise<{ version: number; lines: string[] }> {
    return this.call("GET", "/brain") as Promise<{ version: number; lines: string[] }>;
  }

  lease(symbol: string, opts: { reason?: string; ttlSeconds?: number; release?: boolean } = {}): Promise<LeaseAnswer> {
    return this.call("POST", "/lease", { symbol, ...opts }) as Promise<LeaseAnswer>;
  }

  /** Who is working in the repository right now (daemon/src/presence.ts, `PresenceView`). */
  presence(): Promise<PresenceAnswer> {
    return this.call("GET", "/presence") as Promise<PresenceAnswer>;
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
