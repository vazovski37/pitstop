#!/usr/bin/env node
/**
 * A stand-in for the real server, for tests and laptops without it: replays
 * packages/protocol/fixtures/server-messages.json over /stream and accepts POST /commit.
 *
 * Behaviour copied from server/src/stream.ts: `hello` on connect, then after `subscribe` a
 * `head` for the repository, every entry above `fromLsn` in order, then entries appended by
 * commits as they happen. One repository only (`DEFAULT_REPO` unless the request names one).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientMessage,
  CommitRequest,
  DEFAULT_REPO,
  IntentRequest,
  ServerMessage,
  type Changeset,
  type CommitResponse,
  type Intent,
} from "@pitstop/protocol";

/** A scripted answer for the next `POST /commit`. */
export interface Rejection {
  reason: "constraint_failed" | "repair_failed" | "escalated" | "invalid_request";
  message: string;
  conflictsWith?: number[];
}

export interface FakeServerOptions {
  /** Defaults to the shared fixture. */
  messages?: ServerMessage[];
  /** 0 picks a free port. */
  port?: number;
  /** Withhold this LSN the first time it would be sent, so the daemon sees a gap. */
  dropOnce?: number;
  /** When set, requests without `Authorization: Bearer <token>` (or `?token=`) are refused. */
  token?: string;
}

export interface FakeServer {
  url: string;
  streamUrl: string;
  headLsn(): number;
  /** Every client message received, in order. */
  received: ClientMessage[];
  /** Every commit request accepted, in order. */
  commits: CommitRequest[];
  /** Every intent opened through `POST /intents`, in order. */
  intents: Intent[];
  /** Appends an entry as if another worktree had committed it, and pushes it to subscribers. */
  append(changeset: Changeset): void;
  /** Makes the next `POST /commit` answer `rejected` with this, like the validator or repair would. */
  rejectNextCommit(rejection: Rejection): void;
  close(): Promise<void>;
}

export const FIXTURE = new URL("../../packages/protocol/fixtures/server-messages.json", import.meta.url);

