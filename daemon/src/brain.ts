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

/** One rule in one line, the way the server's refusals name it. */
export function ruleLine(rule: AdrRule): string {
  switch (rule.kind) {
    case "forbid_import":
      return `forbid_import ${rule.files} -> ${rule.target}`;
    case "forbid_call":
      return `forbid_call ${rule.files}: ${rule.call}()`;
    case "forbid_pattern":
      return `forbid_pattern ${rule.files}: /${rule.pattern}/${rule.message ? ` (${rule.message})` : ""}`;
    case "ai_review":
      return `ai_review ${rule.files}: ${rule.question}`;
  }
}

/** `2026-10-18T03:15:00.000Z` as `03:15Z`. */
export const clock = (iso: string): string => `${iso.slice(11, 16)}Z`;

export const adrLine = (adr: Adr): string => {
  const rules = adr.rules.length === 0 ? "" : ` Rules: ${adr.rules.map(ruleLine).join("; ")}.`;
  return `ADR-${adr.number} ${adr.title}: ${adr.decision}${rules}`;
};

export const leaseLine = (lease: Lease): string =>
  `${lease.symbol} leased to ${lease.holder.agent} (${lease.holder.developer}) until ${clock(lease.expiresAt)}${lease.reason ? `: ${lease.reason}` : ""}`;

const isMine = (lease: Lease, me: Author): boolean => lease.holder.developer === me.developer && lease.holder.agent === me.agent;

/**
 * What an agent is given when it declares an intent: the brain version, each accepted ADR in one
 * line (title, decision, rules), and the live leases other agents hold on the symbols it
 * declared. Short on purpose: it lands in the agent's context.
 */
export function brainBrief(brain: Brain, declared: SymbolId[], me: Author): string[] {
  const accepted = brain.adrs.filter((a) => a.status === "accepted");
  const lines =
    accepted.length === 0
      ? [`Brain v${brain.version}: no accepted ADRs.`]
      : [`Brain v${brain.version}: a commit that breaks one of these rules is refused.`, ...accepted.map(adrLine)];
  const wanted = new Set(declared);
  const blocked = brain.leases.filter((l) => wanted.has(l.symbol) && !isMine(l, me));
  if (blocked.length > 0) {
    lines.push(`Leased by another agent (your commit writing it is refused until it is released or expires): ${blocked.map(leaseLine).join("; ")}.`);
  }
  return lines;
}

/** The whole brain for the `brain` tool and `pitstop brain`: version, ADRs, leases, open intents. */
export function brainLines(brain: Brain, me: Author): string[] {
  const accepted = brain.adrs.filter((a) => a.status === "accepted");
  const proposed = brain.adrs.filter((a) => a.status === "proposed");
  const lines = [`Brain v${brain.version} of ${brain.repo}: ${accepted.length} accepted ADR${accepted.length === 1 ? "" : "s"}, ${brain.leases.length} live lease${brain.leases.length === 1 ? "" : "s"}, ${brain.intents.length} open intent${brain.intents.length === 1 ? "" : "s"}.`];
  for (const adr of accepted) lines.push(adrLine(adr));
  for (const adr of proposed) lines.push(`(proposed, not enforced) ADR-${adr.number} ${adr.title}: ${adr.decision}`);
  for (const lease of brain.leases) lines.push(`Lease: ${leaseLine(lease)}${isMine(lease, me) ? " (yours)" : ""}`);
  for (const intent of brain.intents) {
    const symbols = intent.declaredSymbols.length === 0 ? "" : ` [${intent.declaredSymbols.join(", ")}]`;
    lines.push(`Intent ${intent.id} ${intent.author.agent}: ${intent.text}${symbols}`);
  }
  return lines;
}

export interface LeaseAsk {
  symbol: SymbolId;
  holder: Author;
  reason?: string;
  ttlSeconds?: number;
  intentId?: string;
}
export type LeaseAnswer =
  | { status: "held"; lease: Lease; renewed: boolean; message: string }
  | { status: "refused"; lease?: Lease; message: string }
  | { status: "released"; lease: Lease; message: string };

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
    return { status: "refused", ...(lease.success ? { lease: lease.data } : {}), message: body.message ?? `${ask.symbol} is leased to another agent` };
  }
  if (!res.ok) return { status: "refused", message: `the server refused the lease (${res.status}): ${body.message ?? body.error ?? ""}`.trim() };
  const lease = Lease.parse(body.lease);
  const renewed = body.renewed === true;
  return { status: "held", lease, renewed, message: `${lease.symbol} is yours until ${clock(lease.expiresAt)}${renewed ? " (renewed)" : ""}` };
}

/** `DELETE /repos/:o/:n/leases?symbol=&agent=`: this agent's own lease only. */
export async function releaseLease(a: ServerAccess, symbol: SymbolId, me: Author): Promise<LeaseAnswer> {
  const url = repoUrl(a, "/leases");
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("agent", me.agent);
  const res = await (a.fetch ?? fetch)(url, { method: "DELETE", headers: serverHeaders(a.token) });
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) return { status: "refused", message: body.message ?? `the server answered ${res.status}` };
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

export async function symbolHistory(a: ServerAccess, symbol: SymbolId, limit = 20): Promise<History> {
  return History.parse(await get(a, `/symbols/${encodeURIComponent(symbol)}/history?limit=${limit}`));
}

export async function symbolCallers(a: ServerAccess, symbol: SymbolId, limit = 20): Promise<Callers> {
  return Callers.parse(await get(a, `/symbols/${encodeURIComponent(symbol)}/callers?limit=${limit}`));
}

export async function whyPath(a: ServerAccess, path: string, limit = 5): Promise<Why> {
  return Why.parse(await get(a, `/why?path=${encodeURIComponent(path)}&limit=${limit}`));
}
