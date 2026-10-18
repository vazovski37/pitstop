/**
 * The daemon's side of the brain (design doc section 9) and the query API (section 10): what it
 * asks the server for, and how it puts the answers into the few lines an agent reads. The server
 * owns the state; nothing here is cached.
 */
import { Adr, DEFAULT_REPO, Intent, Lease, RepoId, type AdrRule, type Author, type SymbolId } from "@pitstop/protocol";
import { z } from "zod";
import { serverHeaders } from "./config.js";

export interface ServerAccess {
  serverUrl: string;
  token?: string;
  /** The repository on the server; absent means its default one. */
  repo?: string;
  fetch?: typeof fetch;
}

/** `GET /repos/:o/:n/brain`: a server query, not a protocol message; its shape is checked here. */
export const Brain = z.object({
  repo: RepoId,
  version: z.number().int().nonnegative(),
  adrs: z.array(Adr),
  leases: z.array(Lease),
  intents: z.array(Intent),
});
export type Brain = z.infer<typeof Brain>;

const repoUrl = (a: ServerAccess, path: string): URL => new URL(`/repos/${a.repo ?? DEFAULT_REPO}${path}`, a.serverUrl);

async function get(a: ServerAccess, path: string): Promise<unknown> {
  const res = await (a.fetch ?? fetch)(repoUrl(a, path), { headers: serverHeaders(a.token) });
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

export async function fetchBrain(a: ServerAccess): Promise<Brain> {
  return Brain.parse(await get(a, "/brain"));
}

/** `GET /repos/:o/:n/leases`: the live leases. */
export async function fetchLeases(a: ServerAccess): Promise<Lease[]> {
  return z.array(Lease).parse(await get(a, "/leases"));
}

/** How long a lease lives without being renewed, when its taker named no time (the server's default). */
export const LEASE_TTL_SECONDS = 300;

/** One rule in one line, the way the server's refusals name it. An ai_review rule never refuses, and says so. */
export function ruleLine(rule: AdrRule, max = Number.POSITIVE_INFINITY): string {
  switch (rule.kind) {
    case "forbid_import":
      return `forbid_import ${rule.files} -> ${rule.target}`;
    case "forbid_call":
      return `forbid_call ${rule.files}: ${rule.call}()`;
    case "forbid_pattern":
      return `forbid_pattern ${rule.files}: /${rule.pattern}/${rule.message ? ` (${cut(rule.message, max)})` : ""}`;
    case "ai_review":
      return `ai_review ${rule.files}: ${cut(rule.question, max)} (advisory: a model reviews it, never refuses)`;
  }
}

const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/** `2026-10-18T03:15:00.000Z` as `03:15Z`. */
export const clock = (iso: string): string => `${iso.slice(11, 16)}Z`;

/** An ADR in one line: title, decision (cut at `max` characters when given), rules. */
export const adrLine = (adr: Adr, max = Number.POSITIVE_INFINITY): string => {
  const rules = adr.rules.length === 0 ? "" : ` Rules: ${adr.rules.map((r) => ruleLine(r, max)).join("; ")}.`;
  return `ADR-${adr.number} ${adr.title}: ${cut(adr.decision, max)}${rules}`;
};

export const leaseLine = (lease: Lease): string =>
  `${lease.symbol} leased to ${lease.holder.agent} (${lease.holder.developer}) until ${clock(lease.expiresAt)}${lease.reason ? `: ${lease.reason}` : ""}`;

const sameAuthor = (a: Author, b: Author): boolean => a.developer === b.developer && a.agent === b.agent;

/**
 * Whether this agent, working on `intentId`, holds the lease: as the server decides it. A lease
 * tied to an intent is that intent's, so the same person's other checkout (same developer and
 * agent name) does not hold it.
 */
export const holdsLease = (lease: Lease, me: Author, intentId: string | undefined): boolean =>
  sameAuthor(lease.holder, me) && (lease.intentId === undefined || lease.intentId === intentId);

/** ADRs in the brief before the rest is counted; decisions and questions are cut at this length. */
export const BRIEF_ADRS = 10;
export const BRIEF_TEXT = 240;

/**
 * What an agent is given when it declares an intent: the brain version, the accepted ADRs in one
 * line each (title, decision, rules), those whose rules cover the declared symbols' files first and
 * at most `BRIEF_ADRS` of them, and the live leases other agents hold on the symbols it declared.
 * Short on purpose: it lands in the agent's context at the start of every task.
 */
export function brainBrief(brain: Brain, declared: SymbolId[], me: Author, intentId?: string): string[] {
  const accepted = brain.adrs.filter((a) => a.status === "accepted");
  const lines: string[] = [];
  if (accepted.length === 0) {
    lines.push(`Brain v${brain.version}: no accepted ADRs.`);
  } else {
    const paths = [...new Set(declared.map((s) => s.slice(0, s.indexOf("#"))))];
    const relevant = (a: Adr) => a.rules.some((r) => paths.some((p) => matchGlob(r.files, p)));
    const shown = [...accepted.filter(relevant), ...accepted.filter((a) => !relevant(a))].slice(0, BRIEF_ADRS).sort((a, b) => a.number - b.number);
    const advisory = shown.some((a) => a.rules.some((r) => r.kind === "ai_review"));
    lines.push(`Brain v${brain.version}: a commit that breaks one of these rules is refused${advisory ? " (an advisory ai_review rule never refuses)" : ""}.`);
    lines.push(...shown.map((a) => adrLine(a, BRIEF_TEXT)));
    if (accepted.length > shown.length) lines.push(`+${accepted.length - shown.length} more ADRs: call the brain tool.`);
  }
  const wanted = new Set(declared);
  const blocked = brain.leases.filter((l) => wanted.has(l.symbol) && !holdsLease(l, me, intentId));
  if (blocked.length > 0) {
    lines.push(`Leased by another agent (your commit writing it is refused until it is released or expires): ${blocked.map(leaseLine).join("; ")}.`);
  }
  return lines;
}

/** The whole brain for the `brain` tool and `pitstop brain`: version, ADRs, leases, open intents. */
export function brainLines(brain: Brain, me: Author, intentId?: string): string[] {
  const accepted = brain.adrs.filter((a) => a.status === "accepted");
  const proposed = brain.adrs.filter((a) => a.status === "proposed");
  const lines = [`Brain v${brain.version} of ${brain.repo}: ${accepted.length} accepted ADR${accepted.length === 1 ? "" : "s"}, ${brain.leases.length} live lease${brain.leases.length === 1 ? "" : "s"}, ${brain.intents.length} open intent${brain.intents.length === 1 ? "" : "s"}.`];
  for (const adr of accepted) lines.push(adrLine(adr));
  for (const adr of proposed) lines.push(`(proposed, not enforced) ADR-${adr.number} ${adr.title}: ${adr.decision}`);
  for (const lease of brain.leases) lines.push(`Lease: ${leaseLine(lease)}${holdsLease(lease, me, intentId) ? " (yours)" : ""}`);
  for (const intent of brain.intents) {
    const symbols = intent.declaredSymbols.length === 0 ? "" : ` [${intent.declaredSymbols.join(", ")}]`;
    lines.push(`Intent ${intent.id} ${intent.author.agent}: ${intent.text}${symbols}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Globs, as the server reads them (server/src/adr-rules.ts): `**`, `*`, `?`, `{a,b}`, a trailing
// `/`. Matched without regular expressions (a set of positions per token), so an ADR's glob can
// never stall the daemon; only to rank ADRs in the brief.

type GlobToken = { kind: "lit"; c: string } | { kind: "one" } | { kind: "star" } | { kind: "any" } | { kind: "segs" };

/** `{a,b}` expanded, at most 64 alternatives; unbalanced braces stay literal. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf("{");
  if (open < 0) return [glob];
  let depth = 0;
  const commas: number[] = [];
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth += 1;
    else if (glob[i] === "}" && --depth === 0) {
      close = i;
      break;
    } else if (glob[i] === "," && depth === 1) commas.push(i);
  }
  if (close < 0) return [glob];
  const cuts = [open, ...commas, close];
  const head = glob.slice(0, open);
  const tail = expandBraces(glob.slice(close + 1));
  const out: string[] = [];
  for (let k = 0; k + 1 < cuts.length && out.length < 64; k++) {
    for (const middle of expandBraces(glob.slice((cuts[k] as number) + 1, cuts[k + 1]))) for (const rest of tail) out.push(`${head}${middle}${rest}`);
  }
  return out.slice(0, 64);
}

function globTokens(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  for (let i = 0; i < glob.length; ) {
    if (glob[i] === "*" && glob[i + 1] === "*") {
      let j = i;
      while (glob[j] === "*") j += 1;
      if (glob[j] === "/") {
        tokens.push({ kind: "segs" });
        i = j + 1;
      } else {
        tokens.push({ kind: "any" });
        i = j;
      }
    } else if (glob[i] === "*") {
      tokens.push({ kind: "star" });
      i += 1;
    } else if (glob[i] === "?") {
      tokens.push({ kind: "one" });
      i += 1;
    } else {
      tokens.push({ kind: "lit", c: glob[i] as string });
      i += 1;
    }
  }
  return tokens;
}

function matchTokens(tokens: GlobToken[], path: string): boolean {
  let at = new Set([0]);
  for (const t of tokens) {
    const next = new Set<number>();
    for (const p of at) {
      if (t.kind === "lit") {
        if (path[p] === t.c) next.add(p + 1);
      } else if (t.kind === "one") {
        if (p < path.length && path[p] !== "/") next.add(p + 1);
      } else if (t.kind === "star") {
        let q = p;
        next.add(q);
        while (q < path.length && path[q] !== "/") next.add(++q);
      } else if (t.kind === "any") {
        for (let q = p; q <= path.length; q++) next.add(q);
      } else {
        next.add(p);
        for (let q = p; q < path.length; q++) if (path[q] === "/") next.add(q + 1);
      }
    }
    if (next.size === 0) return false;
    at = next;
  }
  return at.has(path.length);
}

/** Whether a repository path matches an ADR rule's glob. */
export function matchGlob(glob: string, path: string): boolean {
  let g = glob.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (g.endsWith("/")) g += "**";
  const p = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return expandBraces(g).some((alt) => matchTokens(globTokens(alt), p));
}

export interface LeaseAsk {
  symbol: SymbolId;
  holder: Author;
  reason?: string;
  ttlSeconds?: number;
  intentId?: string;
}
/**
 * What a lease request came to. `leased`: another agent holds it (the only answer that means
 * "leave it alone"). `not_held`: a release found no lease of yours. `invalid`: the request
 * cannot be served as asked (no open intent, a stale one, a bad time to live…), with the reason.
 */
export type LeaseAnswer =
  | { status: "held"; lease: Lease; renewed: boolean; message: string }
  | { status: "leased"; lease?: Lease; message: string }
  | { status: "released"; lease: Lease; message: string }
  | { status: "not_held"; message: string }
  | { status: "invalid"; message: string };

/** `POST /repos/:o/:n/leases`: the lease, or who holds it. */
export async function takeLease(a: ServerAccess, ask: LeaseAsk): Promise<LeaseAnswer> {
  const res = await (a.fetch ?? fetch)(repoUrl(a, "/leases"), {
    method: "POST",
    headers: serverHeaders(a.token, true),
    body: JSON.stringify({
      symbol: ask.symbol,
      agent: ask.holder.agent,
      developer: ask.holder.developer,
      reason: ask.reason ?? "",
      ...(ask.ttlSeconds === undefined ? {} : { ttlSeconds: ask.ttlSeconds }),
      ...(ask.intentId === undefined ? {} : { intentId: ask.intentId }),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { lease?: unknown; renewed?: boolean; message?: string; error?: string };
  if (res.status === 409) {
    const lease = Lease.safeParse(body.lease);
    return { status: "leased", ...(lease.success ? { lease: lease.data } : {}), message: body.message ?? `${ask.symbol} is leased to another agent` };
  }
  if (!res.ok) return { status: "invalid", message: `${body.message ?? body.error ?? `the server answered ${res.status}`}` };
  const lease = Lease.parse(body.lease);
  const renewed = body.renewed === true;
  return { status: "held", lease, renewed, message: `${lease.symbol} is yours until ${clock(lease.expiresAt)}${renewed ? " (renewed)" : ""}` };
}

/**
 * `DELETE /repos/:o/:n/leases?symbol=&agent=&developer=&intentId=`: this agent's own lease only.
 * The developer goes too: every daemon's agent may have the same name.
 */
export async function releaseLease(a: ServerAccess, symbol: SymbolId, me: Author, intentId?: string): Promise<LeaseAnswer> {
  const url = repoUrl(a, "/leases");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("agent", me.agent);
  url.searchParams.set("developer", me.developer);
  if (intentId !== undefined) url.searchParams.set("intentId", intentId);
  const res = await (a.fetch ?? fetch)(url, { method: "DELETE", headers: serverHeaders(a.token) });
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (res.status === 404) return { status: "not_held", message: body.message ?? `nobody holds a lease on ${symbol}` };
  if (res.status === 403) return { status: "leased", message: body.message ?? `${symbol} is another agent's` };
  if (!res.ok) return { status: "invalid", message: body.message ?? body.error ?? `the server answered ${res.status}` };
  const lease = Lease.parse(body);
  return { status: "released", lease, message: `released ${lease.symbol}` };
}

/** An entry as the query API answers it (server/src/brain.ts, `entryView`). */
export const QueryEntry = z.object({
  lsn: z.number(),
  intent: z.string(),
  intentId: z.string().optional(),
  author: z.object({ developer: z.string(), agent: z.string() }),
  createdAt: z.string(),
  brainVersion: z.number(),
  files: z.array(z.object({ path: z.string(), op: z.string(), fromPath: z.string().optional() })),
  repairs: z.array(z.string()),
  details: z.string().optional(),
});
export type QueryEntry = z.infer<typeof QueryEntry>;

export const History = z.object({
  symbol: z.string(),
  history: z.array(QueryEntry.extend({ signature: z.boolean() })),
  declaredBy: z.array(z.object({ id: z.string(), text: z.string(), author: z.object({ developer: z.string(), agent: z.string() }) })),
  lease: Lease.optional(),
});
export type History = z.infer<typeof History>;

export const Callers = z.object({
  symbol: z.string(),
  derivedFrom: z.string(),
  callers: z.array(QueryEntry.extend({ wrote: z.array(z.string()) })),
});
export type Callers = z.infer<typeof Callers>;

export const Why = z.object({ path: z.string(), entries: z.array(QueryEntry.extend({ op: z.string() })) });
export type Why = z.infer<typeof Why>;

// The symbol goes in the query string, not the path: a proxy in front of the server (Azure
// Container Apps' ingress) rewrites an encoded `/` in a path, and every symbol id holds one.
export async function symbolHistory(a: ServerAccess, symbol: SymbolId, limit = 20): Promise<History> {
  return History.parse(await get(a, `/history?symbol=${encodeURIComponent(symbol)}&limit=${limit}`));
}

export async function symbolCallers(a: ServerAccess, symbol: SymbolId, limit = 20): Promise<Callers> {
  return Callers.parse(await get(a, `/callers?symbol=${encodeURIComponent(symbol)}&limit=${limit}`));
}

export async function whyPath(a: ServerAccess, path: string, limit = 5): Promise<Why> {
  return Why.parse(await get(a, `/why?path=${encodeURIComponent(path)}&limit=${limit}`));
}
