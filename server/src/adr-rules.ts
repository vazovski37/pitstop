import { posix } from "node:path";
import type { Adr, AdrRule, FileChange } from "@pitstop/protocol";

/**
 * The brain's rule engine (design doc 9.1): the mechanical rules of a repository's accepted ADRs,
 * run over a commit's files in milliseconds. Pure: no I/O, no clock, no store. The commit path
 * (app.ts) runs it inside the append, and `GET /repos/:o/:n/brain/recheck` over the tree at head.
 *
 *   forbid_import   files matching `files` may not import a module matching `target`
 *   forbid_call     ... may not call `call` (an identifier, or obj.method)
 *   forbid_pattern  ... may not contain a line matching `pattern` (a regular expression)
 *   ai_review       advisory, asked of a model (review.ts); never refuses on its own
 */

export type MechanicalRule = Exclude<AdrRule, { kind: "ai_review" }>;
export type ReviewRule = Extract<AdrRule, { kind: "ai_review" }>;

/** The longest `forbid_pattern` accepted. */
export const PATTERN_MAX = 200;
/** forbid_pattern looks at lines cut to this length, so one minified line cannot stall a commit. */
const LINE_MAX = 2_000;

// ---------------------------------------------------------------------------------------------
// Globs: `**` any number of path segments, `*` anything within one segment, `?` one character.

const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

/** The regular expression a glob stands for, anchored. Also valid in Postgres (`~`), which the store uses. */
export function globToRegExpSource(glob: string): string {
  const g = normalize(glob);
  let re = "";
  for (let i = 0; i < g.length; ) {
    const c = g[i] as string;
    if (c === "*" && g[i + 1] === "*") {
      if (g[i + 2] === "/") {
        re += "(?:.*/)?"; // `**/`: zero or more whole segments
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
      i += 1;
    }
  }
  return `^${re}$`;
}

const globCache = new Map<string, RegExp>();
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re === undefined) {
    re = new RegExp(globToRegExpSource(glob));
    if (globCache.size > 1_000) globCache.clear();
    globCache.set(glob, re);
  }
  return re;
}

export const matchGlob = (glob: string, path: string): boolean => globToRegExp(glob).test(normalize(path));

// ---------------------------------------------------------------------------------------------
// Source text: comments out, strings out, offsets kept so line numbers hold.

/**
 * `code`: the text with comments blanked (strings kept, for import specifiers). `bare`: comments
 * and string contents blanked (for calls, so `"db.query("` in a message is not a call). Newlines
 * and offsets are kept. A light scanner, not a parser: a regex literal holding a quote can blank
 * the rest of its line, never more, since a quoted string stops at a newline.
 */
export function maskSource(text: string): { code: string; bare: string } {
  const code = text.split("");
  const bare = text.split("");
  const blank = (chars: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
  };
  const n = text.length;
  for (let i = 0; i < n; ) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j += 2;
        else if (c !== "`" && text[j] === "\n") break;
        else j += 1;
      }
      blank(bare, i + 1, Math.min(j, n));
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return { code: code.join(""), bare: bare.join("") };
}

/** 1-based line of an offset. */
const lineIndex = (text: string): ((offset: number) => number) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

// ---------------------------------------------------------------------------------------------
// Imports.

export interface ImportRef {
  specifier: string;
  line: number;
}

