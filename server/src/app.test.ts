import { describe, expect, it } from "vitest";
import { CommitResponse, Health, Intent, type CommitRequest } from "@pitstop/protocol";
import { buildApp, type AppDeps } from "./app.js";
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