export const loadFixture = (): ServerMessage[] =>
  (JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown[]).map((m) => ServerMessage.parse(m));

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const messages = opts.messages ?? loadFixture();
  const entries = messages
    .flatMap((m) => (m.type === "entry" ? [m.changeset] : []))
    .sort((a, b) => a.lsn - b.lsn);
  const extras = messages.filter((m) => m.type === "intent" || m.type === "warning");
  const serverVersion = messages.find((m) => m.type === "hello")?.serverVersion ?? "fake";
  const headLsn = () => entries.at(-1)?.lsn ?? 0;
  const received: ClientMessage[] = [];
  const commits: CommitRequest[] = [];
  const intents: Intent[] = [];
  const subscribers = new Map<WebSocket, { lastSentLsn: number | null }>();
  let dropped = false;
  let rejectNext: Rejection | undefined;

  const authorized = (req: IncomingMessage): boolean => {
    if (opts.token === undefined) return true;
    const header = req.headers.authorization;
    const query = new URL(req.url ?? "/", "http://fake").searchParams.get("token");
    return header === `Bearer ${opts.token}` || query === opts.token;
  };

  const sendTo = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  };

  const deliver = (socket: WebSocket) => {
    const sub = subscribers.get(socket);
    if (!sub || sub.lastSentLsn === null) return;
    for (const changeset of entries) {
      if (changeset.lsn <= sub.lastSentLsn) continue;
      if (opts.dropOnce === changeset.lsn && !dropped) {
        dropped = true;
        continue;
      }
      sendTo(socket, { type: "entry", changeset });
      sub.lastSentLsn = changeset.lsn;
    }
  };

  const append = (changeset: Changeset) => {
    entries.push(changeset);
    for (const socket of subscribers.keys()) deliver(socket);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "POST" && req.url === "/commit") {
      const parsed = CommitRequest.safeParse(await readJson(req));
      if (!parsed.success) {
        const body: CommitResponse = {
          status: "rejected",
          reason: "invalid_request",
          message: parsed.error.message,
          conflictsWith: [],
        };
        return json(res, 400, body);
      }
      const r = parsed.data;
      if (rejectNext !== undefined) {
        const body: CommitResponse = { status: "rejected", conflictsWith: [], ...rejectNext };
        rejectNext = undefined;
        return json(res, 409, body);
      }
      commits.push(r);
      const changeset: Changeset = {
        repo: r.repo ?? DEFAULT_REPO,
        lsn: headLsn() + 1,
        baseLsn: r.baseLsn,
        author: r.author,
        intent: r.intent,
        files: r.files,
        writeSet: r.writeSet,
        sigWriteSet: r.sigWriteSet,
        readSet: r.readSet,
        repairs: [],
        checks: { typecheck: "skipped", tests: "skipped", adr: "skipped" },
        brainVersion: 0,
        createdAt: new Date().toISOString(),
      };
      append(changeset);
      const body: CommitResponse = { status: "accepted", changeset };
      return json(res, 200, body);
    }
    if (req.method === "POST" && req.url === "/intents") {
      const parsed = IntentRequest.safeParse(await readJson(req));
      if (!parsed.success) return json(res, 400, { error: "invalid_request", message: parsed.error.message });
      const intent: Intent = {
        id: `int_${(intents.length + 1).toString().padStart(2, "0")}`,
        repo: parsed.data.repo ?? DEFAULT_REPO,
        author: parsed.data.author,
        baseLsn: parsed.data.baseLsn,
        text: parsed.data.text,
        declaredSymbols: parsed.data.declaredSymbols,
        status: "open",
        heartbeatAt: new Date().toISOString(),
      };
      intents.push(intent);
      for (const socket of subscribers.keys()) sendTo(socket, { type: "intent", intent });
      return json(res, 201, intent);
    }
    if (req.method === "GET" && req.url?.startsWith("/log")) {
      const query = new URL(req.url, "http://fake").searchParams;
      const fromLsn = Number(query.get("fromLsn") ?? 0);
      const limit = Number(query.get("limit") ?? 100);
      return json(res, 200, entries.filter((e) => e.lsn > fromLsn).slice(0, limit));
    }
    if (req.method === "GET" && req.url === "/healthz") {
      return json(res, 200, { ok: true, version: serverVersion, db: true });
    }
    return json(res, 404, { error: "not_found" });
  };
  const http: Server = createServer((req, res) => void handle(req, res));

  const wss = new WebSocketServer({
    server: http,
    path: "/stream",
    verifyClient: (info: { req: IncomingMessage }) => authorized(info.req),
  });
  wss.on("connection", (socket) => {
    subscribers.set(socket, { lastSentLsn: null });
    socket.on("close", () => subscribers.delete(socket));
    sendTo(socket, { type: "hello", serverVersion, headLsn: headLsn() });
    for (const m of extras) sendTo(socket, m);
    socket.on("message", (raw) => {
      const parsed = ClientMessage.safeParse(tryJson(raw.toString()));
      if (!parsed.success) return socket.close(1003, "expected a ClientMessage");
      received.push(parsed.data);
      if (parsed.data.type === "subscribe") {
        subscribers.set(socket, { lastSentLsn: parsed.data.fromLsn });
        sendTo(socket, { type: "head", repo: parsed.data.repo ?? DEFAULT_REPO, headLsn: headLsn() });
        deliver(socket);
      }
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    streamUrl: `ws://127.0.0.1:${port}/stream`,
    headLsn,
    received,
    commits,
    intents,
    append,
    rejectNextCommit: (rejection) => {
      rejectNext = rejection;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of subscribers.keys()) socket.terminate();
        wss.close();
        http.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJson = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(tryJson(Buffer.concat(chunks).toString("utf8"))));
  });

const tryJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isMain = process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.PITSTOP_FAKE_PORT ?? 8081);
  const token = process.env.PITSTOP_TOKEN?.trim();
  startFakeServer({ port, ...(token ? { token } : {}) })
    .then((s) => console.log(`fake pitstop server on ${s.url} (stream: ${s.streamUrl}), head #${s.headLsn()}`))
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
}
