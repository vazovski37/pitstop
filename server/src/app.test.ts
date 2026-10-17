import { describe, expect, it } from "vitest";
import { CommitResponse, Health, Intent, type CommitRequest } from "@pitstop/protocol";
import { buildApp, type AppDeps } from "./app.js";
import { blobHash, MemoryStore } from "./store.js";

const content = "export const a = 1;\n";
const request = (key: string, extra: Partial<CommitRequest> = {}): CommitRequest => ({
  idempotencyKey: `idem-${key}-01`, // the schema wants at least 8 characters
  baseLsn: 0,
  author: { developer: "vazovski", agent: "agent-a" },
  intent: "add a",
  files: [{ path: "src/a.ts", op: "add", content }],
  writeSet: ["src/a.ts#a"],
  sigWriteSet: [],
  readSet: [],
  ...extra,
});

const start = async (dbUp = true, extra: Partial<AppDeps> = {}) => {
  const store = new MemoryStore();
  const app = await buildApp({
    version: "test-sha",
    pingDb: async () => {
      if (!dbUp) throw new Error("connection refused");
      return true;
    },
    store,
    ...extra,
  });
  const commit = (key: string, extra?: Partial<CommitRequest>) =>
    app.inject({ method: "POST", url: "/commit", payload: request(key, extra) });
  return { app, store, commit };
};

describe("GET /healthz", () => {
  it("returns 200 with the version when the database answers", async () => {
    const { app } = await start(true);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(Health.parse(res.json())).toEqual({ ok: true, version: "test-sha", db: true });
    await app.close();
  });

  it("returns 503 when the database is down", async () => {
    const { app } = await start(false);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false, db: false });
    await app.close();
  });
});

