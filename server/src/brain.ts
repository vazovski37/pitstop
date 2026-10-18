import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AdrRule, SymbolId, type Adr, type Checks, type CommitRequest, type FileChange, type Intent, type Lease, type RepoId } from "@pitstop/protocol";
import { z } from "zod";
import { checkedFiles, checkFiles, describeRule, refusalMessage, ruleProblem, type RuleReport } from "./adr-rules.js";
import {
  InvalidCommit,
  LEASE_TTL,
  RejectedCommit,
  sameAuthor,
  SKIPPED_CHECKS,
  type AdrVerdict,
  type Decision,
  type LoggedEntry,
  type Role,
  type Store,
  type User,
} from "./store.js";
import type { Stream } from "./stream.js";

/**
 * The brain (design doc section 9) and the query API (section 10), as the server serves them:
 * the checks a commit passes inside the append (ADR rules, leases), the routes, and the sweep that
 * marks quiet intents stale and expires leases. The store keeps the state (store.ts, migration 009);
 * adr-rules.ts is the pure rule engine.
 */

/** What the routes need from buildApp: the store, the stream, and its access helpers. */
export interface BrainContext {
  store: Store;
  stream: Stream;
  /** Answers 404 (unreadable) or 401/403 and returns false unless the caller may act at `role` (app.ts). */
  access: (req: FastifyRequest, reply: FastifyReply, repo: RepoId, role: Role) => Promise<boolean>;
  /** Whether the caller may act at `role`, without answering. */
  may: (req: FastifyRequest, repo: RepoId, role: Role) => Promise<boolean>;
  isAdmin: (req: FastifyRequest) => boolean;
  currentUser: (req: FastifyRequest) => User | undefined;
  now: () => Date;
}

// ---------------------------------------------------------------------------------------------
// The commit path.

/** What a commit is checked against, loaded before the append (outside the repository's lock). */
export interface CommitBrain {
  version: number;
  /** Accepted ADRs. */
  adrs: Adr[];
  /** Live leases. */
  leases: Lease[];
  /** Open intents, to name a lease's task. */
  intents: Map<string, Intent>;
}

export async function loadCommitBrain(store: Store, repo: RepoId, now: Date): Promise<CommitBrain> {
  const [version, adrs, leases, intents] = await Promise.all([
    store.brainVersion(repo),
    store.listAdrs(repo),
    store.liveLeases(repo, now),
    store.openIntents(repo),
  ]);
  return { version, adrs: adrs.filter((a) => a.status === "accepted"), leases, intents: new Map(intents.map((i) => [i.id, i])) };
}

/**
 * Inside the append: refuses a commit that writes a symbol another agent holds a live lease on
 * (9.4), or whose files break a mechanical rule of an accepted ADR (9.1), as `constraint_failed`
 * with a message the agent can act on. Otherwise answers what `checks.adr` records.
 */
export function enforceBrain(brain: CommitBrain, request: CommitRequest, files: FileChange[]): { adr: Checks["adr"]; notes: string[] } {
  const writes = new Set([...request.writeSet, ...request.sigWriteSet]);
  const blocked = brain.leases.filter((l) => writes.has(l.symbol) && !sameAuthor(l.holder, request.author));
  if (blocked.length > 0) {
    const lines = blocked.map((l) => {
      const intent = l.intentId === undefined ? undefined : brain.intents.get(l.intentId);
      const task = l.intentId === undefined ? "" : ` for intent ${l.intentId}${intent === undefined ? "" : ` "${intent.text}"`}`;
      return `${l.symbol} is leased to ${l.holder.agent} (${l.holder.developer})${task} until ${l.expiresAt}${l.reason ? `: ${l.reason}` : ""}`;
    });
    throw new RejectedCommit(
      "constraint_failed",
      `${lines.join("; ")}. Another agent holds ${blocked.length === 1 ? "this symbol" : "these symbols"} for a short while: leave ${blocked.length === 1 ? "it" : "them"} alone and commit the rest, or wait until the lease is released (at its holder's commit) or expires, then commit again.`,
    );
  }
  const report: RuleReport = checkFiles(brain.adrs, checkedFiles(files));
  if (report.violations.length > 0) throw new RejectedCommit("constraint_failed", refusalMessage(report.violations, brain.adrs, brain.version));
  const notes = report.broken.map((b) => `rule not run: ${b}`);
  if (report.applied > 0) notes.unshift(`ADR rules held (brain v${brain.version}, ${report.applied} rule${report.applied === 1 ? "" : "s"})`);
  return { adr: report.applied > 0 ? "pass" : "skipped", notes };
}

