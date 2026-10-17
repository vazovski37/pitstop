import { describe, expect, it } from "vitest";
import type { Changeset, CommitRequest } from "@pitstop/protocol";
import type { ChatMessage } from "./groq.js";
import { escalation, modelRepairer, parsePatch, repairCommit, type Patch, type RepairInput, type Repairer } from "./repair.js";
import { RejectedCommit, SKIPPED_CHECKS, type Tree } from "./store.js";
import type { SkewVerdict } from "./validate.js";

// A dependency changed its signature underneath a commit that read it, the demo's shape in miniature.
const tsconfig = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] });
const depBefore = "export function dep(): string { return 'x'; }\n";
const depAfter = "export function dep(): string | null { return null; }\n";
const useBroken = 'import { dep } from "./dep.js";\nexport const n: number = dep().length;\n';
const useFixed = 'import { dep } from "./dep.js";\nexport const n: number = dep()?.length ?? 0;\n';

const base: Tree = new Map([["tsconfig.json", tsconfig], ["src/dep.ts", depBefore]]);
const head: Tree = new Map([["tsconfig.json", tsconfig], ["src/dep.ts", depAfter]]);

const culprit: Changeset = {
  repo: "teamdb/demo",
  lsn: 2,
  baseLsn: 1,
  author: { developer: "vazovski", agent: "agent-a" },
  intent: "dep may be missing",
  files: [{ path: "src/dep.ts", op: "modify", content: depAfter }],
  writeSet: ["src/dep.ts#dep"],
  sigWriteSet: ["src/dep.ts#dep"],
  readSet: [],
  repairs: [],
  checks: SKIPPED_CHECKS,
  brainVersion: 0,
  createdAt: "2026-10-17T14:20:05Z",
};

const request: CommitRequest = {
  idempotencyKey: "use-dep-00000001",
  baseLsn: 1,
  author: { developer: "teammate", agent: "agent-b" },
  intent: "use dep's length",
  files: [{ path: "src/use.ts", op: "add", content: useBroken }],
  writeSet: ["src/use.ts#n"],
  sigWriteSet: [],
  readSet: ["src/dep.ts#dep"],
};

const skew: SkewVerdict = { kind: "skew", conflictsWith: [2], symbols: [{ symbolId: "src/dep.ts#dep", lsn: 2, signature: true }] };
const input: RepairInput = { request, skew, gap: [culprit], headLsn: 2, head, base };

const repairerReturning = (patches: Patch[]): Repairer & { calls: (string | undefined)[] } => {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    async propose(_input, previousErrors) {
      calls.push(previousErrors);
      const patch = patches[Math.min(calls.length - 1, patches.length - 1)];
      if (!patch) throw new Error("no patch");
      return patch;
    },
  };
};

describe("repairCommit", () => {
  it("lands the patched files with the repair recorded when the patch type-checks", async () => {
    const repairer = repairerReturning([{ files: [{ path: "src/use.ts", content: useFixed }], summary: "guard against null" }]);
    const decision = await repairCommit(input, repairer);
    expect(decision.files?.[0]).toMatchObject({ path: "src/use.ts", op: "add", content: useFixed });
    expect(decision.files?.[0]?.blob).toMatch(/^sha256:/);
    expect(decision.repairs).toEqual([{ againstLsn: 2, kind: "semantic", summary: "guard against null" }]);
    expect(decision.checks).toMatchObject({ typecheck: "pass", details: expect.stringContaining("guard against null") });
    expect(repairer.calls).toEqual([undefined]);
  }, 60_000);

  it("tries once more with the errors, then escalates", async () => {
    const repairer = repairerReturning([{ files: [{ path: "src/use.ts", content: useBroken }], summary: "no change" }]);
    let caught: unknown;
    try {
      await repairCommit(input, repairer);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RejectedCommit);
    expect(caught).toMatchObject({ reason: "escalated", conflictsWith: [2] });
    expect((caught as Error).message).toMatch(/after 2 attempts/);
    expect(repairer.calls).toHaveLength(2);
    expect(repairer.calls[1]).toMatch(/TS18047|TS2531|error TS/);
  }, 60_000);

  it("refuses a patch that touches files outside the commit", async () => {
    const repairer = repairerReturning([
      { files: [{ path: "src/dep.ts", content: depBefore }], summary: "revert the dependency" },
      { files: [{ path: "src/use.ts", content: useFixed }], summary: "guard against null" },
    ]);
    const decision = await repairCommit(input, repairer);
    expect(decision.repairs?.[0]?.summary).toBe("guard against null");
    expect(repairer.calls[1]).toMatch(/outside the commit: src\/dep.ts/);
  }, 60_000);
});

describe("escalation", () => {
  it("tells the agent what changed and what to do", () => {
    const err = escalation(input);
    expect(err.reason).toBe("escalated");
    expect(err.conflictsWith).toEqual([2]);
    expect(err.message).toContain("#2 changed src/dep.ts#dep (signature)");
    expect(err.message).toContain('#2 "dep may be missing" (src/dep.ts)');
    expect(err.message).toContain("commit again with baseLsn 2");
  });
});

describe("modelRepairer", () => {
  it("sends both sides to the model and parses its JSON answer", async () => {
    let sent: ChatMessage[] = [];
    const completer = {
      async complete(messages: ChatMessage[]) {
        sent = messages;
        return `Here you go:\n{"files":[{"path":"src/use.ts","content":${JSON.stringify(useFixed)}}],"summary":"guard against null"}`;
      },
    };
    const patch = await modelRepairer(completer).propose(input, "previous errors here");
    expect(patch).toEqual({ files: [{ path: "src/use.ts", content: useFixed }], summary: "guard against null" });
    expect(sent[0]?.role).toBe("system");
    const user = JSON.parse(sent[1]?.content ?? "{}") as Record<string, unknown>;
    expect(user.yourIntent).toBe("use dep's length");
    expect(user.changedSince).toEqual([{ lsn: 2, intent: "dep may be missing", files: [{ path: "src/dep.ts", before: depBefore, after: depAfter }] }]);
    expect(user.previousAttemptErrors).toBe("previous errors here");
  });

  it("rejects answers that are not a patch", () => {
    expect(() => parsePatch("no json here")).toThrow(/JSON/);
    expect(() => parsePatch('{"summary":"x"}')).toThrow(/files/);
    expect(() => parsePatch('{"files":[{"path":"a"}]}')).toThrow(/path and content/);
    expect(parsePatch('{"files":[],"summary":"  "}').summary).toBe("repaired after write skew");
  });
});
