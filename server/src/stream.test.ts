import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Intent, ServerMessage, type CommitRequest } from "@pitstop/protocol";
import { buildApp, type AppDeps, type WorktreesResponse } from "./app.js";
import { MemoryStore } from "./store.js";

const request = (key: string): CommitRequest => ({
  idempotencyKey: `idem-${key}-01`, // the schema wants at least 8 characters
  baseLsn: 0,
  author: { developer: "vazovski", agent: "agent-a" },
  intent: `change ${key}`,
  files: [{ path: `src/${key}.ts`, op: "add", content: `export const ${key} = 1;\n` }],
  writeSet: [`src/${key}.ts#${key}`],
  sigWriteSet: [],
  readSet: [],
});

/** Collects parsed server messages so a test can await them one by one. */
class Inbox {
  private readonly messages: ServerMessage[] = [];
  private readonly waiting: (() => void)[] = [];
  readonly closed: Promise<number>;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (ev) => {
      this.messages.push(ServerMessage.parse(JSON.parse(String(ev.data))));
      for (const wake of this.waiting.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => socket.addEventListener("close", (ev) => resolve(ev.code)));
  }

  async next(): Promise<ServerMessage> {
    while (this.messages.length === 0) await new Promise<void>((wake) => this.waiting.push(wake));
    return this.messages.shift() as ServerMessage;
  }

  send(message: unknown): void {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

/** The `ws` client, as the daemon will use it: it can send headers, which a browser's WebSocket cannot. */
const connect = (url: string, headers: Record<string, string> = {}): Promise<Inbox> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const inbox = new Inbox(socket);
    socket.once("open", () => resolve(inbox));
    socket.once("unexpected-response", (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    socket.once("error", (err) => reject(err));
  });

/** A heartbeat has no reply, so a test re-reads until the server shows it (or gives up and lets the assertion say why). */
const eventually = async <T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await new Promise((wake) => setTimeout(wake, 10));
  }
  return read();
};

