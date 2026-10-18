import { describe, expect, it } from "vitest";
import type { Adr } from "@pitstop/protocol";
import type { ReviewRule } from "./adr-rules.js";
import type { ChatMessage } from "./groq.js";
import { modelReviewer, runReviews, type Reviewer } from "./review.js";

const rule: ReviewRule = { kind: "ai_review", files: "src/auth/**", question: "Are expired sessions kept out?" };
const adr: Adr = {
  repo: "acme/app",
  number: 3,
  title: "Sessions expire",
  status: "accepted",
  decision: "An expired session is never returned.",
  reason: "",
  consequences: "",
  rules: [rule],
  version: 2,
  createdBy: "alice",
  createdAt: "2026-10-18T03:00:00Z",
};
const files = [{ path: "src/auth/session.ts", content: "export const s = 1;\n" }];

describe("ai_review", () => {
  it("is noted as not run without a model", async () => {
    expect(await runReviews(undefined, [{ adr, rule, files }], "fix")).toEqual([
      "ADR-3 ai_review not run (no model configured: GROQ_API_KEY): Are expired sessions kept out?",
    ]);
    expect(await runReviews(undefined, [], "fix")).toEqual([]);
  });

  it("asks the model with the decision, the question and the files, and keeps its answer short", async () => {
    let asked: ChatMessage[] = [];
    const reviewer = modelReviewer({
      complete: async (messages) => {
        asked = messages;
        return "  Looks fine:\n the expiry check stays.  ";
      },
    });
    expect(await runReviews(reviewer, [{ adr, rule, files }], "fix")).toEqual([
      "ADR-3 review of src/auth/session.ts (advisory): Looks fine: the expiry check stays.",
    ]);
    expect(asked[1]?.content).toContain("Are expired sessions kept out?");
    expect(asked[1]?.content).toContain("src/auth/session.ts");
  });

  it("notes a failing or slow model instead of failing", async () => {
    const failing: Reviewer = { review: async () => Promise.reject(new Error("rate limited")) };
    expect(await runReviews(failing, [{ adr, rule, files }], "fix")).toEqual(["ADR-3 review of src/auth/session.ts failed: rate limited"]);
    const slow: Reviewer = { review: () => new Promise(() => undefined) };
    expect((await runReviews(slow, [{ adr, rule, files }], "fix", 20))[0]).toMatch(/failed: no answer/);
  });
});
