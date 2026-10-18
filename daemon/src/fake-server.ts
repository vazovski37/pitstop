#!/usr/bin/env node
/**
 * A stand-in for the real server, for tests and laptops without it: replays
 * packages/protocol/fixtures/server-messages.json over /stream and accepts POST /commit.
 *
 * Behaviour copied from server/src/stream.ts: `hello` on connect, then after `subscribe` a
 * `head` for the repository, every entry above `fromLsn` in order, then entries appended by
 * commits as they happen. One repository only (`DEFAULT_REPO` unless the request names one).
 * Presence is relayed as the server does it: merged with the protocol's `applyPresence`, passed
 * on to every subscriber when it changed the document, and the whole document after `head`
 * (no tombstone for a socket that closes: the daemon writes its own).
 *
 * The brain and the query API (server/src/brain.ts) in miniature: `GET /repos/:o/:n/brain` from
 * `setBrain`, leases with one holder per symbol, a symbol's history and callers, and why a path
 * is so, all from the entries it holds. `broadcast` pushes a `brain` or `lease` message.
 *
 * Accounts in miniature (server/src/auth.ts): `users` are personal tokens; `GET /me` answers their
 * login, and the server writes that login as the developer on commits, intents and leases,
 * whatever the request says. The shared `token` is the administrator, whose requests name the
 * developer themselves.
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  applyPresence,
  ClientMessage,
  CommitRequest,
  DEFAULT_REPO,
  IntentRequest,
  ServerMessage,
  RepoId,
  type Adr,
  type Changeset,
  type CommitResponse,
  type Intent,
  type PresenceDoc,
  type PresenceEntry,
  type Lease,
  type Repo,
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
  /** Repositories that exist from the start (the default one always does). */
  repos?: string[];
  /** Personal tokens and their owners' logins: accepted like `token`, and their login is the developer. */
  users?: Record<string, string>;
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
  /** Every repository created through `POST /repos`, in order (one log serves them all here). */
  repos: Repo[];
  /** Appends an entry as if another worktree had committed it, and pushes it to subscribers. */
  append(changeset: Changeset): void;
  /** Makes the next `POST /commit` answer `rejected` with this, like the validator or repair would. */
  rejectNextCommit(rejection: Rejection): void;
  /** The presence document merged from every `presence` message so far. */
  presence(): PresenceDoc;
  /** Merges a presence entry as if another worktree had sent it, and passes it on when it changed the document. */
  putPresence(entry: PresenceEntry): void;
  /** What `GET /repos/:o/:n/brain` answers: the brain version and the ADRs. */
  setBrain(brain: { version: number; adrs: Adr[] }): void;
  /** Live leases, by symbol: taken through `POST /repos/:o/:n/leases`, or put here by a test. */
  leases: Map<string, Lease>;
  /** Pushes a message to every subscriber, as the server does with `brain` and `lease`. */
  broadcast(message: ServerMessage): void;
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
  const startedAt = new Date().toISOString();
  const repos: Repo[] = (opts.repos ?? []).map((id) => ({ id, headLsn: 0, createdAt: startedAt }));
  const subscribers = new Map<WebSocket, { lastSentLsn: number | null }>();
  let dropped = false;
  let rejectNext: Rejection | undefined;
  let brain: { version: number; adrs: Adr[] } = { version: 0, adrs: [] };
  const leases = new Map<string, Lease>();

  const users = new Map(Object.entries(opts.users ?? {}));
  const tokenOf = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
    return new URL(req.url ?? "/", "http://fake").searchParams.get("token") ?? undefined;
  };
  /** The login behind a personal token; undefined for the shared token or none. */
  const loginOf = (req: IncomingMessage): string | undefined => {
    const token = tokenOf(req);
    return token === undefined ? undefined : users.get(token);
  };
  const authorized = (req: IncomingMessage): boolean => {
    if (opts.token === undefined && users.size === 0) return true;
    const token = tokenOf(req);
    return token !== undefined && (token === opts.token || users.has(token));
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
  const broadcast = (message: ServerMessage) => {
    for (const socket of subscribers.keys()) sendTo(socket, message);
  };
  /** An entry as the query API answers it. */
  const entryView = (e: Changeset) => ({
    lsn: e.lsn,
    intent: e.intent,
    author: e.author,
    createdAt: e.createdAt,
    brainVersion: e.brainVersion,
    files: e.files.map((f) => ({ path: f.path, op: f.op })),
    repairs: e.repairs.map((r) => r.summary),
  });
  const newestFirst = (list: Changeset[]) => [...list].sort((a, b) => b.lsn - a.lsn);

  /** The brain and the query API; undefined when the request is not one of theirs. */
  const brainRoute = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://fake");
    const m = /^\/repos\/([^/]+)\/([^/]+)\/(brain|leases|why|history|callers|symbols\/([^/]+)\/(history|callers))$/.exec(url.pathname);
    if (m === null) return false;
    const repo = `${m[1]}/${m[2]}`;
    const what = m[3] as string;
    if (what === "brain" && req.method === "GET") {
      json(res, 200, { repo, version: brain.version, adrs: brain.adrs, leases: [...leases.values()], intents: intents.filter((i) => i.status === "open") });
      return true;
    }
    if (what === "leases" && req.method === "GET") {
      json(res, 200, [...leases.values()]);
      return true;
    }
    if (what === "leases" && req.method === "POST") {
      const body = (await readJson(req)) as { symbol: string; agent: string; developer?: string; reason?: string; ttlSeconds?: number; intentId?: string };
      const held = leases.get(body.symbol);
      const holder = { developer: loginOf(req) ?? body.developer ?? "fake", agent: body.agent };
      // As the server: a lease tied to an intent is held by that intent.
      const holds = (l: Lease) => l.holder.agent === holder.agent && l.holder.developer === holder.developer && (l.intentId === undefined || l.intentId === body.intentId);
      if (held !== undefined && !holds(held)) {
        json(res, 409, { error: "leased", message: `${body.symbol} is leased to ${held.holder.agent} (${held.holder.developer}) until ${held.expiresAt}${held.reason ? `: ${held.reason}` : ""}`, lease: held });
        return true;
      }
      const lease: Lease = {
        repo,
        symbol: body.symbol,
        holder,
        ...(body.intentId === undefined ? {} : { intentId: body.intentId }),
        reason: body.reason ?? "",
        status: "held",
        expiresAt: new Date(Date.now() + (body.ttlSeconds ?? 300) * 1000).toISOString(),
        createdAt: held?.createdAt ?? new Date().toISOString(),
      };
      leases.set(body.symbol, lease);
      broadcast({ type: "lease", lease });
      json(res, held === undefined ? 201 : 200, { lease, renewed: held !== undefined });
      return true;
    }
    if (what === "leases" && req.method === "DELETE") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const held = leases.get(symbol);
      if (held === undefined) {
        json(res, 404, { error: "not_found", message: `nobody holds a lease on ${symbol}` });
        return true;
      }
      const agent = url.searchParams.get("agent");
      const developer = loginOf(req) ?? url.searchParams.get("developer");
      if (agent !== null && (agent !== held.holder.agent || developer !== held.holder.developer)) {
        json(res, 403, { error: "forbidden", message: `${symbol} is held by ${held.holder.agent} (${held.holder.developer}); only its holder or an owner releases it` });
        return true;
      }
      leases.delete(symbol);
      const released: Lease = { ...held, status: "released" };
      broadcast({ type: "lease", lease: released });
      json(res, 200, released);
      return true;
    }
    if (what === "why" && req.method === "GET") {
      const path = url.searchParams.get("path") ?? "";
      const touched = newestFirst(entries.filter((e) => e.files.some((f) => f.path === path || f.fromPath === path)));
      json(res, 200, { path, entries: touched.map((e) => ({ ...entryView(e), op: e.files.find((f) => f.path === path || f.fromPath === path)?.op ?? "modify" })) });
      return true;
    }
    // A symbol's history or callers: in the path, or (as the daemon asks) in `?symbol=`.
    const symbolQuery = what === "history" || what === "callers";
    if (req.method === "GET" && (m[4] !== undefined || symbolQuery)) {
      const symbol = m[4] !== undefined ? decodeURIComponent(m[4]) : (url.searchParams.get("symbol") ?? "");
      if (!symbol.includes("#")) {
        json(res, 400, { error: "invalid_request", message: "expected ?symbol=path#name" });
        return true;
      }
      if ((m[5] ?? what) === "history") {
        const wrote = newestFirst(entries.filter((e) => e.writeSet.includes(symbol) || e.sigWriteSet.includes(symbol)));
        const lease = leases.get(symbol);
        json(res, 200, {
          symbol,
          history: wrote.map((e) => ({ ...entryView(e), signature: e.sigWriteSet.includes(symbol) })),
          declaredBy: intents.filter((i) => i.status === "open" && i.declaredSymbols.includes(symbol)).map((i) => ({ id: i.id, text: i.text, author: i.author })),
          ...(lease === undefined ? {} : { lease }),
        });
      } else {
        const read = newestFirst(entries.filter((e) => e.readSet.includes(symbol)));
        json(res, 200, {
          symbol,
          derivedFrom: "the read sets of landed entries (what each change referred to), not a parsed call graph",
          callers: read.map((e) => ({ ...entryView(e), wrote: [...new Set([...e.writeSet, ...e.sigWriteSet])] })),
        });
      }
      return true;
    }
    return false;
  };

  let presence: PresenceDoc = {};
  const putPresence = (entry: PresenceEntry) => {
    const before = presence;
    presence = applyPresence(presence, entry);
    if (presence === before) return;
    for (const [socket, sub] of subscribers) {
      if (sub.lastSentLsn !== null) sendTo(socket, { type: "presence", repo: entry.repo, entries: [entry] });
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    if (await brainRoute(req, res)) return;
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
      const login = loginOf(req);
      const r = login === undefined ? parsed.data : { ...parsed.data, author: { ...parsed.data.author, developer: login } };
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
        brainVersion: brain.version,
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
        author: { ...parsed.data.author, developer: loginOf(req) ?? parsed.data.author.developer },
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
    if (req.method === "POST" && req.url === "/repos") {
      const id = RepoId.safeParse((await readJson(req) as { id?: unknown } | undefined)?.id);
      if (!id.success) return json(res, 400, { error: "invalid_request", message: "expected owner/name in lowercase" });
      const existing = repos.find((r) => r.id === id.data);
      if (existing) return json(res, 200, { ...existing, headLsn: headLsn() });
      const repo: Repo = { id: id.data, headLsn: headLsn(), createdAt: new Date().toISOString() };
      repos.push(repo);
      return json(res, 201, repo);
    }
    if (req.method === "GET" && req.url?.startsWith("/repos/")) {
      const id = decodeURIComponent(req.url.slice("/repos/".length));
      const known = repos.find((r) => r.id === id) ?? (id === DEFAULT_REPO ? { id, headLsn: 0, createdAt: startedAt } : undefined);
      if (!known) return json(res, 404, { error: "not_found", message: `unknown repo ${id}` });
      return json(res, 200, { ...known, headLsn: headLsn() });
    }
    if (req.method === "GET" && req.url?.startsWith("/log")) {
      const query = new URL(req.url, "http://fake").searchParams;
      const fromLsn = Number(query.get("fromLsn") ?? 0);
      const limit = Number(query.get("limit") ?? 100);
      return json(res, 200, entries.filter((e) => e.lsn > fromLsn).slice(0, limit));
    }
    if (req.method === "GET" && req.url === "/me") {
      const login = loginOf(req);
      if (login === undefined) return json(res, 401, { error: "unauthorized", message: "sign in at /auth/github or send a personal token" });
      return json(res, 200, { id: `u_${login}`, githubId: 1, login, createdAt: startedAt });
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
        const repo = parsed.data.repo ?? DEFAULT_REPO;
        sendTo(socket, { type: "head", repo, headLsn: headLsn() });
        const present = Object.values(presence);
        if (present.length > 0) sendTo(socket, { type: "presence", repo, entries: present });
        deliver(socket);
      }
      if (parsed.data.type === "presence" && subscribers.get(socket)?.lastSentLsn !== null) putPresence(parsed.data.entry);
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
    repos,
    append,
    rejectNextCommit: (rejection) => {
      rejectNext = rejection;
    },
    presence: () => presence,
    putPresence,
    setBrain: (next) => {
      brain = next;
    },
    leases,
    broadcast,
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
  // PITSTOP_FAKE_LOG=empty starts with no entries, so an import becomes #1 (as on a new server).
  const empty = process.env.PITSTOP_FAKE_LOG === "empty";
  startFakeServer({
    port,
    ...(token ? { token } : {}),
    ...(empty ? { messages: [{ type: "hello", serverVersion: "fake", headLsn: 0 }] } : {}),
  })
    .then((s) => console.log(`fake pitstop server on ${s.url} (stream: ${s.streamUrl}), head #${s.headLsn()}`))
    .catch((err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    });
}