describe("GET /stream", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  const listen = async (extra: Partial<AppDeps> = {}) => {
    const store = new MemoryStore();
    const app = await buildApp({ version: "test-sha", pingDb: async () => true, store, ...extra });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup = () => app.close();
    const { port } = app.server.address() as AddressInfo;
    const commit = (key: string) => app.inject({ method: "POST", url: "/commit", payload: request(key) });
    return { app, commit, url: `ws://127.0.0.1:${port}/stream` };
  };

  it("greets, replays after fromLsn, then pushes live entries in order", async () => {
    const { commit, url } = await listen();
    await commit("one");
    const inbox = await connect(url);
    expect(await inbox.next()).toMatchObject({ type: "hello", serverVersion: "test-sha", headLsn: 1 });

    inbox.send({ type: "subscribe", fromLsn: 0 });
    expect(await inbox.next()).toMatchObject({ type: "head", repo: "local/default", headLsn: 1 });
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 1, intent: "change one", repo: "local/default" } });

    await commit("two");
    await commit("three");
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 2 } });
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 3 } });
    inbox.close();
  });

  it("a subscriber at the head gets only what follows", async () => {
    const { commit, url } = await listen();
    await commit("one");
    await commit("two");
    const inbox = await connect(url);
    expect(await inbox.next()).toMatchObject({ type: "hello", headLsn: 2 });
    inbox.send({ type: "subscribe", fromLsn: 2 });
    expect(await inbox.next()).toMatchObject({ type: "head", headLsn: 2 });
    await commit("three");
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 3 } });
    inbox.close();
  });

  it("sends the open intents right after head, so a late subscriber sees them", async () => {
    const { app, commit, url } = await listen();
    await commit("one");
    const opened = await app.inject({
      method: "POST",
      url: "/intents",
      payload: { author: { developer: "vaz", agent: "agent-a" }, baseLsn: 1, text: "Fix session expiry", declaredSymbols: [] },
    });
    expect(opened.statusCode).toBe(201);
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send({ type: "subscribe", fromLsn: 1 });
    expect(await inbox.next()).toMatchObject({ type: "head", headLsn: 1 });
    expect(await inbox.next()).toMatchObject({ type: "intent", intent: { status: "open", text: "Fix session expiry", author: { agent: "agent-a" } } });
    await commit("two");
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 2 } });
    inbox.close();
  });

  it("refuses a subscription to a repository that does not exist", async () => {
    const { url } = await listen();
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send({ type: "subscribe", repo: "someone/else", fromLsn: 0 });
    expect(await inbox.closed).toBe(1008);
  });

  it("a socket follows one repository and hears only its entries and intents", async () => {
    const { app, commit, url } = await listen();
    await app.inject({ method: "POST", url: "/repos", payload: { id: "acme/app" } });
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send({ type: "subscribe", repo: "acme/app", fromLsn: 0 });
    expect(await inbox.next()).toMatchObject({ type: "head", repo: "acme/app", headLsn: 0 });

    await commit("default-one"); // another repository: silence here
    await app.inject({ method: "POST", url: "/commit", payload: { ...request("acme-one"), repo: "acme/app" } });
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { repo: "acme/app", lsn: 1 } });

    await app.inject({ method: "POST", url: "/intents", payload: { author: { developer: "x", agent: "y" }, baseLsn: 0, text: "elsewhere" } });
    await app.inject({ method: "POST", url: "/intents", payload: { repo: "acme/app", author: { developer: "x", agent: "y" }, baseLsn: 1, text: "here" } });
    expect(await inbox.next()).toMatchObject({ type: "intent", intent: { repo: "acme/app", text: "here" } });
    inbox.close();
  });

  it("broadcasts opened intents to the sockets following their repository", async () => {
    const { app, url } = await listen();
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send({ type: "subscribe", fromLsn: 0 });
    expect(await inbox.next()).toMatchObject({ type: "head", repo: "local/default" });
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: { author: { developer: "teammate", agent: "agent-b" }, baseLsn: 0, text: "Show last-seen" },
    });
    expect(await inbox.next()).toMatchObject({ type: "intent", intent: { text: "Show last-seen", status: "open" } });
    inbox.close();
  });

  it("warns both agents when a new intent overlaps an open one", async () => {
    const { app, url } = await listen();
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send({ type: "subscribe", fromLsn: 0 });
    await inbox.next(); // head
    const declare = (agent: string, text: string, declaredSymbols: string[]) =>
      app.inject({ method: "POST", url: "/intents", payload: { author: { developer: "d", agent }, baseLsn: 0, text, declaredSymbols } });
    await declare("agent-a", "Fix the expired-session bug in auth", ["src/auth/session.ts#getCurrentUser"]);
    expect(await inbox.next()).toMatchObject({ type: "intent", intent: { author: { agent: "agent-a" } } });

    await declare("agent-b", "Show last-seen on the profile page", ["src/pages/ProfilePage.ts#renderProfile", "src/auth/session.ts#getCurrentUser"]);
    expect(await inbox.next()).toMatchObject({ type: "intent", intent: { author: { agent: "agent-b" } } });
    const first = await inbox.next();
    const second = await inbox.next();
    expect([first, second].map((m) => m.type)).toEqual(["warning", "warning"]);
    expect(first).toMatchObject({ kind: "overlapping_intent", agent: "agent-b", symbols: ["src/auth/session.ts#getCurrentUser"] });
    expect(second).toMatchObject({ kind: "overlapping_intent", agent: "agent-a" });
    inbox.close();
  });

  it("with accounts on, a private repository streams only to its readers", async () => {
    const oauth = { authorizeUrl: () => "https://github.test/authorize", exchange: async () => ({ githubId: 1, login: "alice" }) };
    const store = new MemoryStore();
    const app = await buildApp({ version: "test-sha", pingDb: async () => true, store, oauth, sessionSecret: "a-cookie-secret-for-tests" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup = () => app.close();
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/stream`;
    const alice = await store.upsertUser({ githubId: 1, login: "alice" });
    const { secret } = await store.createToken(alice.id, "laptop");
    await store.createRepo("acme/app");
    await store.setMember("acme/app", alice.id, "reader");
    const bob = await store.upsertUser({ githubId: 2, login: "bob" });
    const stranger = (await store.createToken(bob.id, "laptop")).secret;

    const anonymous = await connect(url);
    await anonymous.next();
    anonymous.send({ type: "subscribe", repo: "acme/app", fromLsn: 0 });
    expect(await anonymous.closed).toBe(1008);

    const outsider = await connect(url, { authorization: `Bearer ${stranger}` });
    await outsider.next();
    outsider.send({ type: "subscribe", repo: "acme/app", fromLsn: 0 });
    expect(await outsider.closed).toBe(1008);

    const reader = await connect(url, { authorization: `Bearer ${secret}` });
    await reader.next();
    reader.send({ type: "subscribe", repo: "acme/app", fromLsn: 0 });
    expect(await reader.next()).toMatchObject({ type: "head", repo: "acme/app" });
    reader.close();
  });

  it("closes a socket that sends something other than a ClientMessage", async () => {
    const { url } = await listen();
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send("not json");
    expect(await inbox.closed).toBe(1003);
  });

  it("with a token set, the upgrade needs the bearer header or ?token=", async () => {
    const token = "s3cret-token-for-tests";
    const { url } = await listen({ token });
    await expect(connect(url)).rejects.toThrow(/401/);

    const withHeader = await connect(url, { authorization: `Bearer ${token}` });
    expect(await withHeader.next()).toMatchObject({ type: "hello" });
    withHeader.close();

    const withQuery = await connect(`${url}?token=${token}`);
    expect(await withQuery.next()).toMatchObject({ type: "hello" });
    withQuery.close();
  });

  it("GET /repos/:owner/:name/worktrees reports what each connected worktree heartbeated, named by its open intent", async () => {
    const { app, commit, url } = await listen();
    await commit("one");
    await commit("two");
    const opened = await app.inject({
      method: "POST",
      url: "/intents",
      payload: { author: { developer: "teammate", agent: "agent-b" }, baseLsn: 1, text: "Show last-seen" },
    });
    const intent = Intent.parse(opened.json());
    const worktrees = async (): Promise<WorktreesResponse> => (await app.inject({ method: "GET", url: "/repos/local/default/worktrees" })).json();

    // Nobody has heartbeated yet: a subscriber that never does (the live view) is not a worktree.
    const viewer = await connect(url);
    await viewer.next(); // hello
    viewer.send({ type: "subscribe", fromLsn: 0 });
    expect(await worktrees()).toEqual({ headLsn: 2, worktrees: [] });

    const a = await connect(url);
    await a.next(); // hello
    a.send({ type: "subscribe", fromLsn: 2 });
    a.send({ type: "heartbeat", appliedLsn: 2 });
    const b = await connect(url);
    await b.next(); // hello
    b.send({ type: "subscribe", fromLsn: 1 });
    b.send({ type: "heartbeat", appliedLsn: 1, intentId: intent.id });
    expect(await eventually(worktrees, (r) => r.worktrees.length === 2)).toEqual({
      headLsn: 2,
      worktrees: [{ appliedLsn: 2 }, { appliedLsn: 1, intentId: intent.id, agent: "agent-b" }],
    });

    // The next heartbeat moves it; one without an intent drops the name (the task is over).
    b.send({ type: "heartbeat", appliedLsn: 2 });
    expect(await eventually(worktrees, (r) => r.worktrees.every((w) => w.appliedLsn === 2))).toEqual({
      headLsn: 2,
      worktrees: [{ appliedLsn: 2 }, { appliedLsn: 2 }],
    });

    // A worktree that disconnects is gone; another repository sees none of them.
    a.close();
    await a.closed;
    expect(await eventually(worktrees, (r) => r.worktrees.length === 1)).toMatchObject({ worktrees: [{ appliedLsn: 2 }] });
    await app.inject({ method: "POST", url: "/repos", payload: { id: "acme/app" } });
    expect((await app.inject({ method: "GET", url: "/repos/acme/app/worktrees" })).json()).toEqual({ headLsn: 0, worktrees: [] });
    expect((await app.inject({ method: "GET", url: "/repos/no/such/worktrees" })).statusCode).toBe(404);
    viewer.close();
    b.close();
  });

  it("the worktrees of a repository are read like its log: with the token when one is set", async () => {
    const token = "s3cret-token-for-tests";
    const { app } = await listen({ token });
    expect((await app.inject({ method: "GET", url: "/repos/local/default/worktrees" })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/repos/local/default/worktrees", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ headLsn: 0, worktrees: [] });
  });

  it("warns every socket when a commit lands with write skew", async () => {
    const { app, commit, url } = await listen();
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send({ type: "subscribe", fromLsn: 0 });
    expect(await inbox.next()).toMatchObject({ type: "head", headLsn: 0 });
    await commit("one");
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 1 } });

    await app.inject({
      method: "POST",
      url: "/commit",
      payload: { ...request("two"), readSet: ["src/one.ts#one"] },
    });
    const messages = [await inbox.next(), await inbox.next()];
    expect(messages.map((m) => m.type).sort()).toEqual(["entry", "warning"]);
    expect(messages.find((m) => m.type === "warning")).toMatchObject({
      kind: "dependency_changed",
      agent: "agent-a",
      symbols: ["src/one.ts#one"],
    });
    inbox.close();
  });
});
