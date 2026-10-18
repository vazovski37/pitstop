import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AdrRule, SymbolId, type Adr, type Author, type Checks, type CommitRequest, type FileChange, type Intent, type Lease, type RepoId } from "@pitstop/protocol";
import { z } from "zod";
import {
  checkedFiles,
  checkFiles,
  DEFAULT_ALIASES,
  describeRule,
  importAliases,
  mechanicalScope,
  refusalMessage,
  ruleProblem,
  splitPreexisting,
  type ImportAliases,
  type RuleReport,
  type Violation,
} from "./adr-rules.js";
import {
  holdsLease,
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
 * the checks a commit passes (ADR rules before and inside the append, leases inside it), the
 * routes, and the sweep that marks quiet intents stale and expires leases. The store keeps the
 * state (store.ts, migration 009); adr-rules.ts is the pure rule engine.
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

/**
 * The brain version a list of ADRs stands for: every move of the version stamps the ADR it moved
 * with the new version (decideAdr, in one transaction), so the highest stamp is the version. Read
 * from the same answer as the ADRs, the two can never disagree (9.2).
 */
export const brainVersionOf = (adrs: Adr[]): number => adrs.reduce((v, a) => Math.max(v, a.version), 0);

const accepted = (adrs: Adr[]): Adr[] => adrs.filter((a) => a.status === "accepted");
const usesImports = (adrs: Adr[]): boolean => adrs.some((a) => a.rules.some((r) => r.kind === "forbid_import"));
const TSCONFIG = "tsconfig.json";

/** The project's import aliases from its root tsconfig.json at `lsn` (one blob), or the defaults. */
async function aliasesAt(store: Store, repo: RepoId, lsn: number, files: FileChange[] = []): Promise<ImportAliases> {
  const own = files.find((f) => f.path === TSCONFIG && f.op !== "delete" && f.content !== undefined);
  if (own?.content !== undefined) return importAliases(own.content);
  if (files.some((f) => f.path === TSCONFIG && f.op === "delete")) return DEFAULT_ALIASES;
  return importAliases((await store.filesAt(repo, lsn, { paths: [TSCONFIG] })).get(TSCONFIG));
}

// ---------------------------------------------------------------------------------------------
// The commit path.

/** What a commit is checked against, loaded before the append (outside the repository's lock). */
export interface CommitBrain {
  version: number;
  /** Accepted ADRs. */
  adrs: Adr[];
  /** Open intents, to name a lease's task. */
  intents: Map<string, Intent>;
  /** The project's import aliases, for forbid_import. */
  aliases: ImportAliases;
}

export async function loadCommitBrain(store: Store, repo: RepoId, request: Pick<CommitRequest, "baseLsn" | "files">): Promise<CommitBrain> {
  const [all, intents] = await Promise.all([store.listAdrs(repo), store.openIntents(repo)]);
  const adrs = accepted(all);
  const aliases = usesImports(adrs) ? await aliasesAt(store, repo, request.baseLsn, request.files) : DEFAULT_ALIASES;
  return { version: brainVersionOf(all), adrs, intents: new Map(intents.map((i) => [i.id, i])), aliases };
}

/** A commit's files against the mechanical rules, split by whether the commit brought each violation. */
export interface RuleCheck {
  report: RuleReport;
  /** Violations the commit brought: these refuse it. */
  introduced: Violation[];
  /** Violations its files' previous versions already had (9.2: old code is queued for a re-check, never blocked). */
  preexisting: Violation[];
  /** The previous versions' violations, named by their path in the commit: for re-checking repaired files. */
  base: Violation[];
}

/**
 * Before the append, outside the lock: the commit's files against the accepted ADRs' mechanical
 * rules. A violation already in a file's version at the commit's base is not the commit's doing:
 * it is kept apart (and noted), so an agent fixing a typo in a legacy file is not made to
 * refactor it first. A rename without content into a rule's scope is an `InvalidCommit`.
 */
export async function checkCommit(store: Store, repo: RepoId, brain: CommitBrain, request: Pick<CommitRequest, "baseLsn" | "files">): Promise<RuleCheck> {
  for (const f of request.files) {
    if (f.op === "rename" && f.content === undefined && mechanicalScope(brain.adrs, f.path)) {
      throw new InvalidCommit(`${f.path}: a rename into a path an ADR rule covers carries the file's content, so the rule can read it; send it`);
    }
  }
  const report = checkFiles(brain.adrs, checkedFiles(request.files), { aliases: brain.aliases });
  const offending = new Set(report.violations.map((v) => v.file));
  // Base path -> path in the commit, for the files with violations that existed before it.
  const from = new Map<string, string>();
  for (const f of request.files) {
    if (!offending.has(f.path)) continue;
    if (f.op === "modify") from.set(f.path, f.path);
    else if (f.op === "rename" && f.fromPath !== undefined) from.set(f.fromPath, f.path);
  }
  let base: Violation[] = [];
  if (from.size > 0) {
    const tree = await store.filesAt(repo, request.baseLsn, { paths: [...from.keys()] });
    const old = checkFiles(brain.adrs, [...tree].map(([path, content]) => ({ path, content })), { aliases: brain.aliases });
    base = old.violations.map((v) => ({ ...v, file: from.get(v.file) ?? v.file }));
  }
  return { report, base, ...splitPreexisting(report.violations, base) };
}

/** The same check over files a repair rewrote, against the base the commit's check found. */
export function recheckFiles(brain: CommitBrain, files: FileChange[], base: Violation[]): RuleCheck {
  const report = checkFiles(brain.adrs, checkedFiles(files), { aliases: brain.aliases });
  return { report, base, ...splitPreexisting(report.violations, base) };
}

const fileOf = (symbol: string): string => symbol.slice(0, symbol.indexOf("#"));
/** Pre-existing violations named in `checks.details` before the rest is counted. */
const NOTED = 5;

/**
 * Inside the append, under the repository's lock: refuses a commit that writes a symbol another
 * agent holds a live lease on (9.4; `leases` are read under that lock, so a grant cannot slip in
 * between), or that brings a violation of an accepted ADR's mechanical rule (9.1), as
 * `constraint_failed` with a message the agent can act on. Otherwise answers what `checks.adr`
 * records and the notes for `checks.details`.
 *
 * A commit with no symbol sets at all (the daemon sends none for a tree without a root
 * tsconfig.json) cannot say which symbols it writes: a lease then holds its whole file.
 */
export function enforceBrain(brain: CommitBrain, leases: Lease[], request: CommitRequest, check: RuleCheck): { adr: Checks["adr"]; notes: string[] } {
  const writes = new Set([...request.writeSet, ...request.sigWriteSet]);
  const noSets = request.writeSet.length === 0 && request.sigWriteSet.length === 0 && request.readSet.length === 0;
  const touched = new Set(request.files.flatMap((f) => (f.fromPath === undefined ? [f.path] : [f.path, f.fromPath])));
  const byFile = (l: Lease) => noSets && touched.has(fileOf(l.symbol));
  const blocked = leases.filter((l) => !holdsLease(l, request.author, request.intentId) && (writes.has(l.symbol) || byFile(l)));
  if (blocked.length > 0) {
    const lines = blocked.map((l) => {
      const intent = l.intentId === undefined ? undefined : brain.intents.get(l.intentId);
      const task = l.intentId === undefined ? "" : ` for intent ${l.intentId}${intent === undefined ? "" : ` "${intent.text}"`}`;
      const how = writes.has(l.symbol) ? "" : ` (your commit has no symbol sets, so a lease holds its whole file, ${fileOf(l.symbol)})`;
      return `${l.symbol} is leased to ${l.holder.agent} (${l.holder.developer})${task} until ${l.expiresAt}${l.reason ? `: ${l.reason}` : ""}${how}`;
    });
    const one = blocked.length === 1;
    throw new RejectedCommit(
      "constraint_failed",
      `${lines.join("; ")}. Another agent holds ${one ? "this symbol" : "these symbols"} for a short while: leave ${one ? "it" : "them"} alone and commit the rest, or wait until the lease is released (at its holder's commit) or expires, then commit again.`,
    );
  }
  if (check.introduced.length > 0) {
    const older = check.preexisting.length === 0 ? "" : `\n(${check.preexisting.length} older violation${check.preexisting.length === 1 ? " was" : "s were"} already in these files before your change; ${check.preexisting.length === 1 ? "it is" : "they are"} not yours to fix now.)`;
    throw new RejectedCommit("constraint_failed", `${refusalMessage(check.introduced, brain.adrs, brain.version)}${older}`);
  }
  const notes = check.report.broken.map((b) => `rule not run: ${b}`);
  if (check.report.applied > 0) notes.unshift(`ADR rules held (brain v${brain.version}, ${check.report.applied} rule${check.report.applied === 1 ? "" : "s"})`);
  if (check.preexisting.length > 0) {
    const listed = check.preexisting.slice(0, NOTED).map((v) => `ADR-${v.adr} ${v.file}:${v.line} ${v.detail}`);
    const more = check.preexisting.length > NOTED ? ` and ${check.preexisting.length - NOTED} more` : "";
    notes.push(`pre-existing, on the re-check queue: ${listed.join("; ")}${more}`);
  }
  return { adr: check.report.applied > 0 ? "pass" : "skipped", notes };
}

/** The decision with the brain's part added: `checks.adr`, the notes and advisory reviews, the brain version. */
export function withBrain(decision: Decision, brain: CommitBrain, result: { adr: Checks["adr"]; notes: string[] }, advisory: string[]): Decision {
  const checks = decision.checks ?? SKIPPED_CHECKS;
  const details = [checks.details, ...result.notes, ...advisory].filter((d): d is string => d !== undefined && d !== "").join("; ");
  return { ...decision, checks: { ...checks, adr: result.adr, ...(details === "" ? {} : { details }) }, brainVersion: brain.version };
}

/**
 * After a commit that closed an intent: its leases go, and every worktree hears the intent closed.
 * Only the intent's own author closes it (the store refuses to close someone else's).
 */
export async function afterCommit(ctx: Pick<BrainContext, "store" | "stream" | "now">, repo: RepoId, intentId: string | undefined, author: Author): Promise<void> {
  if (intentId === undefined) return;
  const intent = await ctx.store.getIntent(repo, intentId);
  if (intent === undefined || !sameAuthor(intent.author, author)) return;
  ctx.stream.broadcast(repo, { type: "intent", intent });
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
/** `?before=` (an LSN): the page of a newest-first answer below it. */
const beforeOf = (raw: string | undefined): { before?: number } => {
  const n = Math.trunc(Number(raw));
  return raw !== undefined && Number.isFinite(n) && n > 0 ? { before: n } : {};
};

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

/** Re-check answers kept per (repository, head, brain version): the same question has the same answer. */
const RECHECKS_KEPT = 64;

export function registerBrainRoutes(app: FastifyInstance, ctx: BrainContext): void {
  const { store, stream } = ctx;
  const by = (req: FastifyRequest, fallback?: string): string => ctx.currentUser(req)?.login ?? fallback ?? "admin";
  const rechecks = new Map<string, unknown>();

  // The brain at a glance: what the live view shows and what an agent is given when it declares an intent.
  app.get<RepoParams>("/repos/:owner/:name/brain", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const [adrs, leases, intents] = await Promise.all([store.listAdrs(repo), store.liveLeases(repo, ctx.now()), store.openIntents(repo)]);
    return { repo, version: brainVersionOf(adrs), adrs, leases, intents };
  });

  // What the rules said when something was written (9.2): the ADRs in force at an entry's brain version, or at a version.
  app.get<RepoParams & { Querystring: { lsn?: string; version?: string } }>("/repos/:owner/:name/brain/at", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    if (req.query.lsn !== undefined) {
      const lsn = Number(req.query.lsn);
      // One entry, without its files' contents.
      const [entry] = Number.isInteger(lsn) && lsn > 0 ? await store.findEntries(repo, { since: lsn - 1, limit: 1 }) : [];
      if (entry === undefined || entry.lsn !== lsn) return reply.code(404).send({ error: "not_found", message: `no entry #${req.query.lsn}` });
      return { lsn, intent: entry.intent, version: entry.brainVersion, adrs: await store.adrsInForce(repo, entry.brainVersion) };
    }
    const version = req.query.version === undefined ? await store.brainVersion(repo) : Number(req.query.version);
    if (!Number.isInteger(version) || version < 0) return reply.code(400).send({ error: "invalid_request", message: "version must be a whole number" });
    return { version, adrs: await store.adrsInForce(repo, version) };
  });

  // The re-check queue (9.2): the accepted rules run over the files at head they cover, outside any
  // lock; the entries that touched an offending file and were validated before that rule existed.
  // Writers only (it reads file contents and runs every rule), and remembered per head and version.
  app.get<RepoParams>("/repos/:owner/:name/brain/recheck", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "writer"))) return reply;
    const [head, all] = await Promise.all([store.headLsn(repo), store.listAdrs(repo)]);
    const version = brainVersionOf(all);
    const adrs = accepted(all);
    const mechanical = adrs.flatMap((a) => a.rules.filter((r) => r.kind !== "ai_review"));
    if (mechanical.length === 0) return { repo, head, version, checkedFiles: 0, rules: 0, violations: [], queue: [] };
    const key = `${repo}\n${head}\n${version}`;
    const kept = rechecks.get(key);
    if (kept !== undefined) return kept;

    const [tree, paths, aliases] = await Promise.all([
      store.filesAt(repo, head, { globs: [...new Set(mechanical.map((r) => r.files))] }),
      store.pathsAt(repo, head),
      usesImports(adrs) ? aliasesAt(store, repo, head) : Promise.resolve(DEFAULT_ALIASES),
    ]);
    const exists = new Set(paths);
    const files = [...tree.entries()].map(([path, content]) => ({ path, content }));
    const report = checkFiles(adrs, files, { exists: (p) => exists.has(p), aliases });
    const versionOf = new Map(adrs.map((a) => [a.number, a.version]));
    // file -> the brain version from which each offending ADR applied
    const offending = new Map<string, Map<number, number>>();
    for (const v of report.violations) {
      const byAdr = offending.get(v.file) ?? new Map<number, number>();
      byAdr.set(v.adr, versionOf.get(v.adr) ?? version);
      offending.set(v.file, byAdr);
    }
    // Oldest first, and only entries validated before the newest offending rule: the ones that brought the violations.
    const newest = Math.max(0, ...[...offending.values()].flatMap((m) => [...m.values()]));
    const touched = offending.size === 0 ? [] : await store.findEntries(repo, { paths: [...offending.keys()], brainBefore: newest, limit: 500 });
    const queue = touched.flatMap((e) => {
      const files = e.files.map((f) => f.path).filter((p) => offending.has(p));
      const adrNumbers = [...new Set(files.flatMap((p) => [...(offending.get(p) ?? new Map<number, number>()).entries()].filter(([, from]) => e.brainVersion < from).map(([n]) => n)))];
      return adrNumbers.length === 0 ? [] : [{ lsn: e.lsn, intent: e.intent, author: e.author, createdAt: e.createdAt, brainVersion: e.brainVersion, files, adrs: adrNumbers.sort((a, b) => a - b) }];
    });
    const answer = {
      repo,
      head,
      version,
      checkedFiles: files.length,
      rules: report.applied,
      violations: report.violations.map((v) => ({ adr: v.adr, title: v.title, rule: describeRule(v.rule), file: v.file, line: v.line, detail: v.detail })),
      queue,
      ...(report.broken.length === 0 ? {} : { broken: report.broken }),
    };
    if (rechecks.size >= RECHECKS_KEPT) rechecks.delete(rechecks.keys().next().value as string);
    rechecks.set(key, answer);
    return answer;
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
      return problem === undefined ? [] : [`rules.${i} (${describeRule(rule).slice(0, 300)}): ${problem}`];
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

  // Take (or renew) a lease on one hot symbol (9.4). 409 names the holder. Its holder renews it by
  // asking again (the daemon does, on a timer, while its intent is open); nothing else renews it.
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

  // Release. A caller that names an agent releases as the holder: a signed-in user as themselves,
  // the shared token naming the developer too (every daemon's agent may be called "claude-code"),
  // and with `intentId` the lease must be that intent's. Without an agent: the holder signed in,
  // an owner, or the administrator. Only the lease checked is released, never one taken since.
  app.delete<RepoParams & { Querystring: { symbol?: string; agent?: string; developer?: string; intentId?: string } }>("/repos/:owner/:name/leases", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const symbol = SymbolId.safeParse(req.query.symbol);
    if (!symbol.success) return reply.code(400).send({ error: "invalid_request", message: "expected ?symbol=path#name" });
    const held = (await store.liveLeases(repo, ctx.now())).find((l) => l.symbol === symbol.data);
    if (held === undefined) return reply.code(404).send({ error: "not_found", message: `nobody holds a lease on ${symbol.data}` });
    const user = ctx.currentUser(req);
    const { agent, developer, intentId } = req.query;
    let allowed: boolean;
    if (agent !== undefined) {
      const asker = { developer: user?.login ?? developer ?? "", agent };
      const sameTask = intentId === undefined || held.intentId === undefined || held.intentId === intentId;
      allowed = (user !== undefined || ctx.isAdmin(req)) && sameAuthor(held.holder, asker) && sameTask;
    } else {
      allowed = (user !== undefined && held.holder.developer === user.login) || ctx.isAdmin(req) || (await ctx.may(req, repo, "owner"));
    }
    if (!allowed) return reply.code(403).send({ error: "forbidden", message: `${symbol.data} is held by ${held.holder.agent} (${held.holder.developer}); only its holder or an owner releases it` });
    const released = await store.releaseLease(repo, symbol.data, ctx.now(), held.holder);
    if (released === undefined) return reply.code(404).send({ error: "not_found", message: `nobody holds a lease on ${symbol.data}` });
    stream.broadcast(repo, { type: "lease", lease: released });
    return released;
  });

  // The query API (section 10). Symbol ids hold `/` and `#`: they come URL-encoded. Answers are
  // newest first; `?before=<lsn>` asks for the next page.
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

  const symbolHistory = async (repo: string, symbol: string, query: { limit?: string; before?: string }) => {
    const [entries, intents, leases] = await Promise.all([
      store.findEntries(repo, { writes: symbol, newestFirst: true, limit: limitOf(query.limit, 50, 500), ...beforeOf(query.before) }),
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
  };
  const symbolCallers = async (repo: string, symbol: string, query: { limit?: string; before?: string }) => {
    const entries = await store.findEntries(repo, { reads: symbol, newestFirst: true, limit: limitOf(query.limit, 50, 500), ...beforeOf(query.before) });
    return {
      symbol,
      derivedFrom: "the read sets of landed entries (what each change referred to), not a parsed call graph",
      callers: entries.map((e) => ({ ...entryView(e), wrote: [...new Set([...e.writeSet, ...e.sigWriteSet])] })),
    };
  };

  app.get<{ Params: { owner: string; name: string; id: string }; Querystring: { limit?: string; before?: string } }>("/repos/:owner/:name/symbols/:id/history", async (req, reply) => {
    const repo = `${req.params.owner}/${req.params.name}`;
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    return symbolHistory(repo, req.params.id, req.query);
  });

  app.get<{ Params: { owner: string; name: string; id: string }; Querystring: { limit?: string; before?: string } }>("/repos/:owner/:name/symbols/:id/callers", async (req, reply) => {
    const repo = `${req.params.owner}/${req.params.name}`;
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    return symbolCallers(repo, req.params.id, req.query);
  });

  // The same two with the symbol in the query string. Some proxies (Azure Container Apps' ingress
  // among them) rewrite an encoded `/` in a path, so a symbol id in the path never reaches this
  // server there; a query string arrives intact. The daemon uses these.
  app.get<RepoParams & { Querystring: { symbol?: string; limit?: string; before?: string } }>("/repos/:owner/:name/history", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const symbol = SymbolId.safeParse(req.query.symbol);
    if (!symbol.success) return reply.code(400).send({ error: "invalid_request", message: "expected ?symbol=path#name" });
    return symbolHistory(repo, symbol.data, req.query);
  });

  app.get<RepoParams & { Querystring: { symbol?: string; limit?: string; before?: string } }>("/repos/:owner/:name/callers", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const symbol = SymbolId.safeParse(req.query.symbol);
    if (!symbol.success) return reply.code(400).send({ error: "invalid_request", message: "expected ?symbol=path#name" });
    return symbolCallers(repo, symbol.data, req.query);
  });

  app.get<RepoParams & { Querystring: { path?: string; limit?: string; before?: string } }>("/repos/:owner/:name/why", async (req, reply) => {
    const repo = repoOfParams(req);
    if (!(await ctx.access(req, reply, repo, "reader"))) return reply;
    const path = req.query.path;
    if (path === undefined || path === "") return reply.code(400).send({ error: "invalid_request", message: "expected ?path=" });
    const entries = await store.findEntries(repo, { paths: [path], newestFirst: true, limit: limitOf(req.query.limit, 10, 100), ...beforeOf(req.query.before) });
    return {
      path,
      entries: entries.map((e) => ({ ...entryView(e), op: e.files.find((f) => f.path === path || f.fromPath === path)?.op ?? "modify" })),
    };
  });
}