/** The decision with the brain's part added: `checks.adr`, the notes and advisory reviews, the brain version. */
export function withBrain(decision: Decision, brain: CommitBrain, result: { adr: Checks["adr"]; notes: string[] }, advisory: string[]): Decision {
  const checks = decision.checks ?? SKIPPED_CHECKS;
  const details = [checks.details, ...result.notes, ...advisory].filter((d): d is string => d !== undefined && d !== "").join("; ");
  return { ...decision, checks: { ...checks, adr: result.adr, ...(details === "" ? {} : { details }) }, brainVersion: brain.version };
}

/** After a commit that closed an intent: its leases go, and every worktree hears the intent closed. */
export async function afterCommit(ctx: Pick<BrainContext, "store" | "stream" | "now">, repo: RepoId, intentId: string | undefined): Promise<void> {
  if (intentId === undefined) return;
  const intent = await ctx.store.getIntent(repo, intentId);
  if (intent !== undefined) ctx.stream.broadcast(repo, { type: "intent", intent });
  for (const lease of await ctx.store.releaseIntentLeases(repo, intentId, ctx.now())) ctx.stream.broadcast(repo, { type: "lease", lease });
}

// ---------------------------------------------------------------------------------------------
// The sweep (9.3, 9.4).

export const STALE_AFTER_MS = 5 * 60_000;
export const SWEEP_MS = 30_000;

/**
 * Marks open intents with no heartbeat for `staleAfterMs` stale and releases their leases, then
 * expires leases past their expiry; every change is broadcast. A crashed agent blocks nobody.
 */
export async function brainSweep(ctx: Pick<BrainContext, "store" | "stream" | "now">, staleAfterMs = STALE_AFTER_MS): Promise<{ stale: Intent[]; ended: Lease[] }> {
  const at = ctx.now();
  const ended: Lease[] = [];
  const stale = await ctx.store.markStaleIntents(new Date(at.getTime() - staleAfterMs));
  for (const intent of stale) {
    ctx.stream.broadcast(intent.repo, { type: "intent", intent });
    ended.push(...(await ctx.store.releaseIntentLeases(intent.repo, intent.id, at)));
  }
  ended.push(...(await ctx.store.expireLeases(at)));
  for (const lease of ended) ctx.stream.broadcast(lease.repo, { type: "lease", lease });
  return { stale, ended };
}

// ---------------------------------------------------------------------------------------------
// Routes.

type RepoParams = { Params: { owner: string; name: string } };
const repoOfParams = (req: FastifyRequest<RepoParams>): RepoId => `${req.params.owner}/${req.params.name}`;

const AdrBody = z.object({
  title: z.string().trim().min(1).max(200),
  decision: z.string().trim().min(1).max(4_000),
  reason: z.string().max(4_000).default(""),
  consequences: z.string().max(4_000).default(""),
  rules: z.array(AdrRule).max(50).default([]),
  /** Who proposes, when the shared token calls (a signed-in user is themselves). */
  by: z.string().min(1).max(100).optional(),
});
const LeaseBody = z.object({
  symbol: SymbolId,
  agent: z.string().min(1).max(100),
  /** The holder's developer, when the shared token calls (a signed-in user is themselves). */
  developer: z.string().min(1).max(100).optional(),
  reason: z.string().max(500).default(""),
  ttlSeconds: z.number().int().min(LEASE_TTL.min).max(LEASE_TTL.max).default(LEASE_TTL.default),
  intentId: z.string().min(1).optional(),
});
const VERDICTS: Record<string, AdrVerdict> = { accept: "accepted", reject: "rejected", supersede: "superseded" };

const issues = (error: z.ZodError): string => error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
const limitOf = (raw: string | undefined, fallback: number, max: number): number => Math.min(Math.max(Math.trunc(Number(raw)) || fallback, 1), max);

