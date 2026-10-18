import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CommitResponse, ServerMessage, type Adr, type CommitRequest, type Intent, type Lease } from "@pitstop/protocol";
import { buildApp, type AppDeps } from "./app.js";
import type { OAuthProvider } from "./auth.js";
import type { Reviewer } from "./review.js";
import { MemoryStore } from "./store.js";

const REPO = "acme/app";
const alice = { developer: "alice", agent: "agent-a" };
const bob = { developer: "bob", agent: "agent-b" };

let n = 0;
const commitBody = (extra: Partial<CommitRequest>): CommitRequest => ({
  idempotencyKey: `brain-test-${++n}-${Date.now()}`,
  repo: REPO,
  baseLsn: 0,
  author: alice,
  intent: "change",
  files: [],
  writeSet: [],
  sigWriteSet: [],
  readSet: [],
  ...extra,
});

/** The repository the tests start from: a page reading through a service, the service on the database. */
const importRepo: Partial<CommitRequest> = {
  intent: "import",
  files: [
    { path: "src/db/client.ts", op: "add", content: "export const db = { query: (sql: string) => sql };\n" },
    { path: "src/services/users.ts", op: "add", content: 'import { db } from "../db/client.js";\nexport const getUser = () => db.query("select 1");\n' },
    { path: "src/auth/session.ts", op: "add", content: "export function getCurrentUser() { return null; }\n" },
  ],
  writeSet: ["src/db/client.ts#db", "src/services/users.ts#getUser", "src/auth/session.ts#getCurrentUser"],
};
const pagesAdr = {
  title: "Pages never touch the database",
  decision: "Pages read data through src/services, never from src/db directly.",
  reason: "One place owns queries, caching and access checks.",
  rules: [
    { kind: "forbid_import", files: "src/pages/**", target: "src/db/**" },
    { kind: "forbid_call", files: "src/pages/**", call: "db.query" },
  ],
};

/** Collects parsed server messages so a test can wait for the one it expects. */
class Inbox {
  readonly messages: ServerMessage[] = [];
  private readonly waiting: (() => void)[] = [];
  constructor(readonly socket: WebSocket) {
    socket.addEventListener("message", (ev) => {
      this.messages.push(ServerMessage.parse(JSON.parse(String(ev.data))));
      for (const wake of this.waiting.splice(0)) wake();
    });
  }
  /** The first message (taken out of the inbox) that `match` accepts. */
  async take<T extends ServerMessage>(match: (m: ServerMessage) => m is T): Promise<T>;
  async take(match: (m: ServerMessage) => boolean): Promise<ServerMessage>;
  async take(match: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    const deadline = Date.now() + 3_000;
    for (;;) {
      const at = this.messages.findIndex(match);
      if (at >= 0) return this.messages.splice(at, 1)[0] as ServerMessage;
      if (Date.now() > deadline) throw new Error(`no such message; got ${JSON.stringify(this.messages.map((m) => m.type))}`);
      await new Promise<void>((wake) => {
        this.waiting.push(wake);
        setTimeout(wake, 50);
      });
    }
  }
}

const isBrain = (m: ServerMessage): m is Extract<ServerMessage, { type: "brain" }> => m.type === "brain";
const isLease = (m: ServerMessage): m is Extract<ServerMessage, { type: "lease" }> => m.type === "lease";
const isIntent = (m: ServerMessage): m is Extract<ServerMessage, { type: "intent" }> => m.type === "intent";
const isWarning = (m: ServerMessage): m is Extract<ServerMessage, { type: "warning" }> => m.type === "warning";

