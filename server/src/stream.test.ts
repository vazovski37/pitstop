import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ServerMessage, type CommitRequest } from "@pitstop/protocol";
import { buildApp } from "./app.js";
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

const connect = (url: string): Promise<Inbox> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const inbox = new Inbox(socket);
    socket.addEventListener("open", () => resolve(inbox), { once: true });
    socket.addEventListener("error", () => reject(new Error("could not connect")), { once: true });
  });

describe("GET /stream", () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  const listen = async () => {
    const store = new MemoryStore();
    const app = await buildApp({ version: "test-sha", pingDb: async () => true, store });
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
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 1, intent: "change one" } });

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
    await commit("three");
    expect(await inbox.next()).toMatchObject({ type: "entry", changeset: { lsn: 3 } });
    inbox.close();
  });

  it("broadcasts opened intents", async () => {
    const { app, url } = await listen();
    const inbox = await connect(url);
    await inbox.next(); // hello
    await app.inject({
      method: "POST",
      url: "/intents",
      payload: { author: { developer: "teammate", agent: "agent-b" }, baseLsn: 0, text: "Show last-seen" },
    });
    expect(await inbox.next()).toMatchObject({ type: "intent", intent: { text: "Show last-seen", status: "open" } });
    inbox.close();
  });

  it("closes a socket that sends something other than a ClientMessage", async () => {
    const { url } = await listen();
    const inbox = await connect(url);
    await inbox.next(); // hello
    inbox.send("not json");
    expect(await inbox.closed).toBe(1003);
  });
});
