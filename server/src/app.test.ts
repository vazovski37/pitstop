import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommitResponse, Health, Intent, type Changeset, type CommitRequest } from "@pitstop/protocol";
import { buildApp, type AppDeps } from "./app.js";
import type { OAuthProvider, OAuthUser } from "./auth.js";
import type { GitHubClient } from "./github.js";
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
  const commit = (key: string, extra?: Partial<CommitRequest>, headers?: Record<string, string>) =>
    app.inject({ method: "POST", url: "/commit", payload: request(key, extra), ...(headers === undefined ? {} : { headers }) });
  return { app, store, commit };
};

describe("the live view", () => {
  const withPage = async (run: (webDir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "pitstop-web-"));
    try {
      await writeFile(join(dir, "index.html"), "<!doctype html><title>Pitstop</title>");
      await writeFile(join(dir, "app.js"), "console.log('pitstop');\n");
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("serves the page at / and its files, open even on a shared-token server, while the API stays guarded", () =>
    withPage(async (webDir) => {
      const { app } = await start(true, { token: "s3cret", webDir });
      const page = await app.inject({ method: "GET", url: "/" });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.body).toContain("Pitstop");
      const script = await app.inject({ method: "GET", url: "/app.js" });
      expect(script.statusCode).toBe(200);
      expect(script.headers["content-type"]).toContain("javascript");
      expect((await app.inject({ method: "GET", url: "/nope.js" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/repos" })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    }));

  it("has no page without a web directory", async () => {
    const { app } = await start(true);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
  });
});

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

  it("accepts the bearer header; ?token= only on /stream, so tokens stay out of URLs elsewhere", async () => {
    const app = await guarded();
    const header = await app.inject({ method: "GET", url: "/log", headers: { authorization: `Bearer ${token}` } });
    expect(header.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/log?token=${token}` })).statusCode).toBe(401);
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

describe("the type-check gate (PITSTOP_CHECK=always)", () => {
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] });
  const importRepo: Partial<CommitRequest> = {
    intent: "import",
    files: [
      { path: "tsconfig.json", op: "add", content: tsconfig },
      { path: "src/a.ts", op: "add", content: "export const a: number = 1;\n" },
    ],
    writeSet: ["src/a.ts#a"],
  };

  it("records a passing type check, and refuses a commit that breaks the tree", async () => {
    const { app, commit } = await start(true, { check: "always" });
    const imported = CommitResponse.parse((await commit("import", importRepo)).json());
    expect(imported.status).toBe("accepted");
    if (imported.status === "accepted") expect(imported.changeset.checks.typecheck).toBe("pass");

    const broken = await commit("break", {
      baseLsn: 1,
      files: [{ path: "src/b.ts", op: "add", content: 'import { a } from "./a.js";\nexport const b: string = a;\n' }],
      writeSet: ["src/b.ts#b"],
    });
    expect(broken.statusCode).toBe(409);
    expect(broken.json()).toMatchObject({ status: "rejected", reason: "constraint_failed" });
    expect(broken.json().message).toContain("error TS2322");
    expect((await app.inject({ method: "GET", url: "/log" })).json()).toHaveLength(1);

    const fine = await commit("fine", {
      baseLsn: 1,
      files: [{ path: "src/b.ts", op: "add", content: 'import { a } from "./a.js";\nexport const b: number = a;\n' }],
      writeSet: ["src/b.ts#b"],
    });
    expect(fine.statusCode).toBe(200);
    await app.close();
  }, 120_000);

  it("skips, and says so, when the tree has no tsconfig", async () => {
    const { app, commit } = await start(true, { check: "always" });
    const res = CommitResponse.parse((await commit("notes", { files: [{ path: "NOTES.md", op: "add", content: "# notes\n" }], writeSet: [] })).json());
    if (res.status === "accepted") expect(res.changeset.checks).toMatchObject({ typecheck: "skipped", details: "no tsconfig.json at the root of the tree" });
    await app.close();
  });
});

describe("repair (PITSTOP_REPAIR)", () => {
  // The demo in miniature: an import, the auth fix that changes getCurrentUser's signature,
  // then the profile change that read the old signature.
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] });
  const sessionBefore = "export interface User { name: string }\nexport function getCurrentUser(): User { return { name: \"nino\" }; }\n";
  const sessionAfter = "export interface User { name: string }\nexport function getCurrentUser(): User | null { return null; }\n";
  const profileBroken = 'import { getCurrentUser } from "../auth/session.js";\nexport function renderProfile(): string { return getCurrentUser().name; }\n';
  const profileFixed = 'import { getCurrentUser } from "../auth/session.js";\nexport function renderProfile(): string { const user = getCurrentUser(); return user ? user.name : "/login"; }\n';

  const importRepo: Partial<CommitRequest> = {
    intent: "import",
    files: [
      { path: "tsconfig.json", op: "add", content: tsconfig },
      { path: "src/auth/session.ts", op: "add", content: sessionBefore },
    ],
    writeSet: ["src/auth/session.ts#getCurrentUser", "src/auth/session.ts#User"],
  };
  const authFix: Partial<CommitRequest> = {
    baseLsn: 1,
    intent: "Fix the expired-session bug in auth",
    files: [{ path: "src/auth/session.ts", op: "modify", content: sessionAfter }],
    writeSet: ["src/auth/session.ts#getCurrentUser"],
    sigWriteSet: ["src/auth/session.ts#getCurrentUser"],
  };
  const profile: Partial<CommitRequest> = {
    baseLsn: 1,
    intent: "Show last-seen on the profile page",
    files: [{ path: "src/pages/ProfilePage.ts", op: "add", content: profileBroken }],
    writeSet: ["src/pages/ProfilePage.ts#renderProfile"],
    readSet: ["src/auth/session.ts#getCurrentUser"],
  };

  it("agent: hands the skew back to the committing agent as escalated", async () => {
    const { app, commit } = await start(true, { repair: "agent" });
    await commit("import", importRepo);
    await commit("auth-fix", authFix);
    const res = await commit("profile", profile);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: "rejected", reason: "escalated", conflictsWith: [2] });
    expect(res.json().message).toContain("#2 changed src/auth/session.ts#getCurrentUser (signature)");
    expect(res.json().message).toContain("commit again with baseLsn 2");
    expect((await app.inject({ method: "GET", url: "/log" })).json()).toHaveLength(2);
    await app.close();
  });

  it("groq: lands the repaired entry when the model's patch type-checks", async () => {
    const repairer = { propose: async () => ({ files: [{ path: "src/pages/ProfilePage.ts", content: profileFixed }], summary: "redirect when the session is gone" }) };
    const { app, commit } = await start(true, { repair: "groq", repairer });
    await commit("import", importRepo);
    await commit("auth-fix", authFix);
    const res = await commit("profile", profile);
    expect(res.statusCode).toBe(200);
    const body = CommitResponse.parse(res.json());
    if (body.status === "accepted") {
      expect(body.changeset.lsn).toBe(3);
      expect(body.changeset.files[0]?.content).toBe(profileFixed);
      expect(body.changeset.repairs).toEqual([{ againstLsn: 2, kind: "semantic", summary: "redirect when the session is gone" }]);
      expect(body.changeset.checks.typecheck).toBe("pass");
    }
    const log = (await app.inject({ method: "GET", url: "/log?fromLsn=2" })).json() as { files: { content?: string }[] }[];
    expect(log[0]?.files[0]?.content).toBe(profileFixed);
    await app.close();
  }, 120_000);

  it("groq: escalates when the model cannot fix it", async () => {
    const repairer = { propose: async () => ({ files: [{ path: "src/pages/ProfilePage.ts", content: profileBroken }], summary: "nothing" }) };
    const { app, commit } = await start(true, { repair: "groq", repairer });
    await commit("import", importRepo);
    await commit("auth-fix", authFix);
    const res = await commit("profile", profile);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: "rejected", reason: "escalated", conflictsWith: [2] });
    expect(res.json().message).toContain("after 2 attempts");
    await app.close();
  }, 120_000);

  it("stays out of the way of commits without skew", async () => {
    const { app, commit } = await start(true, { repair: "groq", repairer: { propose: async () => { throw new Error("must not be called"); } } });
    await commit("import", importRepo);
    expect((await commit("auth-fix", authFix)).statusCode).toBe(200);
    await app.close();
  });
});

describe("accounts", () => {
  const people: Record<string, OAuthUser> = {
    "code-alice": { githubId: 1001, login: "alice", name: "Alice", avatarUrl: "https://avatars.test/alice" },
    "code-bob": { githubId: 1002, login: "bob" },
  };
  const oauth: OAuthProvider = {
    authorizeUrl: (state, redirectUri) => `https://github.test/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirectUri)}`,
    exchange: async (code) => {
      const user = people[code];
      if (!user) throw new Error("bad code");
      return user;
    },
  };
  const accounts = (extra: Partial<AppDeps> = {}) => start(true, { oauth, sessionSecret: "a-cookie-secret-for-tests", webUrl: "https://web.test/", ...extra });
  type App = Awaited<ReturnType<typeof buildApp>>;

  /** The OAuth web flow through the routes: the session cookie that comes out. */
  const signIn = async (app: App, code: string): Promise<string> => {
    const begin = await app.inject({ method: "GET", url: "/auth/github", headers: { host: "pitstop.test", "x-forwarded-proto": "https" } });
    expect(begin.statusCode).toBe(302);
    const location = new URL(begin.headers.location as string);
    expect(location.searchParams.get("redirect_uri")).toBe("https://pitstop.test/auth/github/callback");
    const state = location.searchParams.get("state") as string;
    const stateCookie = begin.cookies.find((c) => c.name === "pitstop_oauth_state") as { value: string };
    const done = await app.inject({
      method: "GET",
      url: `/auth/github/callback?code=${code}&state=${state}`,
      cookies: { pitstop_oauth_state: stateCookie.value },
      headers: { host: "pitstop.test", "x-forwarded-proto": "https" },
    });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe("https://web.test/");
    return (done.cookies.find((c) => c.name === "pitstop_session") as { value: string }).value;
  };
  /** A user with a personal token, made directly in the store: the daemon's situation. */
  const tokenFor = async (store: MemoryStore, login: string, githubId: number): Promise<string> => {
    const user = await store.upsertUser({ githubId, login });
    return (await store.createToken(user.id, "laptop")).secret;
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  it("signs in with GitHub and knows who you are", async () => {
    const { app } = await accounts();
    expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    const session = await signIn(app, "code-alice");
    const me = await app.inject({ method: "GET", url: "/me", cookies: { pitstop_session: session } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ login: "alice", name: "Alice", githubId: 1001 });
    const out = await app.inject({ method: "POST", url: "/auth/logout", cookies: { pitstop_session: session } });
    expect(out.statusCode).toBe(204);
    await app.close();
  });

  it("refuses a callback whose state did not start here", async () => {
    const { app } = await accounts();
    const res = await app.inject({ method: "GET", url: "/auth/github/callback?code=code-alice&state=forged" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("answers 501 to sign-in when accounts are off", async () => {
    const { app } = await start();
    expect((await app.inject({ method: "GET", url: "/auth/github" })).statusCode).toBe(501);
    await app.close();
  });

  it("makes personal tokens that stand for the user until revoked", async () => {
    const { app } = await accounts();
    const session = await signIn(app, "code-alice");
    const made = await app.inject({ method: "POST", url: "/tokens", payload: { name: "laptop" }, cookies: { pitstop_session: session } });
    expect(made.statusCode).toBe(201);
    const { id, secret } = made.json() as { id: string; secret: string };
    expect(secret).toMatch(/^pst_[0-9a-f]{32}$/);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(secret) })).json()).toMatchObject({ login: "alice" });
    const list = (await app.inject({ method: "GET", url: "/tokens", headers: bearer(secret) })).json() as { id: string; secret?: string }[];
    expect(list.map((t) => t.id)).toEqual([id]);
    expect(list[0]?.secret).toBeUndefined();
    expect((await app.inject({ method: "DELETE", url: `/tokens/${id}`, headers: bearer(secret) })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(secret) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer("pst_" + "0".repeat(32)) })).statusCode).toBe(401);
    await app.close();
  });

  it("owners, members and visibility decide who may do what", async () => {
    const { app, store, commit } = await accounts();
    const alice = await tokenFor(store, "alice", 1001);
    const bob = await tokenFor(store, "bob", 1002);

    expect((await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/repos/alice/app/members", headers: bearer(alice) })).json()).toEqual([{ login: "alice", role: "owner" }]);

    expect((await app.inject({ method: "POST", url: "/commit", payload: request("bob-1", { repo: "alice/app" }), headers: bearer(bob) })).statusCode).toBe(403);
    // Someone who may not read a repository is told nothing about it: 404, as if it did not exist.
    expect((await app.inject({ method: "GET", url: "/repos/alice/app", headers: bearer(bob) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/log?repo=alice/app" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/repos/alice/app/members/bob", payload: { role: "writer" }, headers: bearer(bob) })).statusCode).toBe(404);

    expect((await app.inject({ method: "PUT", url: "/repos/alice/app/members/bob", payload: { role: "writer" }, headers: bearer(alice) })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/repos/alice/app/members/not a login", payload: { role: "writer" }, headers: bearer(alice) })).statusCode).toBe(400);
    const landed = await app.inject({ method: "POST", url: "/commit", payload: request("bob-1", { repo: "alice/app" }), headers: bearer(bob) });
    expect(landed.statusCode).toBe(200);
    expect(CommitResponse.parse(landed.json())).toMatchObject({ status: "accepted", changeset: { author: { developer: "bob", agent: "agent-a" } } });
    // Only what bob is a member of: local/default has no members, so it is closed to users.
    expect((await app.inject({ method: "GET", url: "/repos", headers: bearer(bob) })).json()).toEqual([expect.objectContaining({ id: "alice/app" })]);

    expect((await app.inject({ method: "PATCH", url: "/repos/alice/app", payload: { visibility: "public" }, headers: bearer(bob) })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: "/repos/alice/app", payload: { visibility: "public" }, headers: bearer(alice) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/log?repo=alice/app" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/commit", payload: request("anon-1", { repo: "alice/app" }) })).statusCode).toBe(401);

    expect((await app.inject({ method: "DELETE", url: "/repos/alice/app/members/bob", headers: bearer(alice) })).statusCode).toBe(204);
    expect((await app.inject({ method: "POST", url: "/commit", payload: request("bob-2", { repo: "alice/app" }), headers: bearer(bob) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/repos/alice/app", headers: bearer(bob) })).statusCode).toBe(200); // public now

    // A repository with no members is closed to users: the first stranger to sign in cannot take it.
    expect((await commit("default-by-bob", { repo: "local/default" }, bearer(bob))).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/repos/local/default/members/bob", payload: { role: "owner" }, headers: bearer(bob) })).statusCode).toBe(404);
    await app.close();
  });

  it("creates repositories only under the user's own login, and says a taken name is taken", async () => {
    const { app, store } = await accounts();
    const alice = await tokenFor(store, "Alice", 1001);
    const bob = await tokenFor(store, "bob", 1002);
    const create = (id: string, token: string) => app.inject({ method: "POST", url: "/repos", payload: { id }, headers: bearer(token) });
    const squat = await create("microsoft/app", alice);
    expect(squat.statusCode).toBe(403);
    expect(squat.json()).toMatchObject({ message: "repositories are created under your login: alice/<name>" });
    expect((await create("alice/app", alice)).statusCode).toBe(201); // the login lowercased
    expect((await create("alice/app", alice)).statusCode).toBe(200); // idempotent for its owner (pitstop init)
    expect((await create("alice/app", bob)).statusCode).toBe(403); // not bob's namespace
    await app.close();
  });

  it("invites a login that has not signed in yet; it joins at its first sign-in", async () => {
    const { app, store } = await accounts();
    const alice = await tokenFor(store, "alice", 1001);
    await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) });
    const invited = await app.inject({ method: "PUT", url: "/repos/alice/app/members/Bob", payload: { role: "writer" }, headers: bearer(alice) });
    expect(invited.statusCode).toBe(202);
    expect(invited.json()).toEqual({ login: "bob", role: "writer", pending: true });
    expect((await app.inject({ method: "GET", url: "/repos/alice/app/members", headers: bearer(alice) })).json()).toEqual([
      { login: "alice", role: "owner" },
      { login: "bob", role: "writer", pending: true },
    ]);
    const session = await signIn(app, "code-bob"); // GitHub login "bob"
    expect((await app.inject({ method: "GET", url: "/repos/alice/app", cookies: { pitstop_session: session } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/repos/alice/app/members", headers: bearer(alice) })).json()).toEqual([
      { login: "alice", role: "owner" },
      { login: "bob", role: "writer" },
    ]);
    // An invite can be withdrawn before it is used.
    await app.inject({ method: "PUT", url: "/repos/alice/app/members/carol", payload: { role: "reader" }, headers: bearer(alice) });
    expect((await app.inject({ method: "DELETE", url: "/repos/alice/app/members/carol", headers: bearer(alice) })).statusCode).toBe(204);
    expect((await store.listInvites("alice/app")).length).toBe(0);
    await app.close();
  });

  it("marks the members the repository's conflicts go to", async () => {
    const { app, store } = await accounts();
    const alice = await tokenFor(store, "alice", 1001);
    await tokenFor(store, "bob", 1002);
    await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) });
    const put = await app.inject({ method: "PUT", url: "/repos/alice/app/members/bob", payload: { role: "writer", resolver: true }, headers: bearer(alice) });
    expect(put.json()).toEqual({ login: "bob", role: "writer", resolver: true });
    // A role change alone keeps the flag.
    await app.inject({ method: "PUT", url: "/repos/alice/app/members/bob", payload: { role: "owner" }, headers: bearer(alice) });
    expect((await app.inject({ method: "GET", url: "/repos/alice/app/members", headers: bearer(alice) })).json()).toEqual([
      { login: "alice", role: "owner" },
      { login: "bob", role: "owner", resolver: true },
    ]);
    expect((await app.inject({ method: "GET", url: "/version" })).json()).toMatchObject({ accounts: true });
    await app.close();
  });

  describe("a resolver decides on write skew", () => {
    // The demo's write skew: alice's #1 changes getCurrentUser's signature, bob's commit read it at #0.
    const authFix = {
      intent: "Fix the expired-session bug in auth",
      files: [{ path: "src/auth/session.ts", op: "modify" as const, content: "export function getCurrentUser() { return null; }\n" }],
      writeSet: ["src/auth/session.ts#getCurrentUser"],
      sigWriteSet: ["src/auth/session.ts#getCurrentUser"],
      readSet: [],
    };
    const profile = {
      intent: "Show last-seen on the profile page",
      files: [{ path: "src/pages/ProfilePage.ts", op: "modify" as const, content }],
      writeSet: ["src/pages/ProfilePage.ts#renderProfile"],
      readSet: ["src/auth/session.ts#getCurrentUser"],
    };
    const team = async () => {
      const ctx = await accounts({ repair: "agent" });
      const alice = await tokenFor(ctx.store, "alice", 1001);
      const bob = await tokenFor(ctx.store, "bob", 1002);
      await ctx.app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) });
      await ctx.app.inject({ method: "PUT", url: "/repos/alice/app/members/bob", payload: { role: "writer" }, headers: bearer(alice) });
      const as = (token: string, key: string, extra: Partial<CommitRequest>) =>
        ctx.app.inject({ method: "POST", url: "/commit", payload: request(key, { repo: "alice/app", baseLsn: 0, ...extra }), headers: bearer(token) });
      expect((await as(alice, "auth-fix-1", authFix)).statusCode).toBe(200);
      return { ...ctx, alice, bob, as };
    };

    it("parks the commit for the owner, holds its author's next one, and lands it when let through", async () => {
      const { app, alice, bob, as } = await team();
      const parked = await as(bob, "profile-1", profile);
      expect(parked.statusCode).toBe(409);
      const answer = parked.json() as { reason: string; message: string; conflictsWith: number[] };
      expect(answer).toMatchObject({ reason: "escalated", conflictsWith: [1] });
      expect(answer.message).toMatch(/resolver \(alice\) decides on it: your commit waits as pk_[0-9a-f]{8}/);
      const id = /pk_[0-9a-f]{8}/.exec(answer.message)?.[0] as string;

      const again = await as(bob, "profile-2", profile);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ reason: "constraint_failed" });

      const list = (await app.inject({ method: "GET", url: "/repos/alice/app/parked", headers: bearer(bob) })).json() as { id: string; status: string; skew: string }[];
      expect(list).toEqual([expect.objectContaining({ id, status: "open", skew: "#1 changed src/auth/session.ts#getCurrentUser (signature)" })]);

      expect((await app.inject({ method: "POST", url: `/repos/alice/app/parked/${id}/accept`, headers: bearer(bob) })).statusCode).toBe(403);
      const accepted = await app.inject({ method: "POST", url: `/repos/alice/app/parked/${id}/accept`, headers: bearer(alice) });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({ status: "accepted", decidedBy: "alice", landedLsn: 2 });
      const log = (await app.inject({ method: "GET", url: "/log?repo=alice/app", headers: bearer(alice) })).json() as Changeset[];
      expect(log[1]).toMatchObject({ lsn: 2, author: { developer: "bob" }, repairs: [{ againstLsn: 1, kind: "semantic", summary: "write skew accepted as is by alice" }] });
      expect((await app.inject({ method: "POST", url: `/repos/alice/app/parked/${id}/accept`, headers: bearer(alice) })).statusCode).toBe(409);
      expect((await as(bob, "profile-3", { ...profile, baseLsn: 2, files: [{ path: "src/b.ts", op: "add", content }], readSet: [] })).statusCode).toBe(200);
      await app.close();
    });

    it("sends it back with a note to its author, who may commit again", async () => {
      const { app, alice, bob, as } = await team();
      const id = /pk_[0-9a-f]{8}/.exec((await as(bob, "profile-1", profile)).json().message)?.[0] as string;
      const back = await app.inject({ method: "POST", url: `/repos/alice/app/parked/${id}/send-back`, payload: { note: "guard the null user" }, headers: bearer(alice) });
      expect(back.json()).toMatchObject({ status: "sent_back", decidedBy: "alice", note: "guard the null user" });
      // Re-read at #1 (the daemon moved its read base there): it lands.
      expect((await as(bob, "profile-2", { ...profile, baseLsn: 1, readBaseLsn: 1 })).statusCode).toBe(200);
      await app.close();
    });

    it("goes to the members marked resolver, and back to its own agent when its author is the only one who decides", async () => {
      const { app, alice, as } = await team();
      // alice is the only owner and the committer: nobody else to ask.
      const own = await as(alice, "alice-skew", { ...profile, baseLsn: 0 });
      expect(own.statusCode).toBe(409);
      expect(own.json().message).toContain("Re-read those files at head #1");
      expect((await app.inject({ method: "GET", url: "/repos/alice/app/parked", headers: bearer(alice) })).json()).toEqual([]);
      await app.close();
    });
  });

  it("scopes intents and idempotency keys to their repository", async () => {
    const { app, store } = await accounts();
    const alice = await tokenFor(store, "alice", 1001);
    const bob = await tokenFor(store, "bob", 1002);
    await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) });
    await app.inject({ method: "POST", url: "/repos", payload: { id: "bob/own" }, headers: bearer(bob) });
    const intent = Intent.parse(
      (await app.inject({ method: "POST", url: "/intents", payload: { repo: "alice/app", author: { developer: "alice", agent: "a" }, baseLsn: 0, text: "work" }, headers: bearer(alice) })).json(),
    );
    // bob cannot close alice's intent from his own repository...
    const steal = await app.inject({ method: "POST", url: "/commit", payload: request("steal-001", { repo: "bob/own", intentId: intent.id }), headers: bearer(bob) });
    expect(steal.statusCode).toBe(400);
    expect((await store.openIntents("alice/app")).map((i) => i.id)).toEqual([intent.id]);
    // ...nor read her commit back through its idempotency key.
    expect((await app.inject({ method: "POST", url: "/commit", payload: request("shared-key-1", { repo: "alice/app" }), headers: bearer(alice) })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/commit", payload: request("shared-key-1", { repo: "bob/own" }), headers: bearer(bob) })).statusCode).toBe(400);
    await app.close();
  });

  it("answers an existing repository to its members whatever its owner name (pitstop init)", async () => {
    const { app, store } = await accounts();
    const alice = await tokenFor(store, "alice", 1001);
    const bob = await tokenFor(store, "bob", 1002);
    await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) });
    await app.inject({ method: "PUT", url: "/repos/alice/app/members/bob", payload: { role: "writer" }, headers: bearer(alice) });
    expect((await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(bob) })).statusCode).toBe(200);
    await app.close();
  });

  it("never leaves a repository without an owner; a member may leave", async () => {
    const { app, store } = await accounts();
    const alice = await tokenFor(store, "alice", 1001);
    const bob = await tokenFor(store, "bob", 1002);
    await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) });
    const member = (login: string, role: string, token: string) =>
      app.inject({ method: "PUT", url: `/repos/alice/app/members/${login}`, payload: { role }, headers: bearer(token) });
    expect((await member("alice", "writer", alice)).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: "/repos/alice/app/members/alice", headers: bearer(alice) })).statusCode).toBe(409);
    expect((await member("bob", "writer", alice)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/repos/alice/app/members/bob", headers: bearer(bob) })).statusCode).toBe(204); // bob leaves
    expect((await member("bob", "owner", alice)).statusCode).toBe(200);
    expect((await member("alice", "writer", alice)).statusCode).toBe(200); // bob owns it now
    expect((await app.inject({ method: "GET", url: "/repos/alice/app/members", headers: bearer(bob) })).json()).toEqual(
      expect.arrayContaining([{ login: "alice", role: "writer" }, { login: "bob", role: "owner" }]),
    );
    await app.close();
  });

  it("the shared token still does everything when accounts are on, and alone configures mirrors", async () => {
    const shared = "the-shared-token-1234";
    const github: GitHubClient = {
      getRef: async () => "c".repeat(40),
      getCommit: async (_r, sha) => ({ sha, tree: "t" }),
      getTree: async () => [],
      createTree: async () => "t2",
      createCommit: async () => "d".repeat(40),
      updateRef: async () => undefined,
    };
    const { app, store, commit } = await accounts({ token: shared, github });
    const alice = await tokenFor(store, "alice", 1001);
    await app.inject({ method: "POST", url: "/repos", payload: { id: "alice/app" }, headers: bearer(alice) });
    expect((await commit("shared-1", { repo: "alice/app" }, bearer(shared))).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/repos/alice/app/mirror", headers: bearer(shared) })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/log" })).statusCode).toBe(404); // without accounts the shared token guards everything (401); with them, an unreadable repository is 404
    // The owner may not aim the server's GitHub token anywhere; the administrator may.
    const aim = (token: string) => app.inject({ method: "PUT", url: "/repos/alice/app/mirror", payload: { github: "vazovski37/pitstop" }, headers: bearer(token) });
    expect((await aim(alice)).statusCode).toBe(403);
    expect((await aim(shared)).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/repos/alice/app/mirror", headers: bearer(alice) })).statusCode).toBe(403);
    // The administrator makes the repositories it created reachable by adding their owner.
    await app.inject({ method: "POST", url: "/repos", payload: { id: "team/legacy" }, headers: bearer(shared) });
    expect((await app.inject({ method: "GET", url: "/repos/team/legacy", headers: bearer(alice) })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/repos/team/legacy/members/alice", payload: { role: "owner" }, headers: bearer(shared) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/repos/team/legacy", headers: bearer(alice) })).statusCode).toBe(200);
    await app.close();
  });

  it("takes a token from the URL only on /stream", async () => {
    const { app, store } = await accounts();
    const alice = await tokenFor(store, "alice", 1001);
    expect((await app.inject({ method: "GET", url: `/me?token=${alice}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/me", headers: bearer(alice) })).statusCode).toBe(200);
    await app.close();
  });
});

describe("the git mirror", () => {
  const base = "c".repeat(40);
  const fakeGithub = () => {
    const refs = new Map<string, string>([["vazovski37/pitstop@main", base]]);
    const commits: { message: string; parents: string[] }[] = [];
    const client: GitHubClient = {
      getRef: async (repo, branch) => refs.get(`${repo}@${branch}`) ?? "",
      getCommit: async (_r, sha) => ({ sha, tree: `tree-of-${sha.slice(0, 7)}` }),
      getTree: async () => [],
      createTree: async (_r, baseTree) => `${baseTree}+`,
      createCommit: async (_r, input) => {
        commits.push({ message: input.message, parents: input.parents });
        return `commit-${commits.length}`.padEnd(40, "0");
      },
      updateRef: async (repo, branch, sha) => {
        refs.set(`${repo}@${branch}`, sha);
      },
    };
    return { client, refs, commits };
  };
  const mirrored = async (app: Awaited<ReturnType<typeof buildApp>>, expected: number) => {
    for (let i = 0; i < 100; i++) {
      const res = await app.inject({ method: "GET", url: "/repos/local/default/mirror" });
      if ((res.json() as { lastLsn: number }).lastLsn >= expected) return res.json();
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`the mirror never reached #${expected}`);
  };

  it("answers 501 without a GitHub token", async () => {
    const { app } = await start();
    const res = await app.inject({ method: "PUT", url: "/repos/local/default/mirror", payload: { github: "vazovski37/pitstop" } });
    expect(res.statusCode).toBe(501);
    await app.close();
  });

  it("is configured per repository and pushes every accepted entry", async () => {
    const github = fakeGithub();
    const { app, commit } = await start(true, { github: github.client });
    expect((await app.inject({ method: "GET", url: "/repos/local/default/mirror" })).statusCode).toBe(404);
    const put = await app.inject({ method: "PUT", url: "/repos/local/default/mirror", payload: { github: "vazovski37/pitstop" } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ repo: "local/default", githubRepo: "vazovski37/pitstop", branch: "main", baseCommit: base, lastLsn: 0, status: "enabled" });

    await commit("first-entry");
    await commit("second-entry", { files: [{ path: "src/b.ts", op: "add", content }], writeSet: ["src/b.ts#b"] });
    const mirror = await mirrored(app, 2);
    expect(mirror).toMatchObject({ lastLsn: 2, status: "enabled" });
    expect(github.commits.map((c) => c.message)).toEqual(["#1 add a\n", "#2 add a\n"]);
    expect(github.commits[0]?.parents).toEqual([base]);
    expect(github.refs.get("vazovski37/pitstop@main")).toBe((mirror as { lastCommit: string }).lastCommit);

    expect((await app.inject({ method: "PUT", url: "/repos/no/such/mirror", payload: { github: "x/y" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/repos/local/default/mirror", payload: { github: "not a repo" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/repos/local/default/mirror" })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/repos/local/default/mirror" })).statusCode).toBe(404);
    await app.close();
  });
});

describe("repositories", () => {
  it("creates, lists and describes repositories", async () => {
    const { app } = await start();
    const created = await app.inject({ method: "POST", url: "/repos", payload: { id: "acme/app" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: "acme/app", headLsn: 0 });
    expect((await app.inject({ method: "POST", url: "/repos", payload: { id: "acme/app" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/repos", payload: { id: "Not/Valid" } })).statusCode).toBe(400);
    const list = (await app.inject({ method: "GET", url: "/repos" })).json() as { id: string }[];
    expect(list.map((r) => r.id)).toEqual(["acme/app", "local/default"]);
    expect((await app.inject({ method: "GET", url: "/repos/acme/app" })).json()).toMatchObject({ id: "acme/app" });
    expect((await app.inject({ method: "GET", url: "/repos/no/such" })).statusCode).toBe(404);
    await app.close();
  });

  it("counts LSNs per repository and keeps their logs apart", async () => {
    const { app, commit } = await start();
    await app.inject({ method: "POST", url: "/repos", payload: { id: "acme/app" } });
    await commit("default-1");
    const other = CommitResponse.parse((await commit("acme-1", { repo: "acme/app" })).json());
    expect(other.status).toBe("accepted");
    if (other.status === "accepted") expect(other.changeset).toMatchObject({ repo: "acme/app", lsn: 1 });
    const acme = (await app.inject({ method: "GET", url: "/log?repo=acme/app" })).json() as { lsn: number; repo: string }[];
    expect(acme).toEqual([expect.objectContaining({ repo: "acme/app", lsn: 1 })]);
    expect((await app.inject({ method: "GET", url: "/log" })).json()).toEqual([expect.objectContaining({ repo: "local/default", lsn: 1 })]);
    expect((await app.inject({ method: "GET", url: "/repos/acme/app" })).json()).toMatchObject({ headLsn: 1 });
    await app.close();
  });

  it("validates each repository against its own log", async () => {
    const { app, commit } = await start();
    await app.inject({ method: "POST", url: "/repos", payload: { id: "acme/app" } });
    // The same file in both repositories: no conflict, they are different logs.
    expect((await commit("default-1")).statusCode).toBe(200);
    expect((await commit("acme-1", { repo: "acme/app" })).statusCode).toBe(200);
    // Inside one repository the validator still works.
    expect((await commit("acme-2", { repo: "acme/app" })).statusCode).toBe(409);
    await app.close();
  });

  it("refuses commits, intents and log reads for a repository that does not exist", async () => {
    const { app, commit } = await start();
    const res = await commit("nowhere", { repo: "no/such" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "rejected", reason: "invalid_request" });
    expect(res.json().message).toContain("unknown repo no/such");
    const intent = await app.inject({ method: "POST", url: "/intents", payload: { repo: "no/such", author: { developer: "x", agent: "y" }, baseLsn: 0, text: "t" } });
    expect(intent.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/log?repo=no/such" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/log?repo=BAD" })).statusCode).toBe(400);
    await app.close();
  });

});
