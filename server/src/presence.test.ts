import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { parseStamp, ServerMessage, stampOf, type PresenceEntry } from "@pitstop/protocol";
import { buildApp } from "./app.js";
import { nextStamp, PRESENCE_RETAIN_MS, PresenceDocs, refusal } from "./presence.js";
import { MemoryStore } from "./store.js";
import { Stream } from "./stream.js";

const NOW = Date.now();

const entry = (replica: string, counter: number, extra: Partial<PresenceEntry> = {}): PresenceEntry => ({
  replica,
  repo: "local/default",
  author: { developer: "dev", agent: `agent-${replica}` },
  state: "working",
  intent: "Show last-seen on the profile page",
  intentId: "int_1",
  files: ["src/pages/ProfilePage.ts"],
  symbols: [],
  appliedLsn: 0,
  stamp: stampOf(NOW, counter, replica),
  ...extra,
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

  /** The next `presence` message, skipping anything else. */
  async presence(): Promise<Extract<ServerMessage, { type: "presence" }>> {
    for (;;) {
      const m = await this.next();
      if (m.type === "presence") return m;
    }
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.close();
  }
}

const open = (url: string): Promise<Inbox> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox = new Inbox(socket);
    socket.once("open", () => resolve(inbox));
    socket.once("error", reject);
  });

/** A socket subscribed to `repo`, past its `hello` and `head`. */
const subscribed = async (url: string, repo = "local/default"): Promise<Inbox> => {
  const inbox = await open(url);
  expect(await inbox.next()).toMatchObject({ type: "hello" });
  inbox.send({ type: "subscribe", repo, fromLsn: 0 });
  expect(await inbox.next()).toMatchObject({ type: "head", repo });
  return inbox;
};

describe("the presence document (presence.ts)", () => {
  it("stamps a tombstone just after the last stamp, carrying into the next millisecond at the counter's end", () => {
    expect(nextStamp(stampOf(5, 7, "w_1"))).toBe(stampOf(5, 8, "w_1"));
    expect(nextStamp(stampOf(5, 999_999, "w_1"))).toBe(stampOf(6, 0, "w_1"));
    expect(nextStamp(stampOf(5, 7, "w_1")) > stampOf(5, 7, "w_1")).toBe(true);
  });

  it("refuses a stamp of another replica, from the future, or an entry too large to pass on", () => {
    expect(refusal(entry("a", 0), NOW)).toBeUndefined();
    expect(refusal({ ...entry("a", 0), stamp: stampOf(NOW, 0, "b") }, NOW)).toMatch(/another replica/);
    expect(refusal({ ...entry("a", 0), stamp: stampOf(NOW + 10 * 60_000, 0, "a") }, NOW)).toMatch(/future/);
    expect(refusal(entry("a", 0, { files: Array.from({ length: 500 }, (_, i) => `src/${"x".repeat(200)}/${i}.ts`) }), NOW)).toMatch(/too large/);
  });

  it("merges last-writer-wins per replica and says whether the document changed", () => {
    const docs = new PresenceDocs(() => NOW);
    expect(docs.apply(entry("a", 1))).toBe(true);
    expect(docs.apply(entry("a", 1))).toBe(false); // a duplicate
    expect(docs.apply(entry("a", 0, { state: "idle" }))).toBe(false); // older
    expect(docs.apply(entry("a", 2, { state: "gone" }))).toBe(true);
    expect(docs.apply(entry("a", 1))).toBe(false); // the tombstone keeps it gone
    expect(docs.get("local/default", "a")?.state).toBe("gone");
    expect(docs.entries("acme/app")).toEqual([]);
  });

  it("keeps a repository under its cap, dropping the oldest tombstones first, and forgets entries an hour old", () => {
    const docs = new PresenceDocs(() => NOW, 3);
    docs.apply({ ...entry("old-gone", 0, { state: "gone" }), stamp: stampOf(NOW - 5_000, 0, "old-gone") });
    docs.apply({ ...entry("old-live", 0), stamp: stampOf(NOW - 9_000, 0, "old-live") });
    docs.apply(entry("b", 0));
    docs.apply(entry("c", 0));
    expect(docs.entries("local/default").map((e) => e.replica).sort()).toEqual(["b", "c", "old-live"]);
    docs.apply(entry("d", 0));
    expect(docs.entries("local/default").map((e) => e.replica).sort()).toEqual(["b", "c", "d"]);

    const aging = new PresenceDocs(() => NOW + PRESENCE_RETAIN_MS + 1);
    aging.apply({ ...entry("x", 0), stamp: stampOf(NOW + PRESENCE_RETAIN_MS, 0, "x") });
    aging.apply({ ...entry("y", 0), stamp: stampOf(NOW + PRESENCE_RETAIN_MS, 1, "y") });
    expect(aging.apply(entry("ancient", 0))).toBe(false);
    expect(aging.entries("local/default").map((e) => e.replica).sort()).toEqual(["x", "y"]);
  });
});

