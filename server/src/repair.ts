import type { Changeset, CommitRequest, FileChange, Lsn, Repair } from "@pitstop/protocol";
import { typecheckGate } from "./checks.js";
import type { ChatMessage, Completer } from "./groq.js";
import { hashedFiles, RejectedCommit, type Decision, type Tree } from "./store.js";
import { describeSkew, type SkewVerdict } from "./validate.js";

/**
 * Who resolves write skew (design doc 7.3). `agent`: the coding agent that committed, told
 * exactly what changed, fixes its change and commits again. `groq`: the server asks a model for
 * a patch and type-checks it. `off`: the validator's PITSTOP_VALIDATE behaviour.
 */
export type RepairMode = "off" | "agent" | "groq";

export const parseRepairMode = (value: string | undefined): RepairMode =>
  value === "agent" || value === "groq" ? value : "off";

export interface RepairInput {
  request: CommitRequest;
  skew: SkewVerdict;
  /** The entries after the commit's base, as the validator saw them. */
  gap: Changeset[];
  headLsn: Lsn;
  /** The tree the commit must fit: `treeAt(headLsn)`. */
  head: Tree;
  /** The tree the agent read: `treeAt(gapStart(request))`. */
  base: Tree;
}

/** A proposed fix: full new contents for some of the commit's own files, and one line about it. */
export interface Patch {
  files: { path: string; content: string }[];
  summary: string;
}

export interface Repairer {
  /** `previousErrors` carries the type errors of the last attempt, when there was one. */
  propose(input: RepairInput, previousErrors?: string): Promise<Patch>;
}

/** The entries that changed what the commit read, with what they did. */
const culprits = (input: Pick<RepairInput, "skew" | "gap">): Changeset[] =>
  input.gap.filter((e) => input.skew.conflictsWith.includes(e.lsn));

/**
 * What the committing agent is told when it is the resolver, or when repair gave up:
 * a `rejected` answer with reason `escalated` that says what changed and what to do.
 */
export function escalation(input: Pick<RepairInput, "request" | "skew" | "gap" | "headLsn">, reason?: string): RejectedCommit {
  const changed = culprits(input)
    .map((e) => `#${e.lsn} "${e.intent}" (${e.files.map((f) => f.path).join(", ")})`)
    .join("; ");
  const lead = reason ?? "write skew";
  return new RejectedCommit(
    "escalated",
    `${lead}: ${describeSkew(input.skew)}. Changed by: ${changed}. Re-read those files at head #${input.headLsn}, adapt your change to them, and commit again with baseLsn ${input.headLsn}.`,
    input.skew.conflictsWith,
  );
}

/**
 * Asks the repairer for a patch, type-checks it against head, and tries once more with the
 * errors if it fails. Two failures escalate (design doc 7.5). The decision carries the repaired
 * files, so the entry every worktree receives is the fixed one.
 */
export async function repairCommit(input: RepairInput, repairer: Repairer, attempts = 2): Promise<Decision> {
  const own = new Set(input.request.files.map((f) => f.path));
  let errors: string | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let patch: Patch;
    try {
      patch = await repairer.propose(input, errors);
    } catch (err) {
      errors = `the repair model failed: ${(err as Error).message}`;
      continue;
    }
    const stray = patch.files.filter((f) => !own.has(f.path)).map((f) => f.path);
    if (stray.length > 0) {
      errors = `the patch touched files outside the commit: ${stray.join(", ")}`;
      continue;
    }
    const files: FileChange[] = hashedFiles(
      input.request.files.map((f) => {
        const fixed = patch.files.find((p) => p.path === f.path);
        return fixed !== undefined && f.op !== "delete" ? { ...f, content: fixed.content } : f;
      }),
    );
    const gate = await typecheckGate(input.head, files);
    if (gate.typecheck === "fail") {
      errors = gate.details ?? "type check failed";
      continue;
    }
    const repairs: Repair[] = input.skew.conflictsWith.map((lsn) => ({ againstLsn: lsn, kind: "semantic", summary: patch.summary }));
    return {
      files,
      repairs,
      checks: {
        typecheck: gate.typecheck,
        tests: "skipped",
        adr: "skipped",
        details: `repaired after write skew (${describeSkew(input.skew)}): ${patch.summary}`,
      },
    };
  }
  throw escalation(input, `write skew could not be repaired after ${attempts} attempts (${errors ?? "no patch"})`);
}

const SYSTEM_PROMPT = `You repair a code change that was written against an older version of something it depends on.
Another change landed first and altered a symbol this change read. Edit only this change's own files,
as little as possible, so that they are correct against the new version while keeping the change's intent.
Answer with JSON only, of the form {"files":[{"path":"...","content":"<complete new file content>"}],"summary":"<one line>"}.
Only paths listed under "yourFiles" may appear, each with its whole content. Leave out files that need no edit.`;

/** The Groq-backed repairer: both intents, the dependency before and after, the commit's files; a patch back. */
export function modelRepairer(completer: Completer): Repairer {
  return {
    async propose(input, previousErrors) {
      const changedSince = culprits(input).map((e) => ({
        lsn: e.lsn,
        intent: e.intent,
        files: e.files.map((f) => ({ path: f.path, before: input.base.get(f.path) ?? null, after: f.content ?? null })),
      }));
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              yourIntent: input.request.intent,
              yourFiles: input.request.files.map((f) => ({ path: f.path, content: f.content ?? null })),
              symbolsYouReadThatChanged: input.skew.symbols,
              changedSince,
              ...(previousErrors === undefined ? {} : { previousAttemptErrors: previousErrors }),
            },
            null,
            2,
          ),
        },
      ];
      return parsePatch(await completer.complete(messages, { json: true }));
    },
  };
}

/** Reads the model's answer: the first JSON object in it, with the shape of a Patch. */
export function parsePatch(text: string): Patch {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("the model did not answer with JSON");
  const raw: unknown = JSON.parse(text.slice(start, end + 1));
  if (typeof raw !== "object" || raw === null) throw new Error("the model's JSON is not an object");
  const { files, summary } = raw as { files?: unknown; summary?: unknown };
  if (!Array.isArray(files)) throw new Error("the model's JSON has no files array");
  const checked = files.map((f: unknown) => {
    const { path, content } = (f ?? {}) as { path?: unknown; content?: unknown };
    if (typeof path !== "string" || typeof content !== "string") throw new Error("a patched file needs a path and content");
    return { path, content };
  });
  return { files: checked, summary: typeof summary === "string" && summary.trim() !== "" ? summary.trim() : "repaired after write skew" };
}
