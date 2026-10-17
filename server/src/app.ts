import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
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
import { z } from "zod";
import {
  accountsEnabled,
  allowed,
  identify,
  isAdmin,
  newState,
  presentedToken,
  sameOrigin,
  sessionValue,
  SESSION_COOKIE,
  SESSION_SECONDS,
  STATE_COOKIE,
  type AuthConfig,
  type OAuthProvider,
} from "./auth.js";
import { typecheckGate } from "./checks.js";
import type { GitHubClient } from "./github.js";
import { MirrorWorker } from "./mirror.js";
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
  type Role,
  type Store,
  type User,
} from "./store.js";
import { Stream, type Worktree } from "./stream.js";
import { decideCommit, describeSkew, overlapWarnings, type SkewVerdict, type ValidationMode } from "./validate.js";

export interface AppDeps {
  /** Version string shown on /healthz. The deploy smoke test compares it with the git SHA. */
  version: string;
  /** Resolves true when the database answers. */
  pingDb: () => Promise<boolean>;
  /** The log, blobs, intents, mirrors and accounts: PgStore in production, MemoryStore in tests. */
  store: Store;
  /**
   * The shared secret (`PITSTOP_TOKEN`): the self-host super-user, and the transition before
   * personal tokens. Without accounts it guards every route except the health probes.
   */
  token?: string;
  /** Sign in with GitHub (auth.ts); with `sessionSecret` it turns accounts on. Tests inject a fake. */
  oauth?: OAuthProvider;
  sessionSecret?: string;
  /** Where the browser goes after signing in. */
  webUrl?: string;
  /** `https://host` of this server, for the OAuth redirect; derived from the request when absent. */
  publicUrl?: string;
  /** The live view's built files (web/dist), served at `/`; absent means no page. */
  webDir?: string;
  secureCookies?: boolean;
  /** What the validator does with write skew until AI repair exists: `warn` (default) records it, `enforce` refuses it, `off` skips validation. */
  validation?: ValidationMode;
  /** `always` runs the type-check gate on every commit (section 7.4); `off` (default) runs it only where repair asks for it. */
  check?: "off" | "always";
  /** Who resolves write skew (repair.ts): `agent`, `groq`, or `off` for the validator's own behaviour. */
  repair?: RepairMode;
  /** The model-backed repairer for `groq` mode; tests inject a fake. */
  repairer?: Repairer;
  /** GitHub, for the git mirror (mirror.ts). Absent: the mirror routes answer 501. Tests inject a fake. */
  github?: GitHubClient;
  /** How often failed mirrors are retried; tests shorten it. */
  mirrorRetryMs?: number;
  logger?: boolean;
}

/** Routes that stay open whatever the auth setup: the probes, and the way in. */
// `/*` is the live view's static files: the page asks for a token or a sign-in itself.
const OPEN_ROUTES = new Set(["/healthz", "/version", "/auth/github", "/auth/github/callback", "/*"]);

/** `GET /log` pages: the default and the most a client may ask for. */
const LOG_PAGE = 100;
const LOG_PAGE_MAX = 500;

const MirrorBody = z.object({
  /** `owner/name` on github.com. */
  github: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
  branch: z.string().min(1).default("main"),
  /** The commit the first entry builds on; defaults to the branch's head on GitHub. */
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/, "expected a commit sha").optional(),
});
const TokenBody = z.object({ name: z.string().min(1).max(80) });
const MemberBody = z.object({ role: z.enum(["owner", "writer", "reader"]), resolver: z.boolean().optional() });
/** A GitHub login: letters, digits and single hyphens, up to 39 characters. */
const GitHubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "not a GitHub login");
const RepoPatch = z.object({ visibility: z.enum(["private", "public"]) });

type RepoParams = { Params: { owner: string; name: string } };

/**
 * Answer of `GET /repos/:owner/:name/worktrees`: each connected worktree's applied LSN against the
 * head, for the live view. `agent` comes from the open intent the worktree last heartbeated, so a
 * worktree between tasks has no name. A server query, not a protocol message: the shape lives here.
 */
