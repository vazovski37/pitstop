import { timingSafeEqual } from "node:crypto";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import {
  CommitRequest,
  DEFAULT_REPO,
  IntentRequest,
  Lsn,
  RepoId,
  type Changeset,
  type CommitResponse,
  type Health,
  type Repo,
  type ServerMessage,
} from "@pitstop/protocol";
import { typecheckGate } from "./checks.js";
import { escalation, repairCommit, type Repairer, type RepairMode } from "./repair.js";
import {
  gapStart,
  InvalidCommit,
  RejectedCommit,
  repoOf,
  SKIPPED_CHECKS,
  withBlobHashes,
  type Decision,
  type RejectReason,
  type Store,
} from "./store.js";
import { Stream } from "./stream.js";
import { decideCommit, describeSkew, type SkewVerdict, type ValidationMode } from "./validate.js";

export interface AppDeps {
  /** Version string shown on /healthz. The deploy smoke test compares it with the git SHA. */
  version: string;
  /** Resolves true when the database answers. */
  pingDb: () => Promise<boolean>;
  /** The log, blobs and intents: PgStore in production, MemoryStore in tests. */
  store: Store;
  /**
   * Shared secret every daemon sends (`PITSTOP_TOKEN`). When set, every route except the
   * health probes needs `Authorization: Bearer <token>`, or `?token=` where a browser
   * cannot set headers (the live view's `/stream`). Unset means open, for local work.
   */
  token?: string;
  /** What the validator does with write skew until AI repair exists: `warn` (default) records it, `enforce` refuses it, `off` skips validation. */
  validation?: ValidationMode;
  /** `always` runs the type-check gate on every commit (section 7.4); `off` (default) runs it only where repair asks for it. */
  check?: "off" | "always";
  /** Who resolves write skew (repair.ts): `agent`, `groq`, or `off` for the validator's own behaviour. */
  repair?: RepairMode;
  /** The model-backed repairer for `groq` mode; tests inject a fake. */
  repairer?: Repairer;
  logger?: boolean;
}

/** Routes that stay open when a token is set: the deploy smoke test and Azure's probes use them. */
const OPEN_ROUTES = new Set(["/healthz", "/version"]);

const sameToken = (presented: string, expected: string): boolean =>
  presented.length === expected.length && timingSafeEqual(Buffer.from(presented), Buffer.from(expected));

/** `GET /log` pages: the default and the most a client may ask for. */
const LOG_PAGE = 100;
const LOG_PAGE_MAX = 500;