const STATIC_IMPORT = /(?:^|[^\w$.])((?:import|export)\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s*)?)(["'])([^"'\n]+)\2/g;
const DYNAMIC_IMPORT = /(?:^|[^\w$.])(import\s*\(\s*)(["'`])([^"'`\n]+)\2\s*\)/g;
const REQUIRE = /(?:^|[^\w$.])(require\s*\(\s*)(["'`])([^"'`\n]+)\2\s*\)/g;

/** Every module a TS/JS file imports: `import … from`, `export … from`, `import()`, `require()`. */
export function extractImports(text: string): ImportRef[] {
  const { code } = maskSource(text);
  const lineOf = lineIndex(code);
  const seen = new Set<string>();
  const refs: ImportRef[] = [];
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT, REQUIRE]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      const keyword = m.index + m[0].indexOf(m[1] as string);
      const ref = { specifier: m[3] as string, line: lineOf(keyword) };
      const key = `${ref.line}\n${ref.specifier}`;
      if (!seen.has(key)) {
        seen.add(key);
        refs.push(ref);
      }
    }
  }
  return refs.sort((a, b) => a.line - b.line);
}

const JS_EXT = /\.(?:m|c)?jsx?$/;
const KNOWN_EXT = /\.(?:m|c)?[jt]sx?$|\.json$|\.css$|\.scss$|\.svg$/;

/**
 * The repository paths an import may stand for. Relative specifiers resolve against the importing
 * file (`.ts`, `.tsx`, `.js`, `/index.ts`, … tried in order; `./x.js` also means `./x.ts`, as in
 * an ESM TypeScript project); with `exists`, the first that exists wins. A bare specifier is a
 * package name, or a path from the project root (`src/db/client`). Outside the repository: none.
 */
export function importTargets(specifier: string, fromFile: string, exists?: (path: string) => boolean): { paths: string[]; external: boolean } {
  const relative = specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
  let base: string;
  if (relative) {
    base = posix.normalize(posix.join(posix.dirname(normalize(fromFile)), specifier));
    if (base === ".." || base.startsWith("../")) return { paths: [], external: false };
  } else {
    base = normalize(specifier);
  }
  base = base.replace(/\/+$/, "");
  let candidates: string[];
  if (JS_EXT.test(base)) {
    const stem = base.replace(JS_EXT, "");
    candidates = [`${stem}.ts`, `${stem}.tsx`, base];
  } else if (KNOWN_EXT.test(base)) {
    candidates = [base];
  } else {
    candidates = [`${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, base];
  }
  const found = exists === undefined ? undefined : candidates.find((p) => exists(p));
  const paths = found !== undefined ? [found] : candidates;
  return relative ? { paths, external: false } : { paths: paths.includes(specifier) ? paths : [...paths, specifier], external: true };
}

/** What an import is, when `target` (a path glob or a package name) covers it. */
export function importMatch(target: string, specifier: string, fromFile: string, exists?: (path: string) => boolean): string | undefined {
  const t = importTargets(specifier, fromFile, exists);
  if (t.external && (specifier === target || specifier.startsWith(`${target}/`))) return specifier;
  return t.paths.find((p) => matchGlob(target, p));
}

// ---------------------------------------------------------------------------------------------
// Calls and patterns.

const IDENT = /^[A-Za-z_$][\w$]*$/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `foo(` or `obj.method(` (also `obj?.method(` and `foo<T>(`), not `function foo(`; undefined for a malformed `call`. */
export function callRegExp(call: string): RegExp | undefined {
  const parts = call.split(".").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !IDENT.test(p))) return undefined;
  const body = parts.map(escapeRe).join("\\s*\\??\\.\\s*");
  // A lone identifier must not be a method of something else (`x.foo(` is not `foo(`).
  const notMember = parts.length === 1 ? "(?<!\\.\\s*)" : "";
  return new RegExp(`(?<![\\w$])${notMember}(?<!\\bfunction\\s+)${body}\\s*(?:<[^<>()\\n]*>\\s*)?\\(`, "g");
}

/**
 * Why a `forbid_pattern` cannot be used, or undefined when it can: too long, not a regular
 * expression, or a nested quantifier such as `(a+)+` that can backtrack for minutes.
 */
export function patternProblem(pattern: string): string | undefined {
  if (pattern.length > PATTERN_MAX) return `pattern longer than ${PATTERN_MAX} characters`;
  try {
    new RegExp(pattern);
  } catch (err) {
    return `not a regular expression: ${(err as Error).message}`;
  }
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) return "nested quantifiers (like (a+)+) can take exponential time";
  return undefined;
}

/** Why a rule cannot be used, or undefined when it can. Checked when an ADR is proposed. */
export function ruleProblem(rule: AdrRule): string | undefined {
  if (rule.kind === "forbid_pattern") return patternProblem(rule.pattern);
  if (rule.kind === "forbid_call" && callRegExp(rule.call) === undefined) return `call must be an identifier or obj.method, not ${rule.call}`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The check.

export interface CheckedFile {
  path: string;
  content: string;
}

/** The files of a commit the rules look at: those it adds or modifies (or renames) with content. */
export const checkedFiles = (files: FileChange[]): CheckedFile[] =>
  files.flatMap((f) => (f.op !== "delete" && f.content !== undefined ? [{ path: f.path, content: f.content }] : []));

export interface Violation {
  adr: number;
  title: string;
  rule: MechanicalRule;
  file: string;
  line: number;
  /** What the line does: `imports src/db/client.ts`, `calls db.query()`, `matches /…/`. */
  detail: string;
}

export interface RuleReport {
  violations: Violation[];
  /** Mechanical rules whose `files` matched at least one checked file. */
  applied: number;
  /** `ai_review` rules in scope, with the files they cover. */
  reviews: { adr: Adr; rule: ReviewRule; files: CheckedFile[] }[];
  /** Rules that could not run, one line each (a pattern that no longer compiles). */
  broken: string[];
}

export interface CheckOptions {
  /** Whether a repository path exists, for resolving imports exactly; without it every candidate counts. */
  exists?: (path: string) => boolean;
}

/** Runs the mechanical rules of the accepted ADRs over the files; lists the ai_review rules in scope. */
export function checkFiles(adrs: Adr[], files: CheckedFile[], opts: CheckOptions = {}): RuleReport {
  const report: RuleReport = { violations: [], applied: 0, reviews: [], broken: [] };
  const masks = new Map<string, { code: string; bare: string; lineOf: (offset: number) => number }>();
  const mask = (f: CheckedFile) => {
    let m = masks.get(f.path);
    if (m === undefined) {
      const { code, bare } = maskSource(f.content);
      m = { code, bare, lineOf: lineIndex(f.content) };
      masks.set(f.path, m);
    }
    return m;
  };
  const imports = new Map<string, ImportRef[]>();
  const importsOf = (f: CheckedFile) => {
    let refs = imports.get(f.path);
    if (refs === undefined) {
      refs = extractImports(f.content);
      imports.set(f.path, refs);
    }
    return refs;
  };

  for (const adr of adrs) {
    if (adr.status !== "accepted") continue;
    for (const rule of adr.rules) {
      const scope = files.filter((f) => matchGlob(rule.files, f.path));
      if (scope.length === 0) continue;
      if (rule.kind === "ai_review") {
        report.reviews.push({ adr, rule, files: scope });
        continue;
      }
      report.applied += 1;
      const add = (file: string, line: number, detail: string) =>
        report.violations.push({ adr: adr.number, title: adr.title, rule, file, line, detail });
      switch (rule.kind) {
        case "forbid_import":
          for (const f of scope) {
            for (const ref of importsOf(f)) {
              const hit = importMatch(rule.target, ref.specifier, f.path, opts.exists);
              if (hit !== undefined) add(f.path, ref.line, `imports ${hit}`);
            }
          }
          break;
        case "forbid_call": {
          const re = callRegExp(rule.call);
          if (re === undefined) {
            report.broken.push(`ADR-${adr.number}: ${describeRule(rule)}: not an identifier or obj.method`);
            break;
          }
          for (const f of scope) {
            const m = mask(f);
            re.lastIndex = 0;
            const lines = new Set<number>();
            for (let hit = re.exec(m.bare); hit !== null; hit = re.exec(m.bare)) {
              const line = m.lineOf(hit.index);
              if (!lines.has(line)) {
                lines.add(line);
                add(f.path, line, `calls ${rule.call}()`);
              }
            }
          }
          break;
        }
        case "forbid_pattern": {
          const problem = patternProblem(rule.pattern);
          if (problem !== undefined) {
            report.broken.push(`ADR-${adr.number}: ${describeRule(rule)}: ${problem}`);
            break;
          }
          let re: RegExp;
          try {
            re = new RegExp(rule.pattern);
          } catch {
            break;
          }
          for (const f of scope) {
            f.content.split("\n").forEach((text, i) => {
              if (re.test(text.slice(0, LINE_MAX))) add(f.path, i + 1, `matches /${rule.pattern}/${rule.message ? ` (${rule.message})` : ""}`);
            });
          }
          break;
        }
      }
    }
  }
  report.violations.sort((a, b) => a.adr - b.adr || a.file.localeCompare(b.file) || a.line - b.line);
  return report;
}

/** One line per rule, the way agents and refusals name it. */
export function describeRule(rule: AdrRule): string {
  switch (rule.kind) {
    case "forbid_import":
      return `forbid_import ${rule.files} -> ${rule.target}`;
    case "forbid_call":
      return `forbid_call ${rule.files}: ${rule.call}()`;
    case "forbid_pattern":
      return `forbid_pattern ${rule.files}: /${rule.pattern}/${rule.message ? ` (${rule.message})` : ""}`;
    case "ai_review":
      return `ai_review ${rule.files}: ${rule.question}`;
  }
}

/** Violations listed in a refusal before the rest is counted. */
const LISTED = 12;

/**
 * What an agent is told when a commit breaks an ADR: per ADR, each offending line and the rule,
 * then what the ADR's decision says to do instead.
 *
 *   ADR-1 "Pages never touch the database": src/pages/Profile.tsx:3 imports src/db/client.ts, which the
 *   rule forbid_import src/pages/** -> src/db/** forbids. Do instead: Pages read data through src/services.
 */
export function refusalMessage(violations: Violation[], adrs: Adr[], version: number): string {
  const byAdr = new Map<number, Violation[]>();
  for (const v of violations.slice(0, LISTED)) byAdr.set(v.adr, [...(byAdr.get(v.adr) ?? []), v]);
  const lines = [...byAdr.entries()].map(([number, vs]) => {
    const adr = adrs.find((a) => a.number === number);
    const what = vs.map((v) => `${v.file}:${v.line} ${v.detail}, which the rule ${describeRule(v.rule)} forbids`).join("; ");
    return `ADR-${number} "${vs[0]?.title ?? ""}": ${what}. Do instead: ${adr?.decision ?? "see the ADR"}`;
  });
  const more = violations.length > LISTED ? `\n(and ${violations.length - LISTED} more)` : "";
  return `refused by this repository's architecture decisions (brain v${version}):\n${lines.join("\n")}${more}\nChange those lines to follow the decision and commit again.`;
}
