import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Changeset, CommitRequest, ServerMessage } from "./index.js";

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));

// The fixtures are the shared examples both halves test against.
// If a schema change breaks one of these, the contract changed: agree on it first.
describe("protocol fixtures", () => {
  it("commit request fixture is valid", () => {
    expect(() => CommitRequest.parse(load("commit-request.json"))).not.toThrow();
  });

  it("changeset fixture is valid", () => {
    const cs = Changeset.parse(load("changeset.json"));
    expect(cs.lsn).toBeGreaterThan(cs.baseLsn);
  });

  it("server message fixtures are valid", () => {
    const messages = load("server-messages.json") as unknown[];
    for (const m of messages) expect(() => ServerMessage.parse(m)).not.toThrow();
  });

  it("rejects a symbol id without a path", () => {
    const bad = { ...(load("commit-request.json") as object), writeSet: ["getCurrentUser"] };
    expect(CommitRequest.safeParse(bad).success).toBe(false);
  });
});