export interface WorktreesResponse {
  headLsn: number;
  worktrees: (Worktree & { agent?: string })[];
}

/**
 * Builds the HTTP and WebSocket server without starting it,
 * so tests can call it with `app.inject()` and fake dependencies.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // A commit carries whole files, and an import carries a whole repository: well past Fastify's 1 MiB default.
  // Request logs keep the path, never the query string: `/stream?token=` would otherwise put
  // tokens into the logs (on Azure, Log Analytics).
  const logger = deps.logger
    ? {
        serializers: {
          req: (req: { method: string; url: string; hostname?: string; ip?: string }) => ({
            method: req.method,
            url: req.url.split("?")[0],
            hostname: req.hostname,
            remoteAddress: req.ip,
          }),
        },
      }
    : false;
  const app = Fastify({ logger, bodyLimit: 32 * 1024 * 1024 });
  await app.register(websocket);
  await app.register(cookie, deps.sessionSecret === undefined ? {} : { secret: deps.sessionSecret });
  const stream = new Stream(deps.store, deps.version, app.log);

  const auth: AuthConfig = {
    ...(deps.token === undefined ? {} : { sharedToken: deps.token }),
    ...(deps.oauth === undefined ? {} : { oauth: deps.oauth }),
    ...(deps.sessionSecret === undefined ? {} : { sessionSecret: deps.sessionSecret }),
    ...(deps.webUrl === undefined ? {} : { webUrl: deps.webUrl }),
    ...(deps.publicUrl === undefined ? {} : { publicUrl: deps.publicUrl }),
    secureCookies: deps.secureCookies ?? false,
  };
  const accounts = accountsEnabled(auth);

  // The git mirror: pushes every accepted entry to GitHub when a client is configured (MIRROR_GITHUB_TOKEN).
  const mirrors = deps.github === undefined ? undefined : new MirrorWorker(deps.store, deps.github, app.log, deps.mirrorRetryMs);
  app.decorate("mirrors", mirrors);
  if (mirrors !== undefined) {
    app.addHook("onReady", async () => mirrors.start());
    app.addHook("onClose", async () => mirrors.stop());
  }

  // Who is calling (auth.ts): set on every request, the /stream upgrade included, before any handler runs.
  app.addHook("onRequest", async (req, reply) => {
    if (OPEN_ROUTES.has(req.routeOptions.url ?? "")) {
      req.identity = { kind: "anonymous" };
      return;
    }
    const identity = await identify(req, deps.store, auth);
    if (identity === "bad-token") return reply.code(401).send({ error: "unauthorized", message: "the token presented is not valid" });
    req.identity = identity;
    // Without accounts, the shared token guards everything but the probes (Phase 2 behaviour).
    if (identity.kind === "anonymous" && auth.sharedToken !== undefined && !accounts) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "send Authorization: Bearer <PITSTOP_TOKEN> (or ?token=<PITSTOP_TOKEN> on /stream)",
      });
    }
  });

  /** Answers 401 or 403 and returns false when the caller may not act at `role` on the repository. */
  const guard = async (req: FastifyRequest, reply: FastifyReply, repo: string, role: Role): Promise<boolean> => {
    if (await allowed(req.identity, repo, role, deps.store, auth)) return true;
    const code = req.identity.kind === "anonymous" ? 401 : 403;
    await reply.code(code).send({ error: code === 401 ? "unauthorized" : "forbidden", message: `${role} access to ${repo} is needed` });
    return false;
  };
  const currentUser = (req: FastifyRequest): User | undefined => (req.identity.kind === "user" ? req.identity.user : undefined);
  /** Answers 401 or 403 and returns false unless the caller is the server's administrator. */
  const adminOnly = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (isAdmin(req.identity, auth)) return true;
    const code = req.identity.kind === "anonymous" ? 401 : 403;
    void reply.code(code).send({ error: code === 401 ? "unauthorized" : "forbidden", message: "only the server's administrator may do this" });
    return false;
  };
  /** Whether `userId` is the repository's only owner, so taking their ownership away would orphan it. */
  const lastOwner = async (repo: string, userId: string): Promise<boolean> => {
    const owners = (await deps.store.listMembers(repo)).filter((m) => m.role === "owner");
    return owners.length === 1 && owners[0]?.userId === userId;
  };
  const repoParam = (req: FastifyRequest<RepoParams>): string => `${req.params.owner}/${req.params.name}`;
  const redirectUri = (req: FastifyRequest): string => {
    const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
    return `${auth.publicUrl ?? `${proto}://${req.headers.host ?? "localhost"}`}/auth/github/callback`;
  };
  const cookieBase = { httpOnly: true, sameSite: "lax" as const, secure: auth.secureCookies ?? false };

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

  // `accounts` tells the web page whether to offer sign in with GitHub.
  app.get("/version", async () => ({ version: deps.version, accounts }));

  // Sign in with GitHub (auth.ts): the OAuth web flow, then a signed session cookie.
  app.get("/auth/github", async (req, reply) => {
    if (!accounts || auth.oauth === undefined) {
      return reply.code(501).send({ error: "no_accounts", message: "set GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET and SESSION_SECRET" });
    }
    const state = newState();
    reply.setCookie(STATE_COOKIE, state, { ...cookieBase, signed: true, path: "/auth/github", maxAge: 600 });
    return reply.redirect(auth.oauth.authorizeUrl(state, redirectUri(req)));
  });

  app.get<{ Querystring: { code?: string; state?: string } }>("/auth/github/callback", async (req, reply) => {
    if (!accounts || auth.oauth === undefined) return reply.code(501).send({ error: "no_accounts" });
    const raw = req.cookies[STATE_COOKIE];
    const unsigned = raw === undefined ? undefined : req.unsignCookie(raw);
    if (!req.query.code || !req.query.state || unsigned?.valid !== true || unsigned.value !== req.query.state) {
      return reply.code(400).send({ error: "invalid_request", message: "the sign-in did not start here; begin again at /auth/github" });
    }
    const profile = await auth.oauth.exchange(req.query.code, redirectUri(req));
    const user = await deps.store.upsertUser(profile);
    // Invited before they had an account: they join those repositories now.
    await deps.store.acceptInvites(user);
    reply.clearCookie(STATE_COOKIE, { path: "/auth/github" });
    reply.setCookie(SESSION_COOKIE, sessionValue(user), { ...cookieBase, signed: true, path: "/", maxAge: SESSION_SECONDS });
    return reply.redirect(auth.webUrl ?? "/");
  });

  app.post("/auth/logout", async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/me", async (req, reply) => {
    const user = currentUser(req);
    if (user === undefined) return reply.code(401).send({ error: "unauthorized", message: "sign in at /auth/github or send a personal token" });
    return user;
  });

  // Personal tokens: what a daemon's .env holds. The secret is shown once.
  app.post("/tokens", async (req, reply) => {
    const user = currentUser(req);
    if (user === undefined) return reply.code(401).send({ error: "unauthorized", message: "sign in first" });
    const parsed = TokenBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    const { token, secret } = await deps.store.createToken(user.id, parsed.data.name);
    return reply.code(201).send({ ...token, secret });
  });

  app.get("/tokens", async (req, reply) => {
    const user = currentUser(req);
    if (user === undefined) return reply.code(401).send({ error: "unauthorized" });
    return deps.store.listTokens(user.id);
  });

  app.delete<{ Params: { id: string } }>("/tokens/:id", async (req, reply) => {
    const user = currentUser(req);
    if (user === undefined) return reply.code(401).send({ error: "unauthorized" });
    const revoked = await deps.store.revokeToken(user.id, req.params.id);
    return reply.code(revoked ? 204 : 404).send();
  });

  // Validate, then append, both under the store's append lock (design doc section 6.2, steps 6 and 7).
  const mode = deps.validation ?? "warn";
  const check = deps.check ?? "off";
  const repair = deps.repair ?? "off";
  app.post("/commit", async (req, reply) => {
    const parsed = CommitRequest.safeParse(req.body);
    if (!parsed.success) return rejected(reply, "invalid_request", issues(parsed.error));
    const repo = repoOf(parsed.data);
    if (!(await guard(req, reply, repo, "writer"))) return reply;
    try {
      // A personal token names the developer; the daemon's own word is kept only for the shared token.
      const user = currentUser(req);
      const author = user === undefined ? parsed.data.author : { ...parsed.data.author, developer: user.login };
      const request: CommitRequest = { ...withBlobHashes(parsed.data), repo, author };
      let skew: SkewVerdict | undefined;
      const changeset = await deps.store.append(request, async (gap, head): Promise<Decision> => {
        // With a resolver, the validator only reports skew; what happens to it is decided here.
        const outcome = decideCommit(request, gap, head, repair === "off" ? mode : "warn");
        let decision = outcome.decision;
        if (outcome.skew !== undefined && repair !== "off") {
          // `agent`: the coding agent that committed is the resolver; it gets told what changed.
          // No trees needed for that, and reading them here would ask the pool for a second
          // connection while this one holds the repository's lock.
          if (repair === "agent" || deps.repairer === undefined) {
            throw escalation({ request, skew: outcome.skew, gap, headLsn: head });
          }
          const input = {
            request,
            skew: outcome.skew,
            gap,
            headLsn: head,
            head: await deps.store.treeAt(repo, head),
            base: await deps.store.treeAt(repo, gapStart(request)),
          };
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
      mirrors?.kick(repo);
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
    const repo = repoOf(parsed.data);
    if (!(await guard(req, reply, repo, "writer"))) return reply;
    try {
      const user = currentUser(req);
      const author = user === undefined ? parsed.data.author : { ...parsed.data.author, developer: user.login };
      const intent = await deps.store.openIntent({ ...parsed.data, author });
      const message: ServerMessage = { type: "intent", intent };
      stream.broadcast(intent.repo, message);
      // Early warnings (section 9.3): the demo's "auth is changing getCurrentUser" moment.
      for (const warning of overlapWarnings(intent, await deps.store.openIntents(intent.repo))) {
        stream.broadcast(intent.repo, warning);
      }
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
    if (req.identity.kind === "anonymous" && accounts) return reply.code(401).send({ error: "unauthorized", message: "sign in to create a repository" });
    const user = currentUser(req);
    // A user creates repositories under their own GitHub login, so nobody can squat another's
    // name; the administrator may use any owner.
    if (user !== undefined && id.data.split("/")[0] !== user.login.toLowerCase()) {
      return reply.code(403).send({ error: "forbidden", message: `repositories are created under your login: ${user.login.toLowerCase()}/<name>` });
    }
    const existing = await deps.store.getRepo(id.data);
    if (existing !== undefined) {
      // Idempotent for whoever may read it (pitstop init runs it every time); a name taken by
      // someone else says only that.
      if (await allowed(req.identity, existing.id, "reader", deps.store, auth)) return reply.code(200).send(existing);
      return reply.code(409).send({ error: "taken", message: `${id.data} already exists` });
    }
    const { repo, created } = await deps.store.createRepo(id.data);
    if (created && user !== undefined) await deps.store.setMember(repo.id, user.id, "owner");
    return reply.code(created ? 201 : 200).send(repo);
  });

  app.get("/repos", async (req): Promise<Repo[]> => {
    const all = await deps.store.listRepos();
    const visible = await Promise.all(all.map(async (r) => ((await allowed(req.identity, r.id, "reader", deps.store, auth)) ? r : undefined)));
    return visible.flatMap((r) => (r === undefined ? [] : [r]));
  });

  app.get<RepoParams>("/repos/:owner/:name", async (req, reply) => {
    const repo = await deps.store.getRepo(repoParam(req));
    if (repo === undefined) return reply.code(404).send({ error: "unknown_repo" });
    if (!(await guard(req, reply, repo.id, "reader"))) return reply;
    return repo;
  });

  app.patch<RepoParams>("/repos/:owner/:name", async (req, reply) => {
    const repo = await deps.store.getRepo(repoParam(req));
    if (repo === undefined) return reply.code(404).send({ error: "unknown_repo" });
    if (!(await guard(req, reply, repo.id, "owner"))) return reply;
    const parsed = RepoPatch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    await deps.store.setVisibility(repo.id, parsed.data.visibility);
    return { ...repo, visibility: parsed.data.visibility };
  });

  // The replicas: what each connected daemon has applied, from its heartbeats (stream.ts), against the head.
  app.get<RepoParams>("/repos/:owner/:name/worktrees", async (req, reply) => {
    const repo = repoParam(req);
    if ((await deps.store.getRepo(repo)) === undefined) return reply.code(404).send({ error: "unknown_repo" });
    if (!(await guard(req, reply, repo, "reader"))) return reply;
    const intents = new Map((await deps.store.openIntents(repo)).map((i) => [i.id, i]));
    const body: WorktreesResponse = {
      headLsn: await deps.store.headLsn(repo),
      worktrees: stream.worktrees(repo).map((w) => {
        const agent = w.intentId === undefined ? undefined : intents.get(w.intentId)?.author.agent;
        return { ...w, ...(agent === undefined ? {} : { agent }) };
      }),
    };
    return body;
  });

  app.get<RepoParams>("/repos/:owner/:name/members", async (req, reply) => {
    const repo = repoParam(req);
    if ((await deps.store.getRepo(repo)) === undefined) return reply.code(404).send({ error: "unknown_repo" });
    if (!(await guard(req, reply, repo, "reader"))) return reply;
    const members = (await deps.store.listMembers(repo)).map((m) => ({ login: m.login, role: m.role, ...(m.resolver ? { resolver: true } : {}) }));
    const invites = (await deps.store.listInvites(repo)).map((i) => ({ login: i.login, role: i.role, pending: true }));
    return [...members, ...invites];
  });

  app.put<{ Params: { owner: string; name: string; login: string } }>("/repos/:owner/:name/members/:login", async (req, reply) => {
    const repo = `${req.params.owner}/${req.params.name}`;
    if ((await deps.store.getRepo(repo)) === undefined) return reply.code(404).send({ error: "unknown_repo" });
    if (!(await guard(req, reply, repo, "owner"))) return reply;
    const parsed = MemberBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    const login = GitHubLogin.safeParse(req.params.login);
    if (!login.success) return reply.code(400).send({ error: "invalid_request", message: `${req.params.login} is not a GitHub login` });
    const user = await deps.store.getUserByLogin(login.data);
    if (user === undefined) {
      // Not signed in here yet: an invite, which becomes membership at their first sign-in.
      await deps.store.setInvite(repo, login.data, parsed.data.role, currentUser(req)?.id);
      return reply.code(202).send({ login: login.data.toLowerCase(), role: parsed.data.role, pending: true });
    }
    if (parsed.data.role !== "owner" && (await lastOwner(repo, user.id))) {
      return reply.code(409).send({ error: "last_owner", message: "a repository needs an owner: make someone else owner first" });
    }
    await deps.store.setMember(repo, user.id, parsed.data.role);
    if (parsed.data.resolver !== undefined) await deps.store.setResolver(repo, user.id, parsed.data.resolver);
    const member = (await deps.store.listMembers(repo)).find((m) => m.userId === user.id);
    return { login: user.login, role: parsed.data.role, ...(member?.resolver ? { resolver: true } : {}) };
  });

  app.delete<{ Params: { owner: string; name: string; login: string } }>("/repos/:owner/:name/members/:login", async (req, reply) => {
    const repo = `${req.params.owner}/${req.params.name}`;
    if ((await deps.store.getRepo(repo)) === undefined) return reply.code(404).send({ error: "unknown_repo" });
    // Owners remove anyone; a member may remove themselves (leave).
    const leaving = currentUser(req)?.login === req.params.login;
    if (!(await guard(req, reply, repo, leaving ? "reader" : "owner"))) return reply;
    const user = await deps.store.getUserByLogin(req.params.login);
    if (user !== undefined && (await lastOwner(repo, user.id))) {
      return reply.code(409).send({ error: "last_owner", message: "a repository needs an owner: make someone else owner first" });
    }
    const removed = user === undefined ? false : await deps.store.removeMember(repo, user.id);
    const uninvited = leaving ? false : await deps.store.deleteInvite(repo, req.params.login);
    return reply.code(removed || uninvited ? 204 : 404).send();
  });

  // The git mirror of a repository: an export of its log to a GitHub branch (build plan, Phase 3).
  app.put<RepoParams>("/repos/:owner/:name/mirror", async (req, reply) => {
    if (deps.github === undefined || mirrors === undefined) {
      return reply.code(501).send({ error: "no_mirror", message: "set MIRROR_GITHUB_TOKEN on the server to mirror repositories" });
    }
    const repo = repoParam(req);
    if ((await deps.store.getRepo(repo)) === undefined) return reply.code(404).send({ error: "unknown_repo" });
    // One server-wide GitHub token pushes every mirror, so only the administrator may aim it:
    // a repository owner could otherwise point it at any branch that token can write.
    if (!adminOnly(req, reply)) return reply;
    const parsed = MirrorBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    const baseCommit = parsed.data.baseCommit ?? (await deps.github.getRef(parsed.data.github, parsed.data.branch));
    const mirror = await deps.store.setMirror(repo, { githubRepo: parsed.data.github, branch: parsed.data.branch, baseCommit });
    mirrors.kick(repo);
    return mirror;
  });

  app.get<RepoParams>("/repos/:owner/:name/mirror", async (req, reply) => {
    const repo = repoParam(req);
    const mirror = await deps.store.getMirror(repo);
    if (mirror === undefined) return reply.code(404).send({ error: "no_mirror" });
    if (!(await guard(req, reply, repo, "reader"))) return reply;
    return mirror;
  });

  app.delete<RepoParams>("/repos/:owner/:name/mirror", async (req, reply) => {
    const repo = repoParam(req);
    if (!adminOnly(req, reply)) return reply;
    await deps.store.deleteMirror(repo);
    return reply.code(204).send();
  });

  // The log over HTTP: for the live view, catch-up by hand, and debugging.
  app.get<{ Querystring: { repo?: string; fromLsn?: string; limit?: string } }>("/log", async (req, reply) => {
    const repo = RepoId.safeParse(req.query.repo ?? DEFAULT_REPO);
    if (!repo.success) return reply.code(400).send({ error: "invalid_request", message: "repo must be owner/name in lowercase" });
    const fromLsn = Lsn.safeParse(Number(req.query.fromLsn ?? 0));
    if (!fromLsn.success) return reply.code(400).send({ error: "invalid_request", message: "fromLsn must be an LSN" });
    if ((await deps.store.getRepo(repo.data)) === undefined) return reply.code(404).send({ error: "unknown_repo" });
    if (!(await guard(req, reply, repo.data, "reader"))) return reply;
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || LOG_PAGE, 1), LOG_PAGE_MAX);
    const entries: Changeset[] = await deps.store.entriesAfter(repo.data, fromLsn.data, limit);
    return entries;
  });

  // hello, then replay after the daemon's fromLsn, then live (section 8.2). See stream.ts.
  app.get("/stream", { websocket: true }, (socket, req) => {
    const identity = req.identity;
    // A signed-in browser's cookie rides along with any site's WebSocket: only our own pages may use it.
    if (identity.kind === "user" && presentedToken(req) === undefined && !sameOrigin(req, auth)) {
      socket.close(1008, "cross-origin stream refused");
      return;
    }
    stream.connect(socket, (repo) => allowed(identity, repo, "reader", deps.store, auth));
  });

  // The live view (web/): static files at /, registered last so every API route above wins over
  // the wildcard. Open to anyone who can reach the server; the data it shows is still guarded.
  if (deps.webDir !== undefined) {
    await app.register(fastifyStatic, { root: deps.webDir, prefix: "/", index: ["index.html"], wildcard: true });
  }

  return app;
}

/** 400 when the request itself is wrong; 409 when it is fine but cannot land on the current log. */
const rejected = (reply: FastifyReply, reason: RejectReason, message: string, conflictsWith: number[] = []) => {
  const body: CommitResponse = { status: "rejected", reason, message, conflictsWith };
  return reply.code(reason === "invalid_request" ? 400 : 409).send(body);
};

const issues = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