/**
 * Builds the HTTP and WebSocket server without starting it,
 * so tests can call it with `app.inject()` and fake dependencies.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // A commit carries whole files, and an import carries a whole repository: well past Fastify's 1 MiB default.
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 32 * 1024 * 1024 });
  await app.register(websocket);
  const stream = new Stream(deps.store, deps.version, app.log);

  // Phase 2: the server is public on Azure, so one shared token guards the log and the stream.
  // The hook also runs on the /stream upgrade request, which is refused with the same 401.
  const token = deps.token;
  if (token !== undefined) {
    app.addHook("onRequest", async (req, reply) => {
      if (OPEN_ROUTES.has(req.routeOptions.url ?? "")) return;
      const header = req.headers.authorization;
      const presented = header?.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : (req.query as { token?: string } | undefined)?.token;
      if (presented !== undefined && sameToken(presented, token)) return;
      return reply.code(401).send({
        error: "unauthorized",
        message: "send Authorization: Bearer <PITSTOP_TOKEN> (or ?token=<PITSTOP_TOKEN> on /stream)",
      });
    });
  }

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

  // Validate, then append, both under the store's append lock (design doc section 6.2, steps 6 and 7).
  const mode = deps.validation ?? "warn";
  const check = deps.check ?? "off";
  const repair = deps.repair ?? "off";
  app.post("/commit", async (req, reply) => {
    const parsed = CommitRequest.safeParse(req.body);
    if (!parsed.success) return rejected(reply, "invalid_request", issues(parsed.error));
    try {
      const repo = repoOf(parsed.data);
      const request: CommitRequest = { ...withBlobHashes(parsed.data), repo };
      let skew: SkewVerdict | undefined;
      const changeset = await deps.store.append(request, async (gap, head): Promise<Decision> => {
        // With a resolver, the validator only reports skew; what happens to it is decided here.
        const outcome = decideCommit(request, gap, head, repair === "off" ? mode : "warn");
        let decision = outcome.decision;
        if (outcome.skew !== undefined && repair !== "off") {
          const input = {
            request,
            skew: outcome.skew,
            gap,
            headLsn: head,
            head: await deps.store.treeAt(repo, head),
            base: await deps.store.treeAt(repo, gapStart(request)),
          };
          // `agent`: the coding agent that committed is the resolver; it gets told what changed.
          if (repair === "agent" || deps.repairer === undefined) throw escalation(input);
          decision = await repairCommit(input, deps.repairer);
        } else {
          skew = outcome.skew;
        }
        if (check !== "always") return decision;
        // The constraint of section 7.4: the merged tree must type-check, or the commit does not land.
        const gate = await typecheckGate(await deps.store.treeAt(repo, head), decision.files ?? request.files);
        if (gate.typecheck === "fail") {
          throw new RejectedCommit("constraint_failed", `type check failed on the merged tree:\n${gate.details ?? ""}`);
        }
        const checks = decision.checks ?? SKIPPED_CHECKS;
        const details = [checks.details, gate.details].filter((d) => d !== undefined).join("; ");
        return { ...decision, checks: { ...checks, typecheck: gate.typecheck, ...(details === "" ? {} : { details }) } };
      });
      stream.notify(repo);
      if (skew) {
        // Without a resolver the skew lands as is; the daemon and the live view hear about it.
        stream.broadcast(repo, {
          type: "warning",
          repo: changeset.repo,
          agent: request.author.agent,
          kind: "dependency_changed",
          message: `#${changeset.lsn} landed with write skew, not repaired: ${describeSkew(skew)}`,
          symbols: skew.symbols.map((s) => s.symbolId),
        });
      }
      const body: CommitResponse = { status: "accepted", changeset };
      return reply.code(200).send(body);
    } catch (err) {
      if (err instanceof InvalidCommit) return rejected(reply, "invalid_request", err.message);
      if (err instanceof RejectedCommit) return rejected(reply, err.reason, err.message, err.conflictsWith);
      throw err;
    }
  });

  // Opens a transaction (section 6.2, step 1) and tells every worktree about it.
  app.post("/intents", async (req, reply) => {
    const parsed = IntentRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    try {
      const intent = await deps.store.openIntent(parsed.data);
      const message: ServerMessage = { type: "intent", intent };
      stream.broadcast(intent.repo, message);
      return reply.code(201).send(intent);
    } catch (err) {
      if (err instanceof InvalidCommit) return reply.code(400).send({ error: "invalid_request", message: err.message });
      throw err;
    }
  });

  // Repositories: one server, many logs (build plan, "Beyond the demo").
  app.post<{ Body: { id?: unknown } }>("/repos", async (req, reply) => {
    const id = RepoId.safeParse(req.body?.id);
    if (!id.success) return reply.code(400).send({ error: "invalid_request", message: "id must be owner/name in lowercase" });
    const { repo, created } = await deps.store.createRepo(id.data);
    return reply.code(created ? 201 : 200).send(repo);
  });

  app.get("/repos", async (): Promise<Repo[]> => deps.store.listRepos());

  app.get<{ Params: { owner: string; name: string } }>("/repos/:owner/:name", async (req, reply) => {
    const repo = await deps.store.getRepo(`${req.params.owner}/${req.params.name}`);
    if (repo === undefined) return reply.code(404).send({ error: "unknown_repo" });
    return repo;
  });

  // The log over HTTP: for the live view, catch-up by hand, and debugging.
  app.get<{ Querystring: { repo?: string; fromLsn?: string; limit?: string } }>("/log", async (req, reply) => {
    const repo = RepoId.safeParse(req.query.repo ?? DEFAULT_REPO);
    if (!repo.success) return reply.code(400).send({ error: "invalid_request", message: "repo must be owner/name in lowercase" });
    const fromLsn = Lsn.safeParse(Number(req.query.fromLsn ?? 0));
    if (!fromLsn.success) return reply.code(400).send({ error: "invalid_request", message: "fromLsn must be an LSN" });
    if ((await deps.store.getRepo(repo.data)) === undefined) return reply.code(404).send({ error: "unknown_repo" });
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || LOG_PAGE, 1), LOG_PAGE_MAX);
    const entries: Changeset[] = await deps.store.entriesAfter(repo.data, fromLsn.data, limit);
    return entries;
  });

  // hello, then replay after the daemon's fromLsn, then live (section 8.2). See stream.ts.
  app.get("/stream", { websocket: true }, (socket) => {
    stream.connect(socket);
  });

  return app;
}

/** 400 when the request itself is wrong; 409 when it is fine but cannot land on the current log. */
const rejected = (reply: FastifyReply, reason: RejectReason, message: string, conflictsWith: Lsn[] = []) => {
  const body: CommitResponse = { status: "rejected", reason, message, conflictsWith };
  return reply.code(reason === "invalid_request" ? 400 : 409).send(body);
};

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
