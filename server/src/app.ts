import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Health, ServerMessage } from "@pitstop/protocol";

export interface AppDeps {
  /** Version string shown on /healthz. The deploy smoke test compares it with the git SHA. */
  version: string;
  /** Resolves true when the database answers. */
  pingDb: () => Promise<boolean>;
  /** Current head of the log. Phase 1 replaces this stub with the real log. */
  headLsn: () => Promise<number>;
  logger?: boolean;
}

/**
 * Builds the HTTP and WebSocket server without starting it,
 * so tests can call it with `app.inject()` and fake dependencies.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(websocket);

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

  // Phase 1 (server owner): POST /commit appends to the log.
  app.post("/commit", async (_req, reply) =>
    reply.code(501).send({ error: "not_implemented", phase: 1 }),
  );

  // Phase 1 (server owner): stream every entry after the client's `fromLsn`.
  // For now it only greets, so the daemon side can be built against a real socket.
  app.get("/stream", { websocket: true }, async (socket) => {
    const hello: ServerMessage = {
      type: "hello",
      serverVersion: deps.version,
      headLsn: await deps.headLsn(),
    };
    socket.send(JSON.stringify(hello));
  });

  return app;
}
