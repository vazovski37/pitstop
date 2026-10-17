import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  Changeset,
  ClientMessage,
  CommitRequest,
  DEFAULT_REPO,
  IntentRequest,
  Repo,
  RepoId,
  ServerMessage,
} from "./index.js";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

// The fixtures are the shared examples both halves test against.
// If a schema change breaks one of these, the contract changed: agree on it first.
describe("protocol fixtures", () => {
  it("commit request fixture is valid", () => {
    expect(() => CommitRequest.parse(load("commit-request.json"))).not.toThrow();
  });

  it("commit request carries file contents, its repository and the intent it closes", () => {
    const req = CommitRequest.parse(load("commit-request.json"));
    expect(req.repo).toBe("teamdb/demo");
    expect(req.intentId).toBe("int_02");
    expect(req.files[0]?.content).toContain("getCurrentUser");
  });

  it("changeset fixture is valid", () => {
    const cs = Changeset.parse(load("changeset.json"));
    expect(cs.lsn).toBeGreaterThan(cs.baseLsn);
    expect(cs.repo).toBe("teamdb/demo");
  });

  it("intent request fixture is valid", () => {
    const req = IntentRequest.parse(load("intent-request.json"));
    expect(req.declaredSymbols.length).toBeGreaterThan(0);
  });

  it("declared symbols default to none", () => {
    const raw = { ...(load("intent-request.json") as Record<string, unknown>) };
    delete raw.declaredSymbols;
    expect(IntentRequest.parse(raw).declaredSymbols).toEqual([]);
  });

  it("repo fixture is valid", () => {
    expect(Repo.parse(load("repo.json"))).toMatchObject({ id: "teamdb/demo", headLsn: 122 });
  });

  it("server message fixtures are valid", () => {
    const messages = load("server-messages.json") as unknown[];
    for (const m of messages) expect(() => ServerMessage.parse(m)).not.toThrow();
    expect(() => ServerMessage.parse(load("head.json"))).not.toThrow();
  });

  it("the entry fixture carries the file contents a daemon needs to apply it", () => {
    const messages = (load("server-messages.json") as unknown[]).map((m) => ServerMessage.parse(m));
    const entry = messages.find((m) => m.type === "entry");
    expect(entry?.type).toBe("entry");
    if (entry?.type === "entry") {
      for (const f of entry.changeset.files) if (f.op !== "delete") expect(f.content).toBeDefined();
    }
  });

  it("client message fixtures are valid", () => {
    const messages = load("client-messages.json") as unknown[];
    for (const m of messages) expect(() => ClientMessage.parse(m)).not.toThrow();
  });

  it("a request without a repository means the default one", () => {
    const raw = { ...(load("commit-request.json") as Record<string, unknown>) };
    delete raw.repo;
    expect(CommitRequest.parse(raw).repo).toBeUndefined();
    expect(RepoId.parse(DEFAULT_REPO)).toBe("local/default");
  });

  it("rejects a repository id that is not owner/name in lowercase", () => {
    for (const bad of ["pitstop", "Vazovski37/pitstop", "a/b/c", "/x", "owner/"]) {
      expect(RepoId.safeParse(bad).success, bad).toBe(false);
    }
    expect(RepoId.safeParse("vazovski37/pitstop").success).toBe(true);
  });

  it("rejects a symbol id without a path", () => {
    const bad = { ...(load("commit-request.json") as object), writeSet: ["getCurrentUser"] };
    expect(CommitRequest.safeParse(bad).success).toBe(false);
  });
});
