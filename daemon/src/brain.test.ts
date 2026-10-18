import { describe, expect, it } from "vitest";
import type { Adr, AdrRule, Author, Lease } from "@pitstop/protocol";
import { BRIEF_ADRS, brainBrief, brainLines, matchGlob, type Brain } from "./brain.js";

/** A backtracking engine needs minutes on these inputs; the budget only has to tell that from a busy, shared CI runner. */
const LINEAR_BUDGET_MS = 10_000;

const me: Author = { developer: "alice", agent: "claude-code" };
const adr = (number: number, rules: AdrRule[], extra: Partial<Adr> = {}): Adr => ({
  repo: "acme/app",
  number,
  title: `ADR ${number}`,
  status: "accepted",
  decision: `decision ${number}`,
  reason: "",
  consequences: "",
  rules,
  version: number,
  createdBy: "a",
  createdAt: "2026-10-18T03:00:00Z",
  ...extra,
});
const brainOf = (adrs: Adr[], leases: Lease[] = []): Brain => ({ repo: "acme/app", version: adrs.length, adrs, leases, intents: [] });

describe("the brief an agent gets when it declares an intent", () => {
  it("says an ai_review rule is advisory, cuts long decisions, and lists the ADRs that cover its files first, at most ten", () => {
    const review = adr(1, [{ kind: "ai_review", files: "src/auth/**", question: "Are expired sessions kept out?" }], { decision: "x".repeat(1_000) });
    const many = Array.from({ length: 14 }, (_, i) => adr(i + 2, [{ kind: "forbid_pattern", files: i === 13 ? "src/{auth,pages}/" : "lib/**", pattern: "TODO" }]));
    const brief = brainBrief(brainOf([review, ...many]), ["src/auth/session.ts#getCurrentUser"], me);
    expect(brief[0]).toBe("Brain v15: a commit that breaks one of these rules is refused (an advisory ai_review rule never refuses).");
    expect(brief).toHaveLength(1 + BRIEF_ADRS + 1);
    expect(brief[1]).toMatch(/^ADR-1 ADR 1: x{239}… Rules: ai_review src\/auth\/\*\*: Are expired sessions kept out\? \(advisory: a model reviews it, never refuses\)\.$/);
    expect(brief.some((l) => l.startsWith("ADR-15 "))).toBe(true); // its rule covers src/auth/
    expect(brief.at(-1)).toBe("+5 more ADRs: call the brain tool.");
  });

  it("names a lease the same person's other checkout holds as someone else's", () => {
    const lease: Lease = { repo: "acme/app", symbol: "src/a.ts#a", holder: me, intentId: "int_other", reason: "", status: "held", expiresAt: "2026-10-18T03:15:00.000Z", createdAt: "2026-10-18T03:00:00.000Z" };
    expect(brainBrief(brainOf([], [lease]), ["src/a.ts#a"], me, "int_mine").at(-1)).toMatch(/^Leased by another agent/);
    expect(brainBrief(brainOf([], [lease]), ["src/a.ts#a"], me, "int_other")).toEqual(["Brain v0: no accepted ADRs."]);
    expect(brainLines(brainOf([], [lease]), me, "int_mine").some((l) => l.endsWith("(yours)"))).toBe(false);
    expect(brainLines(brainOf([], [lease]), me, "int_other").some((l) => l.endsWith("(yours)"))).toBe(true);
  });
});

describe("globs, matched without regular expressions", () => {
  it("reads **, *, ?, braces and a trailing slash as the server does", () => {
    expect(matchGlob("src/pages/**", "src/pages/a/B.tsx")).toBe(true);
    expect(matchGlob("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(matchGlob("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false);
    expect(matchGlob("src/**/*.{ts,tsx}", "src/deep/B.tsx")).toBe(true);
    expect(matchGlob("src/pages/", "src/pages/x.ts")).toBe(true);
    expect(matchGlob("src/{a", "src/{a")).toBe(true);
    const t0 = Date.now();
    expect(matchGlob(`${"*a".repeat(40)}*b`, `${"a".repeat(200)}.ts`)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(LINEAR_BUDGET_MS);
  }, 60_000);
});