describe("presence on GET /stream", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  const listen = async () => {
    const app = await buildApp({ version: "test-sha", pingDb: async () => true, store: new MemoryStore() });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup = () => app.close();
    await app.inject({ method: "POST", url: "/repos", payload: { id: "acme/app" } });
    return { app, url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/stream` };
  };

  it("merges an entry and passes it to every socket following the repository, the sender included", async () => {
    const { url } = await listen();
    const a = await subscribed(url);
    const b = await subscribed(url);
    const elsewhere = await subscribed(url, "acme/app");
    a.send({ type: "presence", entry: entry("w_a", 0) });
    expect(await b.presence()).toEqual({ type: "presence", repo: "local/default", entries: [entry("w_a", 0)] });
    expect(await a.presence()).toEqual({ type: "presence", repo: "local/default", entries: [entry("w_a", 0)] });

    // A stale update, out of order, changes nothing and goes nowhere; the next fresh one does.
    a.send({ type: "presence", entry: entry("w_a", 3, { state: "idle", files: [] }) });
    expect((await b.presence()).entries[0]?.stamp).toBe(entry("w_a", 3).stamp);
    a.send({ type: "presence", entry: entry("w_a", 2, { intent: "stale" }) });
    a.send({ type: "presence", entry: entry("w_a", 4) });
    expect((await b.presence()).entries[0]?.stamp).toBe(entry("w_a", 4).stamp);

    // The other repository heard none of it.
    elsewhere.send({ type: "presence", entry: entry("w_x", 0, { repo: "acme/app" }) });
    expect((await elsewhere.presence()).entries).toEqual([entry("w_x", 0, { repo: "acme/app" })]);
    a.close();
    b.close();
    elsewhere.close();
  });

  it("ignores an entry for another repository than the socket's, and one sent before subscribing", async () => {
    const { url } = await listen();
    const watcher = await subscribed(url);
    const early = await open(url);
    await early.next(); // hello
    early.send({ type: "presence", entry: entry("w_early", 0) });
    const a = await subscribed(url);
    a.send({ type: "presence", entry: entry("w_a", 0, { repo: "acme/app" }) });
    a.send({ type: "presence", entry: entry("w_a", 1) });
    expect((await watcher.presence()).entries).toEqual([entry("w_a", 1)]);

    // A late subscriber gets the whole document: only what was merged.
    const late = await open(url);
    await late.next(); // hello
    late.send({ type: "subscribe", fromLsn: 0 });
    expect(await late.next()).toMatchObject({ type: "head" });
    expect(await late.next()).toEqual({ type: "presence", repo: "local/default", entries: [entry("w_a", 1)] });
    for (const s of [watcher, early, a, late]) s.close();
  });

  it("sends the whole document, tombstones included, after head and the open intents", async () => {
    const { app, url } = await listen();
    await app.inject({ method: "POST", url: "/intents", payload: { author: { developer: "d", agent: "agent-a" }, baseLsn: 0, text: "Fix session expiry" } });
    const a = await subscribed(url);
    a.send({ type: "presence", entry: entry("w_a", 0) });
    a.send({ type: "presence", entry: entry("w_gone", 0, { state: "gone", files: [] }) });
    await a.presence();
    await a.presence();

    const late = await open(url);
    await late.next(); // hello
    late.send({ type: "subscribe", fromLsn: 0 });
    expect(await late.next()).toMatchObject({ type: "head" });
    expect(await late.next()).toMatchObject({ type: "intent", intent: { text: "Fix session expiry" } });
    const doc = await late.next();
    expect(doc.type).toBe("presence");
    expect(doc.type === "presence" ? doc.entries.map((e) => [e.replica, e.state]).sort() : []).toEqual([
      ["w_a", "working"],
      ["w_gone", "gone"],
    ]);
    a.close();
    late.close();
  });

  it("writes a tombstone for each replica a closing socket published, just after its last stamp", async () => {
    const { url } = await listen();
    const watcher = await subscribed(url);
    const a = await subscribed(url);
    a.send({ type: "presence", entry: entry("w_a", 5) });
    expect((await watcher.presence()).entries[0]?.state).toBe("working");
    a.close();
    const left = (await watcher.presence()).entries[0];
    expect(left).toEqual({
      replica: "w_a",
      repo: "local/default",
      author: { developer: "dev", agent: "agent-w_a" },
      state: "gone",
      files: [],
      symbols: [],
      appliedLsn: 0,
      stamp: stampOf(NOW, 6, "w_a"),
    });

    // The same worktree comes back: its clock is past the tombstone, so it is there again.
    const again = await subscribed(url);
    again.send({ type: "presence", entry: entry("w_a", 7, { state: "idle", files: [] }) });
    expect((await watcher.presence()).entries[0]).toMatchObject({ replica: "w_a", state: "idle" });
    watcher.close();
    again.close();
  });

  it("leaves a replica alone when a newer socket wrote it since (a reconnect), and writes no tombstone over a tombstone", async () => {
    const { url } = await listen();
    const watcher = await subscribed(url);
    const old = await subscribed(url);
    old.send({ type: "presence", entry: entry("w_a", 0) });
    await watcher.presence();
    const fresh = await subscribed(url);
    fresh.send({ type: "presence", entry: entry("w_a", 1) });
    await watcher.presence();
    old.close();
    await old.closed;

    const leaving = await subscribed(url);
    leaving.send({ type: "presence", entry: entry("w_b", 0, { state: "gone", files: [] }) });
    await watcher.presence();
    leaving.close();
    await leaving.closed;

    // Neither close produced anything: the next message is this one.
    fresh.send({ type: "presence", entry: entry("w_a", 2, { state: "idle" }) });
    expect((await watcher.presence()).entries[0]).toMatchObject({ replica: "w_a", state: "idle" });
    watcher.close();
    fresh.close();
  });
});

describe("presence from a signed-in user's socket", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it("is written as the user's login, whatever the entry says", async () => {
    // app.ts passes `developer` for a socket identified as a user; here the stream is wired by hand.
    const stream = new Stream(new MemoryStore(), "test-sha");
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on("connection", (socket, req) => stream.connect(socket, async () => true, req.url === "/alice" ? { developer: "alice" } : {}));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    cleanup = async () => {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    };
    const base = `ws://127.0.0.1:${(http.address() as AddressInfo).port}`;

    const shared = await subscribed(`${base}/`);
    const alice = await subscribed(`${base}/alice`);
    alice.send({ type: "presence", entry: entry("w_a", 0, { author: { developer: "mallory", agent: "agent-a" } }) });
    const seen = (await shared.presence()).entries[0];
    expect(seen?.author).toEqual({ developer: "alice", agent: "agent-a" });
    expect(stream.presence.get("local/default", "w_a")?.author.developer).toBe("alice");
    expect((await alice.presence()).entries[0]?.author.developer).toBe("alice"); // its own, passed back

    // Without a user behind the socket (the shared token, an open server), the entry says who.
    shared.send({ type: "presence", entry: entry("w_s", 0, { author: { developer: "vazovski", agent: "agent-s" } }) });
    expect((await alice.presence()).entries[0]?.author.developer).toBe("vazovski");
    expect(parseStamp(stream.presence.get("local/default", "w_s")?.stamp ?? "").replica).toBe("w_s");
    shared.close();
    alice.close();
  });
});