describe("the brain", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  /** A listening server with REPO created and imported, and a socket subscribed to it. */
  const start = async (extra: Partial<AppDeps> = {}, imported = true) => {
    const store = new MemoryStore();
    let offsetMs = 0;
    const app = await buildApp({ version: "test", pingDb: async () => true, store, sweepMs: 0, now: () => new Date(Date.now() + offsetMs), ...extra });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const headers = extra.token === undefined ? {} : { authorization: `Bearer ${extra.token}` };
    await app.inject({ method: "POST", url: "/repos", payload: { id: REPO }, headers });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/stream`, { headers });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const inbox = new Inbox(socket);
    socket.send(JSON.stringify({ type: "subscribe", repo: REPO, fromLsn: 0 }));
    await inbox.take((m) => m.type === "head");
    cleanup = async () => {
      socket.close();
      await app.close();
    };
    const call = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) => {
      const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
      return { status: res.statusCode, body: res.json() as Record<string, unknown> & unknown[] };
    };
    const commit = async (extraBody: Partial<CommitRequest>) => {
      const res = await app.inject({ method: "POST", url: "/commit", headers, payload: commitBody(extraBody) });
      return { status: res.statusCode, body: CommitResponse.parse(res.json()) };
    };
    if (imported) expect((await commit(importRepo)).status).toBe(200);
    return { app, store, inbox, call, commit, shift: (ms: number) => (offsetMs = ms) };
  };
  const accepted = (r: { body: CommitResponse }) => {
    if (r.body.status !== "accepted") throw new Error(`expected accepted, got ${JSON.stringify(r.body)}`);
    return r.body.changeset;
  };
  const refusal = (r: { body: CommitResponse }) => {
    if (r.body.status !== "rejected") throw new Error(`expected rejected, got ${JSON.stringify(r.body)}`);
    return r.body;
  };

  it("a writer proposes, an owner accepts, rejects and supersedes; every change is broadcast with the version after it", async () => {
    const { call, inbox } = await start();
    const proposed = await call("POST", `/repos/${REPO}/adrs`, pagesAdr);
    expect(proposed.status).toBe(201);
    expect(proposed.body).toMatchObject({ number: 1, status: "proposed", version: 0, createdBy: "admin", rules: pagesAdr.rules });
    expect(await inbox.take(isBrain)).toMatchObject({ version: 0, adr: { number: 1, status: "proposed" } });

    const bad = await call("POST", `/repos/${REPO}/adrs`, { title: "t", decision: "d", rules: [{ kind: "forbid_pattern", files: "**", pattern: "(a+)+" }] });
    expect(bad).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(bad.body.message).toMatch(/nested quantifiers/);
    expect((await call("POST", `/repos/${REPO}/adrs`, { title: "no decision" })).status).toBe(400);

    expect(await call("POST", `/repos/${REPO}/adrs/1/accept`)).toMatchObject({ status: 200, body: { version: 1, adr: { status: "accepted", version: 1, decidedBy: "admin" } } });
    expect(await inbox.take(isBrain)).toMatchObject({ version: 1, adr: { number: 1, status: "accepted" } });
    expect(await call("POST", `/repos/${REPO}/adrs/1/accept`)).toMatchObject({ status: 409, body: { error: "invalid_transition" } });
    expect((await call("POST", `/repos/${REPO}/adrs/7/accept`)).status).toBe(404);

    await call("POST", `/repos/${REPO}/adrs`, { title: "Second", decision: "No.", by: "bob" });
    expect(await call("POST", `/repos/${REPO}/adrs/2/reject`)).toMatchObject({ status: 200, body: { version: 1, adr: { status: "rejected" } } });
    const brain = await call("GET", `/repos/${REPO}/brain`);
    expect(brain.body).toMatchObject({ repo: REPO, version: 1, leases: [], intents: [] });
    expect((brain.body.adrs as unknown as Adr[]).map((a) => [a.number, a.status, a.createdBy])).toEqual([[1, "accepted", "admin"], [2, "rejected", "bob"]]); // the shared token's word for who proposed

    expect(await call("POST", `/repos/${REPO}/adrs/1/supersede`)).toMatchObject({ status: 200, body: { version: 2, adr: { status: "superseded", version: 2 } } });
    expect(((await call("GET", `/repos/${REPO}/brain/at?version=1`)).body.adrs as unknown as Adr[]).map((a) => a.number)).toEqual([1]);
    expect((await call("GET", `/repos/${REPO}/brain/at?version=2`)).body.adrs).toEqual([]);
    expect((await call("GET", `/repos/${REPO}/adrs`)).body).toHaveLength(2);
  });

  it("refuses a commit that breaks an ADR with the file, the line and what to do instead; a compliant one lands with checks.adr pass and the brain version", async () => {
    const { call, commit } = await start();
    await call("POST", `/repos/${REPO}/adrs`, pagesAdr);
    await call("POST", `/repos/${REPO}/adrs/1/accept`);

    const bad = await commit({
      baseLsn: 1,
      intent: "Show the user on the profile page",
      files: [{ path: "src/pages/ProfilePage.tsx", op: "add", content: '// the profile\nimport { db } from "../db/client";\nexport const Profile = () => db.query("select *");\n' }],
      writeSet: ["src/pages/ProfilePage.tsx#Profile"],
    });
    expect(bad.status).toBe(409);
    const body = refusal(bad);
    expect(body.reason).toBe("constraint_failed");
    expect(body.message).toContain(
      'ADR-1 "Pages never touch the database": src/pages/ProfilePage.tsx:2 imports src/db/client.ts, which the rule forbid_import src/pages/** -> src/db/** forbids; src/pages/ProfilePage.tsx:3 calls db.query(), which the rule forbid_call src/pages/**: db.query() forbids. Do instead: Pages read data through src/services, never from src/db directly.',
    );
    expect(body.message).toMatch(/^refused by this repository's architecture decisions \(brain v1\)/);

    const good = accepted(
      await commit({
        baseLsn: 1,
        intent: "Show the user on the profile page",
        files: [{ path: "src/pages/ProfilePage.tsx", op: "add", content: 'import { getUser } from "../services/users.js";\nexport const Profile = () => getUser();\n' }],
        writeSet: ["src/pages/ProfilePage.tsx#Profile"],
      }),
    );
    expect(good.brainVersion).toBe(1);
    expect(good.checks).toMatchObject({ adr: "pass", typecheck: "skipped" });
    expect(good.checks.details).toMatch(/ADR rules held \(brain v1, 2 rules\)/);

    const notes = accepted(await commit({ baseLsn: 2, intent: "notes", files: [{ path: "NOTES.md", op: "add", content: "import x from 'src/db/client'\n" }] }));
    expect(notes).toMatchObject({ brainVersion: 1, checks: { adr: "skipped" } });
    expect(notes.checks.details).toBeUndefined();

    // What the rules said when each entry was written.
    expect(await call("GET", `/repos/${REPO}/brain/at?lsn=1`)).toMatchObject({ body: { lsn: 1, version: 0, adrs: [] } });
    expect(((await call("GET", `/repos/${REPO}/brain/at?lsn=2`)).body.adrs as unknown as Adr[]).map((a) => a.number)).toEqual([1]);
    expect((await call("GET", `/repos/${REPO}/brain/at?lsn=99`)).status).toBe(404);
  });

  it("runs ai_review rules only with a model, as advice that never refuses", async () => {
    const asked: string[] = [];
    const reviewer: Reviewer = {
      review: async (input) => {
        asked.push(`${input.adr.number}:${input.files.map((f) => f.path).join(",")}`);
        return "The expiry check is still there.";
      },
    };
    const review = { title: "Sessions expire", decision: "An expired session is never returned.", rules: [{ kind: "ai_review", files: "src/auth/**", question: "Are expired sessions kept out?" }] };

    const without = await start();
    await without.call("POST", `/repos/${REPO}/adrs`, review);
    await without.call("POST", `/repos/${REPO}/adrs/1/accept`);
    const plain = accepted(await without.commit({ baseLsn: 1, files: [{ path: "src/auth/session.ts", op: "modify", content: "export function getCurrentUser() { return undefined; }\n" }] }));
    expect(plain.checks).toMatchObject({ adr: "skipped", details: "ADR-1 ai_review not run (no model configured: GROQ_API_KEY): Are expired sessions kept out?" });
    await cleanup?.();
    cleanup = undefined;

    const withModel = await start({ reviewer });
    await withModel.call("POST", `/repos/${REPO}/adrs`, review);
    await withModel.call("POST", `/repos/${REPO}/adrs/1/accept`);
    const reviewed = accepted(await withModel.commit({ baseLsn: 1, files: [{ path: "src/auth/session.ts", op: "modify", content: "export function getCurrentUser() { return undefined; }\n" }] }));
    expect(reviewed.checks.details).toBe("ADR-1 review of src/auth/session.ts (advisory): The expiry check is still there.");
    accepted(await withModel.commit({ baseLsn: 2, files: [{ path: "README.md", op: "add", content: "hi\n" }] }));
    expect(asked).toEqual(["1:src/auth/session.ts"]);
  });

  it("re-checks the tree at head and queues the entries validated before the rule existed", async () => {
    const { call, commit } = await start();
    const old = accepted(await commit({ baseLsn: 1, intent: "the old page", files: [{ path: "src/pages/Old.tsx", op: "add", content: 'import { db } from "../db/client.js";\nexport const Old = 1;\n' }] }));
    expect(old.brainVersion).toBe(0);
    expect((await call("GET", `/repos/${REPO}/brain/recheck`)).body).toMatchObject({ version: 0, violations: [], queue: [] });
    await call("POST", `/repos/${REPO}/adrs`, pagesAdr);
    await call("POST", `/repos/${REPO}/adrs/1/accept`);
    const recheck = await call("GET", `/repos/${REPO}/brain/recheck`);
    expect(recheck.body).toMatchObject({
      repo: REPO,
      head: 2,
      version: 1,
      checkedFiles: 4,
      violations: [{ adr: 1, title: "Pages never touch the database", rule: "forbid_import src/pages/** -> src/db/**", file: "src/pages/Old.tsx", line: 1, detail: "imports src/db/client.ts" }],
      queue: [{ lsn: 2, intent: "the old page", brainVersion: 0, files: ["src/pages/Old.tsx"], adrs: [1] }],
    });
  });

  it("leases a symbol to one agent: a second is refused, so is its commit writing it, and the holder's commit releases it", async () => {
    const { call, commit, inbox } = await start();
    const symbol = "src/auth/session.ts#getCurrentUser";
    const intent = (await call("POST", "/intents", { repo: REPO, author: alice, baseLsn: 1, text: "Fix the expired-session bug", declaredSymbols: [symbol] })).body as unknown as Intent;
    const taken = await call("POST", `/repos/${REPO}/leases`, { symbol, agent: "agent-a", developer: "alice", intentId: intent.id, reason: "changing its return type", ttlSeconds: 600 });
    expect(taken).toMatchObject({ status: 201, body: { renewed: false, lease: { symbol, holder: alice, intentId: intent.id, status: "held" } } });
    expect(await inbox.take(isLease)).toMatchObject({ lease: { symbol, status: "held" } });

    const second = await call("POST", `/repos/${REPO}/leases`, { symbol, agent: "agent-b", developer: "bob", reason: "me too" });
    expect(second).toMatchObject({ status: 409, body: { error: "leased", lease: { holder: alice } } });
    expect(second.body.message).toMatch(new RegExp(`^${symbol} is leased to agent-a \\(alice\\) for intent ${intent.id} until .+: changing its return type$`));
    expect((await call("POST", `/repos/${REPO}/leases`, { symbol, agent: "agent-a", developer: "alice", intentId: intent.id, reason: "still" })).status).toBe(200);
    expect((await call("POST", `/repos/${REPO}/leases`, { symbol: "not a symbol", agent: "a" })).status).toBe(400);
    expect((await call("POST", `/repos/${REPO}/leases`, { symbol, agent: "a", ttlSeconds: 5 })).status).toBe(400);
    expect(((await call("GET", `/repos/${REPO}/leases`)).body as unknown as Lease[]).map((l) => l.holder.agent)).toEqual(["agent-a"]);

    const blocked = refusal(await commit({ baseLsn: 1, author: bob, intent: "Rename getCurrentUser", files: [{ path: "src/auth/session.ts", op: "modify", content: "export function currentUser() { return null; }\n" }], writeSet: [symbol], sigWriteSet: [symbol] }));
    expect(blocked.reason).toBe("constraint_failed");
    expect(blocked.message).toContain(`${symbol} is leased to agent-a (alice) for intent ${intent.id} "Fix the expired-session bug" until `);
    expect(blocked.message).toContain(": still. ");

    const landed = accepted(await commit({ baseLsn: 1, author: alice, intentId: intent.id, intent: "Fix the expired-session bug", files: [{ path: "src/auth/session.ts", op: "modify", content: "export function getCurrentUser(): null { return null; }\n" }], writeSet: [symbol], sigWriteSet: [symbol] }));
    expect(landed.lsn).toBe(2);
    expect(await inbox.take(isIntent)).toMatchObject({ intent: { id: intent.id, status: "open" } }); // the declaration
    expect(await inbox.take(isIntent)).toMatchObject({ intent: { id: intent.id, status: "committed" } });
    await inbox.take((m) => isLease(m) && m.lease.status === "held"); // the renewal
    expect(await inbox.take((m): m is Extract<ServerMessage, { type: "lease" }> => isLease(m) && m.lease.status !== "held")).toMatchObject({ lease: { symbol, status: "released" } });
    expect((await call("GET", `/repos/${REPO}/leases`)).body).toEqual([]);
    accepted(await commit({ baseLsn: 2, author: bob, intent: "Rename getCurrentUser", files: [{ path: "src/auth/session.ts", op: "modify", content: "export function currentUser() { return null; }\n" }], writeSet: [symbol], sigWriteSet: [symbol] }));
  });

  it("releases a lease for its holder or an owner, never for another agent", async () => {
    const { call } = await start({ token: "s3cret" });
    const symbol = "src/a.ts#a";
    await call("POST", `/repos/${REPO}/leases`, { symbol, agent: "agent-a", developer: "alice" });
    const url = (extra: string) => `/repos/${REPO}/leases?symbol=${encodeURIComponent(symbol)}${extra}`;
    expect(await call("DELETE", url("&agent=agent-b"))).toMatchObject({ status: 403 });
    expect(await call("DELETE", url("&agent=agent-a"))).toMatchObject({ status: 200, body: { status: "released", holder: alice } });
    expect(await call("DELETE", url(""))).toMatchObject({ status: 404 });
    await call("POST", `/repos/${REPO}/leases`, { symbol, agent: "agent-a", developer: "alice" });
    expect(await call("DELETE", url(""))).toMatchObject({ status: 200 }); // the administrator
    expect((await call("DELETE", `/repos/${REPO}/leases?symbol=nope`)).status).toBe(400);
  });

  it("sweeps: quiet intents go stale and lose their leases, leases past their expiry expire, everything broadcast", async () => {
    const { app, call, inbox, shift } = await start();
    const intent = (await call("POST", "/intents", { repo: REPO, author: alice, baseLsn: 1, text: "went quiet", declaredSymbols: [] })).body as unknown as Intent;
    await call("POST", `/repos/${REPO}/leases`, { symbol: "src/a.ts#a", agent: "agent-a", developer: "alice", intentId: intent.id, ttlSeconds: 1800 });
    await call("POST", `/repos/${REPO}/leases`, { symbol: "src/c.ts#c", agent: "agent-c", developer: "carol", ttlSeconds: 60 });
    const ended = (m: ServerMessage): m is Extract<ServerMessage, { type: "lease" }> => isLease(m) && m.lease.status !== "held";

    shift(2 * 60_000);
    expect(await app.brainSweep()).toMatchObject({ stale: [], ended: [{ symbol: "src/c.ts#c", status: "expired" }] });
    expect(await inbox.take(ended)).toMatchObject({ lease: { symbol: "src/c.ts#c", status: "expired" } });

    shift(6 * 60_000);
    const swept = await app.brainSweep();
    expect(swept.stale).toEqual([expect.objectContaining({ id: intent.id, status: "stale" })]);
    expect(swept.ended).toEqual([expect.objectContaining({ symbol: "src/a.ts#a", status: "released" })]);
    expect(await inbox.take((m) => isIntent(m) && m.intent.status !== "open")).toMatchObject({ intent: { id: intent.id, status: "stale" } });
    expect(await inbox.take(ended)).toMatchObject({ lease: { symbol: "src/a.ts#a", status: "released" } });
    expect((await call("GET", `/repos/${REPO}/brain`)).body).toMatchObject({ leases: [], intents: [] });
  });

  it("renews an intent's leases when its heartbeat arrives on the stream", async () => {
    const { call, inbox, shift } = await start();
    const intent = (await call("POST", "/intents", { repo: REPO, author: alice, baseLsn: 1, text: "busy", declaredSymbols: [] })).body as unknown as Intent;
    shift(-50_000); // taken 50 s ago, for 60 s: 10 s left
    const taken = (await call("POST", `/repos/${REPO}/leases`, { symbol: "src/a.ts#a", agent: "agent-a", developer: "alice", intentId: intent.id, ttlSeconds: 60 })).body as unknown as { lease: Lease };
    shift(0);
    inbox.socket.send(JSON.stringify({ type: "heartbeat", intentId: intent.id, appliedLsn: 1 }));
    let lease: Lease | undefined;
    for (let i = 0; i < 100; i++) {
      [lease] = (await call("GET", `/repos/${REPO}/leases`)).body as unknown as Lease[];
      if (lease !== undefined && lease.expiresAt !== taken.lease.expiresAt) break;
      await new Promise((wake) => setTimeout(wake, 10));
    }
    expect(Date.parse(lease?.expiresAt ?? "")).toBeGreaterThan(Date.parse(taken.lease.expiresAt) + 40_000);
  });

  it("broadcasts a plain escalation as a warning, as a parked one is", async () => {
    const { commit, inbox } = await start({ repair: "agent" });
    accepted(await commit({ baseLsn: 1, intent: "auth fix", files: [{ path: "src/auth/session.ts", op: "modify", content: "export function getCurrentUser(): null { return null; }\n" }], writeSet: ["src/auth/session.ts#getCurrentUser"], sigWriteSet: ["src/auth/session.ts#getCurrentUser"] }));
    const skewed = refusal(await commit({ baseLsn: 1, author: bob, intent: "profile", files: [{ path: "src/pages/P.tsx", op: "add", content: "x\n" }], readSet: ["src/auth/session.ts#getCurrentUser"] }));
    expect(skewed.reason).toBe("escalated");
    expect(await inbox.take(isWarning)).toMatchObject({
      agent: "agent-b",
      kind: "dependency_changed",
      message: '"profile" by bob went back to agent-b to adapt: write skew, #2 changed src/auth/session.ts#getCurrentUser (signature)',
      symbols: ["src/auth/session.ts#getCurrentUser"],
    });
  });

  it("answers the query API: symbols, a symbol's history and callers, why a path is so, and the log by path glob", async () => {
    const { call, commit } = await start();
    const symbol = "src/auth/session.ts#getCurrentUser";
    const intent = (await call("POST", "/intents", { repo: REPO, author: alice, baseLsn: 1, text: "fix auth", declaredSymbols: [symbol] })).body as unknown as Intent;
    accepted(await commit({ baseLsn: 1, intentId: intent.id, intent: "fix auth", files: [{ path: "src/auth/session.ts", op: "modify", content: "export function getCurrentUser(): null { return null; }\n" }], writeSet: [symbol], sigWriteSet: [symbol] }));
    accepted(await commit({ baseLsn: 2, author: bob, intent: "profile page", files: [{ path: "src/pages/Profile.tsx", op: "add", content: "x\n" }], writeSet: ["src/pages/Profile.tsx#Profile"], readSet: [symbol] }));
    const enc = encodeURIComponent(symbol);

    const symbols = await call("GET", `/repos/${REPO}/symbols?prefix=src/auth/`);
    expect(symbols.body.symbols).toEqual([expect.objectContaining({ symbol, lsn: 2, signature: true, intent: "fix auth", intentId: intent.id, author: alice })]);
    expect(((await call("GET", `/repos/${REPO}/symbols`)).body.symbols as unknown[]).length).toBe(4);

    const history = await call("GET", `/repos/${REPO}/symbols/${enc}/history`);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ symbol, declaredBy: [] });
    expect((history.body.history as unknown as { lsn: number; signature: boolean; intentId?: string }[]).map((h) => [h.lsn, h.signature, h.intentId ?? null])).toEqual([[2, true, intent.id], [1, false, null]]);
    expect((history.body.history as unknown as { files: unknown[] }[])[0]?.files).toEqual([{ path: "src/auth/session.ts", op: "modify" }]);

    const callers = await call("GET", `/repos/${REPO}/symbols/${enc}/callers`);
    expect(callers.body.derivedFrom).toMatch(/read sets.*not a parsed call graph/);
    expect(callers.body.callers).toEqual([expect.objectContaining({ lsn: 3, intent: "profile page", author: bob, wrote: ["src/pages/Profile.tsx#Profile"] })]);

    const why = await call("GET", `/repos/${REPO}/why?path=src/auth/session.ts`);
    expect((why.body.entries as unknown as { lsn: number; op: string }[]).map((e) => [e.lsn, e.op])).toEqual([[2, "modify"], [1, "add"]]);
    expect((await call("GET", `/repos/${REPO}/why`)).status).toBe(400);

    const log = await call("GET", `/log?repo=${REPO}&touches=${encodeURIComponent("src/pages/**")}&since=1`);
    expect((log.body as unknown as { lsn: number }[]).map((e) => e.lsn)).toEqual([3]);
    expect(((await call("GET", `/log?repo=${REPO}&since=2`)).body as unknown as { lsn: number }[]).map((e) => e.lsn)).toEqual([3]);
  });
});

describe("the brain with accounts", () => {
  const oauth: OAuthProvider = { authorizeUrl: () => "https://github.test/", exchange: async () => ({ githubId: 1, login: "x" }) };

  it("writers propose and take leases as themselves, owners decide, strangers see nothing", async () => {
    const store = new MemoryStore();
    const app = await buildApp({ version: "t", pingDb: async () => true, store, oauth, sessionSecret: "a-cookie-secret-for-tests", sweepMs: 0 });
    const tokenOf = async (login: string, githubId: number) => {
      const user = await store.upsertUser({ githubId, login });
      return { user, headers: { authorization: `Bearer ${(await store.createToken(user.id, "laptop")).secret}` } };
    };
    const owner = await tokenOf("alice", 1);
    const writer = await tokenOf("bob", 2);
    const stranger = await tokenOf("eve", 3);
    expect((await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: owner.headers })).statusCode).toBe(201);
    await store.setMember("alice/app", writer.user.id, "writer");

    const proposed = await app.inject({ method: "POST", url: "/repos/alice/app/adrs", headers: writer.headers, payload: { title: "t", decision: "d", by: "mallory" } });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json()).toMatchObject({ createdBy: "bob" });
    expect((await app.inject({ method: "POST", url: "/repos/alice/app/adrs/1/accept", headers: writer.headers })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/repos/alice/app/adrs/1/accept", headers: owner.headers })).json()).toMatchObject({ version: 1, adr: { decidedBy: "alice" } });

    const lease = await app.inject({ method: "POST", url: "/repos/alice/app/leases", headers: writer.headers, payload: { symbol: "src/a.ts#a", agent: "agent-b", developer: "mallory" } });
    expect(lease.json()).toMatchObject({ lease: { holder: { developer: "bob", agent: "agent-b" } } });
    const release = (headers: Record<string, string>) => app.inject({ method: "DELETE", url: `/repos/alice/app/leases?symbol=${encodeURIComponent("src/a.ts#a")}`, headers });
    expect((await release(stranger.headers)).statusCode).toBe(404);
    expect((await release(owner.headers)).statusCode).toBe(200);

    for (const url of ["/repos/alice/app/brain", "/repos/alice/app/adrs", "/repos/alice/app/leases", "/repos/alice/app/brain/recheck", "/repos/alice/app/symbols", "/repos/alice/app/why?path=a"]) {
      expect((await app.inject({ method: "GET", url, headers: stranger.headers })).statusCode).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: "/repos/alice/app/adrs", headers: stranger.headers, payload: { title: "t", decision: "d" } })).statusCode).toBe(404);
    await app.close();
  });
});