/** An entry as the query API answers it: no file contents, the intent it closed. */
const entryView = (e: LoggedEntry) => ({
  lsn: e.lsn,
  intent: e.intent,
  ...(e.intentId === undefined ? {} : { intentId: e.intentId }),
  author: e.author,
  createdAt: e.createdAt,
  brainVersion: e.brainVersion,
  files: e.files.map((f) => ({ path: f.path, op: f.op, ...(f.fromPath === undefined ? {} : { fromPath: f.fromPath }) })),
  repairs: e.repairs.map((r) => r.summary),
  ...(e.checks.details === undefined ? {} : { details: e.checks.details }),
});

export function registerBrainRoutes(app: FastifyInstance, ctx: BrainContext): void {
  const { store, stream } = ctx;
  const by = (req: FastifyRequest, fallback?: string): string => ctx.currentUser(req)?.login ?? fallback ?? "admin";

  // The brain at a glance: what the live view shows and what an agent is given when it declares an intent.
  app.get<RepoParams>("/repos/:owner/:name/brain", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const [version, adrs, leases, intents] = await Promise.all([store.brainVersion(repo), store.listAdrs(repo), store.liveLeases(repo, ctx.now()), store.openIntents(repo)]);
    return { repo, version, adrs, leases, intents };
  });

  // What the rules said when something was written (9.2): the ADRs in force at an entry's brain version, or at a version.
  app.get<RepoParams & { Querystring: { lsn?: string; version?: string } }>("/repos/:owner/:name/brain/at", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    if (req.query.lsn !== undefined) {
      const lsn = Number(req.query.lsn);
      const [entry] = Number.isInteger(lsn) && lsn > 0 ? await store.entriesAfter(repo, lsn - 1, 1) : [];
      if (entry === undefined || entry.lsn !== lsn) return reply.code(404).send({ error: "not_found", message: `no entry #${req.query.lsn}` });
      return { lsn, intent: entry.intent, version: entry.brainVersion, adrs: await store.adrsInForce(repo, entry.brainVersion) };
    }
    const version = req.query.version === undefined ? await store.brainVersion(repo) : Number(req.query.version);
    if (!Number.isInteger(version) || version < 0) return reply.code(400).send({ error: "invalid_request", message: "version must be a whole number" });
    return { version, adrs: await store.adrsInForce(repo, version) };
  });

  // The re-check queue (9.2): the accepted rules run over the tree at head, outside any lock; the
  // entries that touched an offending file and were validated before that rule existed.
  app.get<RepoParams>("/repos/:owner/:name/brain/recheck", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const head = await store.headLsn(repo);
    const [version, all, tree] = await Promise.all([store.brainVersion(repo), store.listAdrs(repo), store.treeAt(repo, head)]);
    const adrs = all.filter((a) => a.status === "accepted");
    const files = [...tree.entries()].map(([path, content]) => ({ path, content }));
    const report = checkFiles(adrs, files, { exists: (p) => tree.has(p) });
    const versionOf = new Map(adrs.map((a) => [a.number, a.version]));
    // file -> the brain version from which each offending ADR applied
    const offending = new Map<string, Map<number, number>>();
    for (const v of report.violations) {
      const byAdr = offending.get(v.file) ?? new Map<number, number>();
      byAdr.set(v.adr, versionOf.get(v.adr) ?? version);
      offending.set(v.file, byAdr);
    }
    const touched = offending.size === 0 ? [] : await store.findEntries(repo, { paths: [...offending.keys()], newestFirst: true, limit: 500 });
    const queue = touched.flatMap((e) => {
      const files = e.files.map((f) => f.path).filter((p) => offending.has(p));
      const adrNumbers = [...new Set(files.flatMap((p) => [...(offending.get(p) ?? new Map<number, number>()).entries()].filter(([, from]) => e.brainVersion < from).map(([n]) => n)))];
      return adrNumbers.length === 0 ? [] : [{ lsn: e.lsn, intent: e.intent, author: e.author, createdAt: e.createdAt, brainVersion: e.brainVersion, files, adrs: adrNumbers.sort((a, b) => a - b) }];
    });
    return {
      repo,
      head,
      version,
      checkedFiles: files.length,
      rules: report.applied,
      violations: report.violations.map((v) => ({ adr: v.adr, title: v.title, rule: describeRule(v.rule), file: v.file, line: v.line, detail: v.detail })),
      queue,
      ...(report.broken.length === 0 ? {} : { broken: report.broken }),
    };
  });

  app.get<RepoParams>("/repos/:owner/:name/adrs", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    return store.listAdrs(repo);
  });

  // A writer proposes; owners decide (below).
  app.post<RepoParams>("/repos/:owner/:name/adrs", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "writer"))) return reply;
    const parsed = AdrBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    const problems = parsed.data.rules.flatMap((rule, i) => {
      const problem = ruleProblem(rule);
      return problem === undefined ? [] : [`rules.${i} (${describeRule(rule)}): ${problem}`];
    });
    if (problems.length > 0) return reply.code(400).send({ error: "invalid_request", message: problems.join("; ") });
    const { by: proposer, ...proposal } = parsed.data;
    const adr = await store.proposeAdr({ repo, ...proposal, createdBy: by(req, proposer) });
    stream.broadcast(repo, { type: "brain", repo, version: await store.brainVersion(repo), adr });
    return reply.code(201).send(adr);
  });

  for (const [action, verdict] of Object.entries(VERDICTS)) {
    app.post<{ Params: { owner: string; name: string; number: string } }>(`/repos/:owner/:name/adrs/:number/${action}`, async (req, reply) => {
      const repo = `${req.params.owner}/${req.params.name}`;
      if (!(await ctx.access(req, reply, repo, "owner"))) return reply;
      const number = Number(req.params.number);
      if (!Number.isInteger(number) || number < 1) return reply.code(404).send({ error: "not_found" });
      const change = await store.decideAdr(repo, number, verdict, by(req));
      if (!change.ok) {
        if (change.error === "not_found") return reply.code(404).send({ error: "not_found", message: `no ADR-${number}` });
        return reply.code(409).send({ error: "invalid_transition", message: `ADR-${number} is ${change.adr.status}; only a ${verdict === "superseded" ? "accepted" : "proposed"} ADR can be ${verdict}` });
      }
      stream.broadcast(repo, { type: "brain", repo, version: change.version, adr: change.adr });
      return { version: change.version, adr: change.adr };
    });
  }

  app.get<RepoParams>("/repos/:owner/:name/leases", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    return store.liveLeases(repo, ctx.now());
  });

  // Take (or renew) a lease on one hot symbol (9.4). 409 names the holder.
  app.post<RepoParams>("/repos/:owner/:name/leases", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "writer"))) return reply;
    const parsed = LeaseBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", message: issues(parsed.error) });
    const { symbol, agent, developer, reason, ttlSeconds, intentId } = parsed.data;
    const holder = { developer: by(req, developer), agent };
    try {
      const grant = await store.acquireLease({ repo, symbol, holder, reason, ttlSeconds, ...(intentId === undefined ? {} : { intentId }) }, ctx.now());
      for (const lease of grant.expired) stream.broadcast(repo, { type: "lease", lease });
      if (!grant.granted) {
        const h = grant.holder;
        return reply.code(409).send({
          error: "leased",
          message: `${symbol} is leased to ${h.holder.agent} (${h.holder.developer})${h.intentId === undefined ? "" : ` for intent ${h.intentId}`} until ${h.expiresAt}${h.reason ? `: ${h.reason}` : ""}`,
          lease: h,
        });
      }
      stream.broadcast(repo, { type: "lease", lease: grant.lease });
      return reply.code(grant.renewed ? 200 : 201).send({ lease: grant.lease, renewed: grant.renewed });
    } catch (err) {
      if (err instanceof InvalidCommit) return reply.code(400).send({ error: "invalid_request", message: err.message });
      throw err;
    }
  });

  // Release: the holder (a signed-in user releases their own; a daemon names its agent), an owner, or the administrator.
  app.delete<RepoParams & { Querystring: { symbol?: string; agent?: string } }>("/repos/:owner/:name/leases", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const symbol = SymbolId.safeParse(req.query.symbol);
    if (!symbol.success) return reply.code(400).send({ error: "invalid_request", message: "expected ?symbol=path#name" });
    const held = (await store.liveLeases(repo, ctx.now())).find((l) => l.symbol === symbol.data);
    if (held === undefined) return reply.code(404).send({ error: "not_found", message: `nobody holds a lease on ${symbol.data}` });
    const user = ctx.currentUser(req);
    const agent = req.query.agent;
    const holderAsks = user !== undefined ? held.holder.developer === user.login && (agent === undefined || agent === held.holder.agent) : agent === undefined || agent === held.holder.agent;
    const allowed = (holderAsks && (ctx.isAdmin(req) || user !== undefined)) || (agent === undefined && (ctx.isAdmin(req) || (await ctx.may(req, repo, "owner"))));
    if (!allowed) return reply.code(403).send({ error: "forbidden", message: `${symbol.data} is held by ${held.holder.agent} (${held.holder.developer}); only its holder or an owner releases it` });
    const released = await store.releaseLease(repo, symbol.data, ctx.now());
    if (released === undefined) return reply.code(404).send({ error: "not_found" });
    stream.broadcast(repo, { type: "lease", lease: released });
    return released;
  });

  // The query API (section 10). Symbol ids hold `/` and `#`: they come URL-encoded.
  app.get<RepoParams & { Querystring: { prefix?: string; limit?: string } }>("/repos/:owner/:name/symbols", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const [states, leases] = await Promise.all([store.symbolStates(repo, req.query.prefix ?? "", limitOf(req.query.limit, 200, 1_000)), store.liveLeases(repo, ctx.now())]);
    const leased = new Map(leases.map((l) => [l.symbol, l]));
    return {
      symbols: states.map((s) => {
        const lease = leased.get(s.symbol);
        return { ...s, ...(lease === undefined ? {} : { lease }) };
      }),
    };
  });

  app.get<{ Params: { owner: string; name: string; id: string }; Querystring: { limit?: string } }>("/repos/:owner/:name/symbols/:id/history", async (req, reply) => {
    const repo = `${req.params.owner}/${req.params.name}`;
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const symbol = req.params.id;
    const [entries, intents, leases] = await Promise.all([
      store.findEntries(repo, { writes: symbol, newestFirst: true, limit: limitOf(req.query.limit, 50, 500) }),
      store.openIntents(repo),
      store.liveLeases(repo, ctx.now()),
    ]);
    const lease = leases.find((l) => l.symbol === symbol);
    return {
      symbol,
      history: entries.map((e) => ({ ...entryView(e), signature: e.sigWriteSet.includes(symbol) })),
      declaredBy: intents.filter((i) => i.declaredSymbols.includes(symbol)).map((i) => ({ id: i.id, text: i.text, author: i.author })),
      ...(lease === undefined ? {} : { lease }),
    };
  });

  app.get<{ Params: { owner: string; name: string; id: string }; Querystring: { limit?: string } }>("/repos/:owner/:name/symbols/:id/callers", async (req, reply) => {
    const repo = `${req.params.owner}/${req.params.name}`;
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const symbol = req.params.id;
    const entries = await store.findEntries(repo, { reads: symbol, newestFirst: true, limit: limitOf(req.query.limit, 50, 500) });
    return {
      symbol,
      derivedFrom: "the read sets of landed entries (what each change referred to), not a parsed call graph",
      callers: entries.map((e) => ({ ...entryView(e), wrote: [...new Set([...e.writeSet, ...e.sigWriteSet])] })),
    };
  });

  app.get<RepoParams & { Querystring: { path?: string; limit?: string } }>("/repos/:owner/:name/why", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const path = req.query.path;
    if (path === undefined || path === "") return reply.code(400).send({ error: "invalid_request", message: "expected ?path=" });
    const entries = await store.findEntries(repo, { paths: [path], newestFirst: true, limit: limitOf(req.query.limit, 10, 100) });
    return {
      path,
      entries: entries.map((e) => ({ ...entryView(e), op: e.files.find((f) => f.path === path || f.fromPath === path)?.op ?? "modify" })),
    };
  });
}