describe("POST /commit", () => {
  it("appends at the next LSN and fills in the blob hash", async () => {
    const { app, commit } = await start();
    const res = await commit("k1");
    expect(res.statusCode).toBe(200);
    const body = CommitResponse.parse(res.json());
    expect(body.status).toBe("accepted");
    if (body.status === "accepted") {
      expect(body.changeset.lsn).toBe(1);
      expect(body.changeset.files[0]).toMatchObject({ path: "src/a.ts", blob: blobHash(content), content });
      expect(body.changeset.checks).toEqual({ typecheck: "skipped", tests: "skipped", adr: "skipped" });
    }
    await app.close();
  });

  it("returns the same changeset for a repeated idempotency key", async () => {
    const { app, commit } = await start();
    const first = await commit("retry");
    const again = await commit("retry");
    expect(again.json()).toEqual(first.json());
    expect((await app.inject({ method: "GET", url: "/log" })).json()).toHaveLength(1);
    await app.close();
  });

  it("rejects a body that is not a CommitRequest", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "POST", url: "/commit", payload: { intent: "no files" } });
    expect(res.statusCode).toBe(400);
    expect(CommitResponse.parse(res.json())).toMatchObject({ status: "rejected", reason: "invalid_request" });
    await app.close();
  });

  it("rejects a blob that is not the sha256 of its content", async () => {
    const { app, commit } = await start();
    const wrong = `sha256:${"0".repeat(64)}`;
    const res = await commit("bad-hash", { files: [{ path: "src/a.ts", op: "add", content, blob: wrong }] });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "rejected", reason: "invalid_request" });
    await app.close();
  });

  it("rejects a base at or beyond the next LSN", async () => {
    const { app, commit } = await start();
    const res = await commit("ahead", { baseLsn: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "rejected", reason: "invalid_request" });
    await app.close();
  });

  it("closes the intent it names and rejects an unknown one", async () => {
    const { app, store, commit } = await start();
    const opened = await app.inject({
      method: "POST",
      url: "/intents",
      payload: { author: { developer: "vazovski", agent: "agent-a" }, baseLsn: 0, text: "add a" },
    });
    const intent = Intent.parse(opened.json());
    expect((await commit("with-intent", { intentId: intent.id })).statusCode).toBe(200);
    expect(store.intent(intent.id)?.status).toBe("committed");
    expect((await commit("unknown-intent", { intentId: "int_nope" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /intents", () => {
  it("opens an intent with no declared symbols by default", async () => {
    const { app } = await start();
    const res = await app.inject({
      method: "POST",
      url: "/intents",
      payload: { author: { developer: "teammate", agent: "agent-b" }, baseLsn: 0, text: "Show last-seen" },
    });
    expect(res.statusCode).toBe(201);
    expect(Intent.parse(res.json())).toMatchObject({ text: "Show last-seen", status: "open", declaredSymbols: [] });
    await app.close();
  });

  it("rejects a body that is not an IntentRequest", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "POST", url: "/intents", payload: { text: "" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /log", () => {
  it("pages entries after fromLsn in order", async () => {
    const { app, commit } = await start();
    // Distinct files, or the validator would refuse the second and third as write-write.
    for (const key of ["a", "b", "c"]) {
      await commit(key, { files: [{ path: `src/${key}.ts`, op: "add", content }], writeSet: [`src/${key}.ts#${key}`] });
    }
    const res = await app.inject({ method: "GET", url: "/log?fromLsn=1&limit=1" });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((e: { lsn: number }) => e.lsn)).toEqual([2]);
    expect((await app.inject({ method: "GET", url: "/log" })).json()).toHaveLength(3);
    await app.close();
  });

  it("rejects a fromLsn that is not an LSN", async () => {
    const { app } = await start();
    expect((await app.inject({ method: "GET", url: "/log?fromLsn=-1" })).statusCode).toBe(400);
    await app.close();
  });
});

describe("with PITSTOP_TOKEN set", () => {
  const token = "s3cret-token-for-tests";
  const guarded = () => buildApp({ version: "test-sha", pingDb: async () => true, store: new MemoryStore(), token });

  it("leaves the health probes open", async () => {
    const app = await guarded();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/version" })).statusCode).toBe(200);
    await app.close();
  });

  it("refuses a request without the right bearer token", async () => {
    const app = await guarded();
    expect((await app.inject({ method: "GET", url: "/log" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/commit", payload: request("idem-guarded-01") })).statusCode).toBe(401);
    const wrong = await app.inject({ method: "GET", url: "/log", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: "unauthorized" });
    await app.close();
  });

  it("accepts the bearer header or ?token=", async () => {
    const app = await guarded();
    const header = await app.inject({ method: "GET", url: "/log", headers: { authorization: `Bearer ${token}` } });
    expect(header.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/log?token=${token}` })).statusCode).toBe(200);
    await app.close();
  });
});

describe("validation (PITSTOP_VALIDATE)", () => {
  // The demo scenario on an empty log: the auth fix lands as #1, the profile commit read what it changed.
  const authFix: Partial<CommitRequest> = {
    intent: "Fix the expired-session bug in auth",
    files: [{ path: "src/auth/session.ts", op: "modify", content: "export function getCurrentUser() { return null; }\n" }],
    writeSet: ["src/auth/session.ts#getCurrentUser"],
    sigWriteSet: ["src/auth/session.ts#getCurrentUser"],
    readSet: [],
  };
  const profile: Partial<CommitRequest> = {
    intent: "Show last-seen on the profile page",
    files: [{ path: "src/pages/ProfilePage.ts", op: "modify", content }],
    writeSet: ["src/pages/ProfilePage.ts#renderProfile"],
    readSet: ["src/auth/session.ts#getCurrentUser"],
  };

  it("warn (the default) lands write skew and says so in checks.details", async () => {
    const { app, commit } = await start();
    await commit("auth-fix", authFix);
    const res = await commit("profile", profile);
    expect(res.statusCode).toBe(200);
    const body = CommitResponse.parse(res.json());
    if (body.status === "accepted") {
      expect(body.changeset.lsn).toBe(2);
      expect(body.changeset.checks.details).toBe(
        "write skew, not repaired (PITSTOP_VALIDATE=warn): #1 changed src/auth/session.ts#getCurrentUser (signature)",
      );
    }
    await app.close();
  });

  it("enforce refuses write skew as repair_failed", async () => {
    const { app, commit } = await start(true, { validation: "enforce" });
    await commit("auth-fix", authFix);
    const res = await commit("profile", profile);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: "rejected", reason: "repair_failed", conflictsWith: [1] });
    expect((await app.inject({ method: "GET", url: "/log" })).json()).toHaveLength(1);
    await app.close();
  });

  it("refuses a commit that changes a file the gap changed", async () => {
    const { app, commit } = await start();
    await commit("auth-fix", authFix);
    const res = await commit("profile-and-session", {
      ...profile,
      files: [...(profile.files ?? []), { path: "src/auth/session.ts", op: "modify", content: "// mine\n" }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: "rejected", reason: "constraint_failed", conflictsWith: [1] });
    expect(res.json().message).toContain("Rebase onto #1 and retry");
    await app.close();
  });

  it("accepts work that touches nothing the gap touched", async () => {
    const { app, commit } = await start();
    await commit("auth-fix", authFix);
    const res = await commit("profile", { ...profile, readSet: ["src/utils/timeAgo.ts#timeAgo"] });
    expect(res.statusCode).toBe(200);
    const body = CommitResponse.parse(res.json());
    if (body.status === "accepted") expect(body.changeset.checks.details).toBeUndefined();
    await app.close();
  });

  it("off appends anything", async () => {
    const { app, commit } = await start(true, { validation: "off" });
    await commit("auth-fix", authFix);
    expect((await commit("profile", profile)).statusCode).toBe(200);
    await app.close();
  });
});
