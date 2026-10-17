import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  CommitRequest,
  IntentRequest,
  Lsn,
  type Changeset,
  type CommitResponse,
  type Health,
  type ServerMessage,
} from "@pitstop/protocol";
import { InvalidCommit, withBlobHashes, type Store } from "./store.js";
import { Stream } from "./stream.js";

export interface AppDeps {
  /** Version string shown on /healthz. The deploy smoke test compares it with the git SHA. */
  version: string;
  /** Resolves true when the database answers. */
  pingDb: () => Promise<boolean>;
  /** The log, blobs and intents: PgStore in production, MemoryStore in tests. */
  store: Store;
  logger?: boolean;
}

/** `GET /log` pages: the default and the most a client may ask for. */
const LOG_PAGE = 100;
const LOG_PAGE_MAX = 500;

/**
 * Builds the HTTP and WebSocket server without starting it,
 * so tests can call it with `app.inject()` and fake dependencies.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(websocket);
  const stream = new Stream(deps.store, deps.version, app.log);

  // The deploy smoke test (infra/smoke.sh) polls this until it reports the new version with db: true.
  app.get("/healthz", async (_req, reply) => {
    let db = false;
    try {
      db = await deps.pingDb();
    } catch {
      db = false;
    }
    const body: Health = { ok: db, version: deps.version, db };
    return reply.code(db ? 200 : 503).send(body);
  });

  app.get("/version", async () => ({ version: deps.version }));

  // Phase 1 fast path: no validation yet, every well-formed commit is appended (design doc section 6.2, step 7).
  app.post("/commit", async (req, reply) => {
    const parsed = CommitRequest.safeParse(req.body);
    if (!parsed.success) return rejected(reply, issues(parsed.error));
    try {
      const changeset = await deps.store.append(withBlobHashes(parsed.data));
      stream.notify();
      const body: CommitResponse = { status: "accepted", changeset };
      return reply.code(200).send(body);
    } catch (err) {
      if (err instanceof InvalidCommit) return rejected(reply, err.message);
      throw err;
    }
  });

  // Opens a transaction (section 6.2, step 1) and tells every worktree about it.
  app.post("/intents", async (req, reply) => {
    const parsed = IntentRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    const intent = await deps.store.openIntent(parsed.data);
    const message: ServerMessage = { type: "intent", intent };
    stream.broadcast(message);
    return reply.code(201).send(intent);
  });

  // The log over HTTP: for the live view, catch-up by hand, and debugging.
  app.get<{ Querystring: { fromLsn?: string; limit?: string } }>("/log", async (req, reply) => {
    const fromLsn = Lsn.safeParse(Number(req.query.fromLsn ?? 0));
    if (!fromLsn.success) return reply.code(400).send({ error: "invalid_request", message: "fromLsn must be an LSN" });
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || LOG_PAGE, 1), LOG_PAGE_MAX);
    const entries: Changeset[] = await deps.store.entriesAfter(fromLsn.data, limit);
    return entries;
  });

  // hello, then replay after the daemon's fromLsn, then live (section 8.2). See stream.ts.
  app.get("/stream", { websocket: true }, (socket) => {
    stream.connect(socket);
  });

  return app;
}

const rejected = (reply: FastifyReply, message: string) => {
  const body: CommitResponse = { status: "rejected", reason: "invalid_request", message, conflictsWith: [] };
  return reply.code(400).send(body);
};

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
