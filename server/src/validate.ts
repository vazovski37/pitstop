import type { Changeset, CommitRequest, Lsn, SymbolId } from "@pitstop/protocol";
import { GAP_LIMIT, RejectedCommit, SKIPPED_CHECKS, type Decision } from "./store.js";

/** What `PITSTOP_VALIDATE` allows: `off` appends anything, `warn` records write skew, `enforce` refuses it. */
export type ValidationMode = "off" | "warn" | "enforce";

export const parseValidationMode = (value: string | undefined): ValidationMode =>
  value === "off" || value === "enforce" ? value : "warn";

export interface SkewSymbol {
  symbolId: SymbolId;
  /** The entry that changed it. */
  lsn: Lsn;
  /** True when its public shape changed, the strongest signal (section 7.3). */
  signature: boolean;
}

export type Verdict =
  | { kind: "clean" }
  /** Write-write: the commit changes a file or symbol an entry in the gap also changed. Rebase, then retry. */
  | { kind: "conflict"; conflictsWith: Lsn[]; paths: string[]; symbols: SymbolId[] }
  /** Write skew: the commit read a symbol an entry in the gap changed (section 7.3). */
  | { kind: "skew"; conflictsWith: Lsn[]; symbols: SkewSymbol[] };

export type SkewVerdict = Extract<Verdict, { kind: "skew" }>;

/**
 * Compares a commit with the entries appended since it began (design doc section 7.1).
 * `gap` holds every entry after `min(baseLsn, readBaseLsn)`, in LSN order. Writes are checked
 * against entries after `baseLsn`, reads against entries after `readBaseLsn`, so a daemon that
 * applied entries while the agent worked still gets its earlier reads checked.
 */
export function validate(req: CommitRequest, gap: Changeset[]): Verdict {
  const readBase = req.readBaseLsn ?? req.baseLsn;
  const paths = new Set(req.files.map((f) => f.path));
  const writes = new Set([...req.writeSet, ...req.sigWriteSet]);
  const reads = new Set(req.readSet);

  const conflictLsns = new Set<Lsn>();
  const conflictPaths = new Set<string>();
  const conflictSymbols = new Set<SymbolId>();
  for (const entry of gap) {
    if (entry.lsn <= req.baseLsn) continue;
    for (const f of entry.files) {
      if (paths.has(f.path) || (f.fromPath !== undefined && paths.has(f.fromPath))) {
        conflictPaths.add(f.path);
        conflictLsns.add(entry.lsn);
      }
    }
    for (const symbol of new Set([...entry.writeSet, ...entry.sigWriteSet])) {
      if (writes.has(symbol)) {
        conflictSymbols.add(symbol);
        conflictLsns.add(entry.lsn);
      }
    }
  }
  if (conflictLsns.size > 0) {
    return {
      kind: "conflict",
      conflictsWith: [...conflictLsns].sort((a, b) => a - b),
      paths: [...conflictPaths].sort(),
      symbols: [...conflictSymbols].sort(),
    };
  }

  const skew: SkewSymbol[] = [];
  const skewLsns = new Set<Lsn>();
  for (const entry of gap) {
    if (entry.lsn <= readBase) continue;
    const signatures = new Set(entry.sigWriteSet);
    for (const symbol of new Set([...entry.writeSet, ...entry.sigWriteSet])) {
      if (reads.has(symbol)) {
        skew.push({ symbolId: symbol, lsn: entry.lsn, signature: signatures.has(symbol) });
        skewLsns.add(entry.lsn);
      }
    }
  }
  if (skew.length > 0) return { kind: "skew", conflictsWith: [...skewLsns].sort((a, b) => a - b), symbols: skew };

  return { kind: "clean" };
}

export const describeSkew = (verdict: SkewVerdict): string =>
  verdict.symbols.map((s) => `#${s.lsn} changed ${s.symbolId}${s.signature ? " (signature)" : ""}`).join("; ");

const list = (lsns: Lsn[]): string => lsns.map((l) => `#${l}`).join(", ");

/**
 * The validator as the store runs it inside an append (store.ts, `Decide`): what to record with
 * the changeset, or a `RejectedCommit`. Until AI repair exists, write skew is recorded (`warn`)
 * or refused (`enforce`); the daemon is told either way.
 */
export function decideCommit(
  req: CommitRequest,
  gap: Changeset[],
  head: Lsn,
  mode: ValidationMode,
): { decision: Decision; skew?: SkewVerdict } {
  if (mode === "off") return { decision: {} };
  if (gap.length > GAP_LIMIT) {
    throw new RejectedCommit(
      "constraint_failed",
      `more than ${GAP_LIMIT} entries behind head #${head}: rebase onto it and retry`,
    );
  }
  const verdict = validate(req, gap);
  switch (verdict.kind) {
    case "clean":
      return { decision: {} };
    case "conflict":
      throw new RejectedCommit(
        "constraint_failed",
        `changed since #${req.baseLsn} by ${list(verdict.conflictsWith)}: ${[...verdict.paths, ...verdict.symbols].join(", ")}. Rebase onto #${head} and retry`,
        verdict.conflictsWith,
      );
    case "skew": {
      const summary = describeSkew(verdict);
      if (mode === "enforce") {
        throw new RejectedCommit(
          "repair_failed",
          `write skew: ${summary}. AI repair is not available yet: rebase, re-read what changed, and retry`,
          verdict.conflictsWith,
        );
      }
      return {
        decision: { checks: { ...SKIPPED_CHECKS, details: `write skew, not repaired (PITSTOP_VALIDATE=warn): ${summary}` } },
        skew: verdict,
      };
    }
  }
}
