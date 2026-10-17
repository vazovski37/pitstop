import { describe, expect, it } from "vitest";
import type { Changeset, CommitRequest } from "@pitstop/protocol";
import { GAP_LIMIT, RejectedCommit, SKIPPED_CHECKS } from "./store.js";
import { decideCommit, validate } from "./validate.js";

// The demo scenario (demo/scenario.md): #121 fixes auth and changes getCurrentUser's signature;
// the profile commit, begun at #120, read getCurrentUser.
const entry = (lsn: number, over: Partial<Changeset>): Changeset => ({
  lsn,
  baseLsn: lsn - 1,
  author: { developer: "vazovski", agent: "agent-a" },
  intent: "",
  files: [],
  writeSet: [],
  sigWriteSet: [],
  readSet: [],
  repairs: [],
  checks: SKIPPED_CHECKS,
  brainVersion: 0,
  createdAt: "2026-10-17T14:20:05Z",
  ...over,
});

const authFix = entry(121, {
  intent: "Fix the expired-session bug in auth",
  files: [
    { path: "src/auth/session.ts", op: "modify" },
    { path: "src/router.ts", op: "modify" },
    { path: "src/pages/HomePage.ts", op: "modify" },
  ],
  writeSet: ["src/auth/session.ts#getCurrentUser", "src/router.ts#handle", "src/pages/HomePage.ts#renderHome"],
  sigWriteSet: ["src/auth/session.ts#getCurrentUser"],
  readSet: ["src/auth/session.ts#SessionUser"],
});

const profile = (over: Partial<CommitRequest> = {}): CommitRequest => ({
  idempotencyKey: "profile-last-seen-01",
  baseLsn: 120,
  author: { developer: "teammate", agent: "agent-b" },
  intent: "Show last-seen on the profile page",
  files: [{ path: "src/pages/ProfilePage.ts", op: "modify" }],
  writeSet: ["src/pages/ProfilePage.ts#renderProfile"],
  sigWriteSet: [],
  readSet: ["src/auth/session.ts#getCurrentUser", "src/auth/session.ts#SessionUser", "src/utils/timeAgo.ts#timeAgo"],
  ...over,
});

describe("validate", () => {
  it("accepts a commit with nothing in the gap", () => {
    expect(validate(profile(), [])).toEqual({ kind: "clean" });
  });

  it("accepts disjoint work", () => {
    expect(validate(profile({ readSet: ["src/utils/timeAgo.ts#timeAgo"] }), [authFix])).toEqual({ kind: "clean" });
  });

  it("flags write skew when the commit read a symbol the gap changed", () => {
    const verdict = validate(profile(), [authFix]);
    expect(verdict).toMatchObject({ kind: "skew", conflictsWith: [121] });
    if (verdict.kind === "skew") {
      expect(verdict.symbols).toEqual([{ symbolId: "src/auth/session.ts#getCurrentUser", lsn: 121, signature: true }]);
    }
  });

  it("flags a file both sides changed as a conflict, before any skew", () => {
    const verdict = validate(
      profile({
        files: [
          { path: "src/pages/ProfilePage.ts", op: "modify" },
          { path: "src/router.ts", op: "modify" },
        ],
        writeSet: ["src/pages/ProfilePage.ts#renderProfile", "src/router.ts#handle"],
      }),
      [authFix],
    );
    expect(verdict).toEqual({ kind: "conflict", conflictsWith: [121], paths: ["src/router.ts"], symbols: ["src/router.ts#handle"] });
  });

  it("checks reads from readBaseLsn when entries were applied during the transaction", () => {
    // The daemon applied #121 and moved the base: without readBaseLsn the earlier read is invisible.
    expect(validate(profile({ baseLsn: 121 }), [authFix])).toEqual({ kind: "clean" });
    expect(validate(profile({ baseLsn: 121, readBaseLsn: 120 }), [authFix])).toMatchObject({ kind: "skew", conflictsWith: [121] });
  });

  it("names every entry involved", () => {
    const later = entry(122, { files: [{ path: "src/utils/timeAgo.ts", op: "modify" }], writeSet: ["src/utils/timeAgo.ts#timeAgo"] });
    const verdict = validate(profile(), [authFix, later]);
    expect(verdict).toMatchObject({ kind: "skew", conflictsWith: [121, 122] });
  });
});

describe("decideCommit", () => {
  it("off: records nothing and never rejects", () => {
    expect(decideCommit(profile(), [authFix], 121, "off")).toEqual({ decision: {} });
  });

  it("warn: accepts write skew and writes it into checks.details", () => {
    const { decision, skew } = decideCommit(profile(), [authFix], 121, "warn");
    expect(decision.checks?.details).toBe(
      "write skew, not repaired (PITSTOP_VALIDATE=warn): #121 changed src/auth/session.ts#getCurrentUser (signature)",
    );
    expect(skew?.kind).toBe("skew");
  });

  it("enforce: refuses write skew as repair_failed", () => {
    let caught: unknown;
    try {
      decideCommit(profile(), [authFix], 121, "enforce");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RejectedCommit);
    expect(caught).toMatchObject({ reason: "repair_failed", conflictsWith: [121] });
  });

  it("refuses a conflict as constraint_failed, with who to rebase onto", () => {
    const conflicting = profile({ files: [{ path: "src/router.ts", op: "modify" }], writeSet: ["src/router.ts#handle"] });
    for (const mode of ["warn", "enforce"] as const) {
      let caught: unknown;
      try {
        decideCommit(conflicting, [authFix], 121, mode);
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ reason: "constraint_failed", conflictsWith: [121] });
      expect((caught as Error).message).toContain("Rebase onto #121 and retry");
    }
  });

  it("refuses a commit too far behind head", () => {
    const gap = Array.from({ length: GAP_LIMIT + 1 }, (_, i) => entry(i + 1, {}));
    expect(() => decideCommit(profile({ baseLsn: 0 }), gap, GAP_LIMIT + 1, "warn")).toThrow(/behind head/);
  });
});
