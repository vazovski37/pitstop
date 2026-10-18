import type { Adr } from "@pitstop/protocol";
import type { CheckedFile, ReviewRule } from "./adr-rules.js";
import type { ChatMessage, Completer } from "./groq.js";

/**
 * The `ai_review` rules of the brain (design doc 9.1): a question a model answers about a change
 * to files in the rule's scope. Advisory only: the answer goes into `checks.details`, never refuses
 * a commit. Runs before the append, outside the repository's lock, and only when a model is
 * configured (GROQ_API_KEY); without one the rule is noted as not run.
 */
export interface ReviewInput {
  adr: Adr;
  rule: ReviewRule;
  /** The commit's intent. */
  intent: string;
  files: CheckedFile[];
}

export interface Reviewer {
  /** One or two sentences: does the change respect the decision, and what to look at. */
  review(input: ReviewInput): Promise<string>;
}

/** Characters of each file a model is shown. */
const FILE_CHARS = 8_000;

const SYSTEM_PROMPT = `You review a code change against one architecture decision of the repository.
Answer the question in one or two plain sentences: whether the change respects the decision, and if not, which line and why.
You are advisory: be specific and brief, and do not restate the decision.`;

export function modelReviewer(completer: Completer): Reviewer {
  return {
    async review(input) {
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              decision: `ADR-${input.adr.number} ${input.adr.title}: ${input.adr.decision}`,
              reason: input.adr.reason,
              question: input.rule.question,
              changeIntent: input.intent,
              files: input.files.map((f) => ({ path: f.path, content: f.content.slice(0, FILE_CHARS) })),
            },
            null,
            2,
          ),
        },
      ];
      return (await completer.complete(messages, { json: false })).replace(/\s+/g, " ").trim().slice(0, 500);
    },
  };
}

/**
 * Runs the reviews in scope and returns one advisory line each for `checks.details`. A review that
 * fails or takes longer than `timeoutMs` is noted, never fatal.
 */
export async function runReviews(
  reviewer: Reviewer | undefined,
  reviews: { adr: Adr; rule: ReviewRule; files: CheckedFile[] }[],
  intent: string,
  timeoutMs = 20_000,
): Promise<string[]> {
  if (reviews.length === 0) return [];
  if (reviewer === undefined) {
    return reviews.map((r) => `ADR-${r.adr.number} ai_review not run (no model configured: GROQ_API_KEY): ${r.rule.question}`);
  }
  return Promise.all(
    reviews.map(async (r) => {
      const where = r.files.map((f) => f.path).join(", ");
      let timer: NodeJS.Timeout | undefined;
      try {
        const answer = await Promise.race([
          reviewer.review({ adr: r.adr, rule: r.rule, intent, files: r.files }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
          }),
        ]);
        return `ADR-${r.adr.number} review of ${where} (advisory): ${answer}`;
      } catch (err) {
        return `ADR-${r.adr.number} review of ${where} failed: ${(err as Error).message}`;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }),
  );
}
