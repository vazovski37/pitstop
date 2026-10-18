import { posix } from "node:path";
import v8 from "node:v8";
import type { Adr, AdrRule, FileChange } from "@pitstop/protocol";

/**
 * The brain's rule engine (design doc 9.1): the mechanical rules of a repository's accepted ADRs,
 * run over a commit's files in milliseconds. Pure: no I/O, no clock, no store. The commit path
 * (app.ts) runs it before and inside the append, and `GET /repos/:o/:n/brain/recheck` over the
 * tree at head.
 *
 *   forbid_import   code files matching `files` may not import a module matching `target`
 *   forbid_call     ... may not call `call` (an identifier, or obj.method)
 *   forbid_pattern  any file matching `files` may not contain a line matching `pattern` (a regular expression)
 *   ai_review       advisory, asked of a model (review.ts); never refuses on its own
 *
 * Every regular expression that comes from a user (a pattern, a glob) runs on V8's linear-time
 * engine (the `l` flag), so no rule and no path can stall the shared server's event loop: a
 * pattern that engine cannot run (backreferences, lookahead) is refused when it is proposed.
 */

// V8's linear-time engine. Set here, once, for the whole process: the server, its tests and the
// dev server all import this module before compiling a user's expression.
v8.setFlagsFromString("--enable-experimental-regexp-engine");

/** Whether the linear-time engine is on (`new RegExp(…, "l")`). A test asserts it. */
export const LINEAR: boolean = (() => {
  try {
    new RegExp("a", "l");
    return true;
  } catch {
    return false;
  }
})();

/**
 * A regular expression that runs in time linear in its input. Throws a SyntaxError when the
 * source cannot run that way (backreferences, lookahead, a large counted repeat),
 * or when this Node has no linear engine: a user's expression is then refused, never run.
 */
export function linearRegExp(source: string, flags = ""): RegExp {
  if (!LINEAR) throw new SyntaxError("this server's JavaScript engine has no linear-time regular expressions");
  return new RegExp(source, `${flags}l`);
}

/** The engine's own fixed expressions: linear where possible, the usual engine otherwise. */
const fixedRegExp = (source: string, flags = ""): RegExp => {
  try {
    return linearRegExp(source, flags);
  } catch {
    return new RegExp(source, flags);
  }
};

export type MechanicalRule = Exclude<AdrRule, { kind: "ai_review" }>;
export type ReviewRule = Extract<AdrRule, { kind: "ai_review" }>;

/** The longest `forbid_pattern` accepted. */
export const PATTERN_MAX = 200;
/** Caps on the other fields of a rule, checked when an ADR is proposed. */
export const RULE_LIMITS = { glob: 200, call: 100, message: 500, question: 1_000 } as const;
/** forbid_pattern looks at lines cut to this length, so one minified line costs little. */
const LINE_MAX = 2_000;
/** How much of a line a violation quotes. */
const TEXT_MAX = 200;
/** forbid_import and forbid_call read code; a Markdown file or a JSON file is text, not imports. */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;

// ---------------------------------------------------------------------------------------------
// Globs: `**` any number of path segments, `*` anything within one segment, `?` one character,
// `{a,b}` either, and a trailing `/` everything under that folder.

const normalize = (path: string): string => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

const bracesBalance = (glob: string): boolean => {
  let depth = 0;
  for (const c of glob) {
    if (c === "{") depth += 1;
    else if (c === "}" && --depth < 0) return false;
  }
  return depth === 0;
};

/**
 * The regular expression a glob stands for, anchored. Also valid in Postgres (`~`), which the
 * store uses. Runs of `*` collapse to `**`. Unbalanced braces are literal (ruleProblem refuses them).
 */
export function globToRegExpSource(glob: string): string {
  let g = normalize(glob).replace(/\*{3,}/g, "**");
  if (g.endsWith("/")) g += "**";
  const braces = bracesBalance(g);
  let re = "";
  let depth = 0;
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
    } else if (braces && c === "{") {
      re += "(?:";
      depth += 1;
      i += 1;
    } else if (braces && c === "}") {
      re += ")";
      depth -= 1;
      i += 1;
    } else if (braces && c === "," && depth > 0) {
      re += "|";
      i += 1;
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
      i += 1;
    }
  }
  return `^${re}$`;
}

/** Why a glob (a rule's `files` or `target`, `touches` on the log) cannot be used, or undefined. */
export function globProblem(glob: string): string | undefined {
  if (glob.trim() === "") return "empty glob";
  if (glob.length > RULE_LIMITS.glob) return `glob longer than ${RULE_LIMITS.glob} characters`;
  if (!bracesBalance(glob)) return "unbalanced { } in glob";
  try {
    linearRegExp(globToRegExpSource(glob));
  } catch (err) {
    return `glob cannot be matched: ${(err as Error).message}`;
  }
  return undefined;
}

const NEVER = /$^/;
const globCache = new Map<string, RegExp>();
/** A glob as a linear-time regular expression; one that cannot compile matches nothing. */
export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (re === undefined) {
    try {
      re = linearRegExp(globToRegExpSource(glob));
    } catch {
      re = NEVER;
    }
    if (globCache.size > 1_000) globCache.clear();
    globCache.set(glob, re);
  }
  return re;
}

export const matchGlob = (glob: string, path: string): boolean => globToRegExp(glob).test(normalize(path));

// ---------------------------------------------------------------------------------------------
// Source text: comments out, strings out, offsets kept so line numbers hold.

/** After one of these (or at the start), a `/` begins a regular expression literal, not a division. */
const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^"]);
/** Keywords after which a `/` begins a regular expression literal. */
const REGEX_AFTER_WORD = new Set(["return", "typeof", "case", "do", "else", "in", "of", "void", "yield", "await", "delete", "new", "instanceof", "throw"]);
const isIdent = (c: string | undefined): boolean => c !== undefined && /[\w$]/.test(c);
const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * `code`: the text with comments blanked (strings kept, for import specifiers). `bare`: comments,
 * string contents and regular expression literals blanked (for calls, so `"db.query("` in a
 * message is not a call). Newlines and offsets are kept. A light scanner, not a parser: an
 * unterminated block comment or template literal (`src/pages/*` in JSX text, say) blanks only the
 * rest of its line, and a quoted string stops at a newline, so a misreading never hides more than
 * the rest of one line.
 */
export function maskSource(text: string): { code: string; bare: string } {
  const code = text.split("");
  const bare = text.split("");
  const blank = (chars: string[], from: number, to: number) => {
    for (let k = from; k < to; k++) if (chars[k] !== "\n" && chars[k] !== "\r") chars[k] = " ";
  };
  const n = text.length;
  const lineEnd = (from: number): number => {
    const end = text.indexOf("\n", from);
    return end < 0 ? n : end;
  };
  /** The last significant character of code before here, and where it is. */
  let prev = "";
  let prevAt = -1;
  const regexMayStart = (): boolean => {
    if (REGEX_AFTER.has(prev)) return true;
    if (!isIdent(prev)) return false;
    let k = prevAt;
    while (k > 0 && prevAt - k < 12 && isIdent(text[k - 1])) k -= 1;
    return REGEX_AFTER_WORD.has(text.slice(k, prevAt + 1)) && !isIdent(text[k - 1]);
  };
  for (let i = 0; i < n; ) {
    const c = text[i] as string;
    if (c === "/" && text[i + 1] === "/") {
      const stop = lineEnd(i);
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? lineEnd(i) : end + 2;
      blank(code, i, stop);
      blank(bare, i, stop);
      i = stop;
    } else if (c === "/" && regexMayStart()) {
      // A regular expression literal: to its closing slash on the same line, past escapes and classes.
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        const d = text[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (inClass) {
          if (d === "]") inClass = false;
        } else if (d === "[") inClass = true;
        else if (d === "/") break;
        j += 1;
      }
      if (j < n && text[j] === "/") {
        blank(code, i + 1, j);
        blank(bare, i + 1, j);
        prev = ")"; // a value: a `/` after it divides
        prevAt = j;
        i = j + 1;
      } else {
        prev = c;
        prevAt = i;
        i += 1;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === "\\") j += 2;
        else if (c !== "`" && text[j] === "\n") break;
        else j += 1;
      }
      if (c === "`" && j >= n) j = lineEnd(i); // unterminated: the rest of its line, no more
      blank(bare, i + 1, Math.min(j, n));
      prev = ")";
      prevAt = Math.min(j, n - 1);
      i = j + 1;
    } else {
      if (!isSpace(c)) {
        prev = c;
        prevAt = i;
      }
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

const splitLines = (text: string): string[] => text.split(/\r?\n/);

// ---------------------------------------------------------------------------------------------
// Imports.

export interface ImportRef {
  specifier: string;
  line: number;
  /** `import type …` / `export type … from`: erased at compile time, so no rule counts it. */
  typeOnly?: boolean;
}

const STATIC_IMPORT = fixedRegExp(`(?:^|[^\\w$.])((?:import|export)\\s+(?:type\\s+)?(?:[\\w$*{},\\s]+?\\s+from\\s*)?)(?:"([^"\\n]+)"|'([^'\\n]+)')`, "g");
const DYNAMIC_IMPORT = fixedRegExp("(?:^|[^\\w$.])(import\\s*\\(\\s*)(?:\"([^\"\\n]+)\"|'([^'\\n]+)'|`([^`\\n]+)`)\\s*\\)", "g");
const REQUIRE = fixedRegExp("(?:^|[^\\w$.])(require\\s*\\(\\s*)(?:\"([^\"\\n]+)\"|'([^'\\n]+)'|`([^`\\n]+)`)\\s*\\)", "g");
const KEYWORD = /\b(?:import|export)\b/g;
const TYPE_ONLY = /^(?:import|export)\s+type\s+(?!from\b)[\w${*]/;

/** Every module a TS/JS file imports: `import … from`, `export … from`, `import()`, `require()`. Not in comments or strings. */
export function extractImports(text: string): ImportRef[] {
  const { code, bare } = maskSource(text);
  const lineOf = lineIndex(code);
  const seen = new Set<string>();
  const refs: ImportRef[] = [];
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT, REQUIRE]) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m !== null; m = re.exec(code)) {
      let clause = m[1] as string;
      let keyword = m.index + m[0].indexOf(clause);
      // `export { a }` with no semicolon, then `import b from "x"`: the clause spans both, and the
      // specifier belongs to the last statement in it.
      if (re === STATIC_IMPORT) {
        let last = 0;
        KEYWORD.lastIndex = 1;
        for (let k = KEYWORD.exec(clause); k !== null; k = KEYWORD.exec(clause)) last = k.index;
        clause = clause.slice(last);
        keyword += last;
      }
      // An `import` inside a string is text: there, the bare view is blank.
      if (bare[keyword] !== code[keyword]) continue;
      const specifier = (m[2] ?? m[3] ?? m[4]) as string;
      const ref: ImportRef = { specifier, line: lineOf(keyword), ...(re === STATIC_IMPORT && TYPE_ONLY.test(clause) ? { typeOnly: true } : {}) };
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

/** A project's import aliases: tsconfig.json's `compilerOptions.paths` and `baseUrl`. */
export interface ImportAliases {
  /** Bare specifiers also resolve from here (a repository path, "" for the root). */
  baseUrl?: string;
  /** `"@/*": ["src/*"]`, targets as repository paths. */
  paths: { pattern: string; targets: string[] }[];
}

/** What `@/x` and `~/x` mean when the project says nothing: the Next.js and Vite convention. */
export const DEFAULT_ALIASES: ImportAliases = {
  paths: [
    { pattern: "@/*", targets: ["src/*"] },
    { pattern: "~/*", targets: ["src/*"] },
  ],
};

/**
 * The aliases a root tsconfig.json declares (comments and trailing commas allowed); without one,
 * or one without `paths`, `@/` and `~/` stand for `src/`.
 */
export function importAliases(tsconfig: string | undefined): ImportAliases {
  if (tsconfig === undefined) return DEFAULT_ALIASES;
  let options: { baseUrl?: unknown; paths?: unknown } | undefined;
  try {
    const json = maskSource(tsconfig).code.replace(/,(\s*[}\]])/g, "$1");
    options = (JSON.parse(json) as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } }).compilerOptions;
  } catch {
    return DEFAULT_ALIASES;
  }
  const baseUrl = typeof options?.baseUrl === "string" ? normalize(posix.normalize(options.baseUrl)).replace(/^\.$/, "") : undefined;
  const root = baseUrl ?? "";
  const paths: ImportAliases["paths"] = [];
  if (options?.paths !== null && typeof options?.paths === "object") {
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const repoTargets = targets.filter((t): t is string => typeof t === "string").map((t) => normalize(posix.normalize(posix.join(root || ".", t))));
      if (repoTargets.length > 0) paths.push({ pattern, targets: repoTargets });
    }
  }
  if (paths.length === 0) return { ...DEFAULT_ALIASES, ...(baseUrl === undefined ? {} : { baseUrl }) };
  return { paths, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

/** The repository paths an aliased specifier stands for; empty when no alias matches it. */
function expandAlias(specifier: string, aliases: ImportAliases): string[] {
  const out: string[] = [];
  for (const { pattern, targets } of aliases.paths) {
    const star = pattern.indexOf("*");
    if (star < 0) {
      if (specifier === pattern) out.push(...targets);
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    out.push(...targets.map((t) => t.replace("*", captured)));
  }
  return out;
}

const candidatesOf = (base: string): string[] => {
  const b = base.replace(/\/+$/, "");
  if (JS_EXT.test(b)) {
    const stem = b.replace(JS_EXT, "");
    return [`${stem}.ts`, `${stem}.tsx`, b];
  }
  if (KNOWN_EXT.test(b)) return [b];
  return [`${b}.ts`, `${b}.tsx`, `${b}.js`, `${b}/index.ts`, `${b}/index.tsx`, `${b}/index.js`, b];
};

/**
 * The repository paths an import may stand for. Relative specifiers resolve against the importing
 * file (`.ts`, `.tsx`, `.js`, `/index.ts`, … tried in order; `./x.js` also means `./x.ts`, as in
 * an ESM TypeScript project); with `exists`, the first that exists wins. An aliased specifier
 * (`@/db/client`, from `aliases`) resolves through the alias. Any other bare specifier is a
 * package name, or a path from the project root or `baseUrl` (`src/db/client`). Outside the
 * repository: none.
 */
export function importTargets(
  specifier: string,
  fromFile: string,
  exists?: (path: string) => boolean,
  aliases?: ImportAliases,
): { paths: string[]; external: boolean } {
  const relative = specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
  let bases: string[];
  let external = false;
  if (relative) {
    const base = posix.normalize(posix.join(posix.dirname(normalize(fromFile)), specifier));
    if (base === ".." || base.startsWith("../")) return { paths: [], external: false };
    bases = [base];
  } else {
    const aliased = aliases === undefined ? [] : expandAlias(specifier, aliases);
    if (aliased.length > 0) {
      bases = aliased;
    } else {
      bases = [normalize(specifier)];
      if (aliases?.baseUrl) bases.push(normalize(posix.join(aliases.baseUrl, specifier)));
      external = true;
    }
  }
  const candidates = [...new Set(bases.flatMap(candidatesOf))];
  const found = exists === undefined ? undefined : candidates.find((p) => exists(p));
  const paths = found !== undefined ? [found] : candidates;
  return external ? { paths: paths.includes(specifier) ? paths : [...paths, specifier], external: true } : { paths, external: false };
}

/** What an import is, when `target` (a path glob or a package name) covers it. */
export function importMatch(target: string, specifier: string, fromFile: string, exists?: (path: string) => boolean, aliases?: ImportAliases): string | undefined {
  const t = importTargets(specifier, fromFile, exists, aliases);
  if (t.external && (specifier === target || specifier.startsWith(`${target}/`))) return specifier;
  return t.paths.find((p) => matchGlob(target, p));
}

// ---------------------------------------------------------------------------------------------
// Calls and patterns.

const IDENT = /^[A-Za-z_$][\w$]*$/;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text of a call to `call` (`foo(`, `obj.method(`, also `obj?.method(` and `foo<T>(`), without
 * its context; undefined for a malformed `call`. `findCalls` decides what precedes and follows it.
 */
export function callRegExp(call: string): RegExp | undefined {
  const parts = call.split(".").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !IDENT.test(p))) return undefined;
  const body = parts.map(escapeRe).join("\\s*\\??\\.\\s*");
  return fixedRegExp(`${body}\\s*(?:<[^<>()\\n]*>\\s*)?\\(`, "g");
}

/** Words that may stand before a method's name in a class, object or interface. */
const MODIFIERS = /^[\s{,]*(?:(?:async|static|get|set|public|private|protected|override|readonly|abstract|declare)\s+|\*\s*)*$/;

/**
 * Offsets of the calls to `call` in `bare` (maskSource's view): not `function foo(`, not a member
 * of something else (`x.foo(` for `foo`), not part of a longer name, and not a method definition
 * or signature (`query() {`, `async query(): Promise<T>;`).
 */
export function findCalls(bare: string, call: string): number[] {
  const re = callRegExp(call);
  if (re === undefined) return [];
  const single = !call.includes(".");
  const hits: number[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(bare); m !== null; m = re.exec(bare)) {
    const at = m.index;
    if (isIdent(bare[at - 1])) continue;
    // What stands before it, past whitespace.
    let k = at - 1;
    while (k >= 0 && isSpace(bare[k])) k -= 1;
    if (single && bare[k] === ".") continue;
    if (bare[k] === "*") {
      k -= 1;
      while (k >= 0 && isSpace(bare[k])) k -= 1;
    }
    if (k >= 7 && bare.slice(k - 7, k + 1) === "function" && !isIdent(bare[k - 8])) continue;
    if (definition(bare, at, at + m[0].length - 1)) continue;
    hits.push(at);
  }
  return hits;
}

/** Whether the "call" at `at`, whose `(` is at `open`, is a method definition or signature. */
function definition(bare: string, at: number, open: number): boolean {
  // Only whitespace or modifiers before it on its line (looked at up to 200 characters back).
  let start = at;
  while (start > 0 && bare[start - 1] !== "\n" && at - start < 200) start -= 1;
  if (start > 0 && bare[start - 1] !== "\n") return false;
  if (!MODIFIERS.test(bare.slice(start, at))) return false;
  // Its closing parenthesis (within 2,000 characters), then `{` or `:` on the same line.
  let depth = 0;
  let close = -1;
  for (let j = open; j < bare.length && j - open < 2_000; j++) {
    if (bare[j] === "(") depth += 1;
    else if (bare[j] === ")" && --depth === 0) {
      close = j;
      break;
    }
  }
  if (close < 0) return false;
  let j = close + 1;
  while (bare[j] === " " || bare[j] === "\t") j += 1;
  return bare[j] === "{" || bare[j] === ":";
}

/**
 * Why a `forbid_pattern` cannot be used, or undefined when it can: too long, not a regular
 * expression, or not one V8's linear-time engine runs (backreferences, lookahead, a
 * large counted repeat). Patterns run on that engine, so none can backtrack for minutes.
 */
export function patternProblem(pattern: string): string | undefined {
  if (pattern.length > PATTERN_MAX) return `pattern longer than ${PATTERN_MAX} characters`;
  try {
    new RegExp(pattern);
  } catch (err) {
    return `not a regular expression: ${(err as Error).message}`;
  }
  try {
    linearRegExp(pattern);
  } catch {
    return "cannot run in linear time: drop backreferences (\\1), lookahead ((?=…), (?!…)) and large counted repeats ({1,100})";
  }
  return undefined;
}

/** Why a rule cannot be used, or undefined when it can. Checked when an ADR is proposed. */
export function ruleProblem(rule: AdrRule): string | undefined {
  const files = globProblem(rule.files);
  if (files !== undefined) return `files: ${files}`;
  switch (rule.kind) {
    case "forbid_import": {
      const target = globProblem(rule.target);
      return target === undefined ? undefined : `target: ${target}`;
    }
    case "forbid_call":
      if (rule.call.length > RULE_LIMITS.call) return `call longer than ${RULE_LIMITS.call} characters`;
      return callRegExp(rule.call) === undefined ? `call must be an identifier or obj.method, not ${rule.call}` : undefined;
    case "forbid_pattern":
      if (rule.message !== undefined && rule.message.length > RULE_LIMITS.message) return `message longer than ${RULE_LIMITS.message} characters`;
      return patternProblem(rule.pattern);
    case "ai_review":
      return rule.question.length > RULE_LIMITS.question ? `question longer than ${RULE_LIMITS.question} characters` : undefined;
  }
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

/** Whether a mechanical rule of an accepted ADR covers this path (and so needs the file's content). */
export const mechanicalScope = (adrs: Adr[], path: string): boolean =>
  adrs.some((a) => a.status === "accepted" && a.rules.some((r) => r.kind !== "ai_review" && matchGlob(r.files, path) && (r.kind === "forbid_pattern" || CODE_FILE.test(path))));

export interface Violation {
  adr: number;
  title: string;
  rule: MechanicalRule;
  file: string;
  line: number;
  /** What the line does: `imports src/db/client.ts`, `calls db.query()`, `matches /…/`. */
  detail: string;
  /** The line itself, trimmed and cut short: how a violation is recognised in the file's older version. */
  text: string;
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
  /** The project's import aliases (tsconfig.json `paths`); default `@/` and `~/` for `src/`. */
  aliases?: ImportAliases;
}

/** Runs the mechanical rules of the accepted ADRs over the files; lists the ai_review rules in scope. */
export function checkFiles(adrs: Adr[], files: CheckedFile[], opts: CheckOptions = {}): RuleReport {
  const report: RuleReport = { violations: [], applied: 0, reviews: [], broken: [] };
  const aliases = opts.aliases ?? DEFAULT_ALIASES;
  const views = new Map<string, { bare: string; lineOf: (offset: number) => number; lines: string[] }>();
  const view = (f: CheckedFile) => {
    let v = views.get(f.path);
    if (v === undefined) {
      v = { bare: maskSource(f.content).bare, lineOf: lineIndex(f.content), lines: splitLines(f.content) };
      views.set(f.path, v);
    }
    return v;
  };
  const linesOf = (f: CheckedFile) => view(f).lines;
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
      const matched = files.filter((f) => matchGlob(rule.files, f.path));
      const scope = rule.kind === "forbid_import" || rule.kind === "forbid_call" ? matched.filter((f) => CODE_FILE.test(f.path)) : matched;
      if (scope.length === 0) continue;
      if (rule.kind === "ai_review") {
        report.reviews.push({ adr, rule, files: scope });
        continue;
      }
      report.applied += 1;
      const add = (f: CheckedFile, line: number, detail: string) =>
        report.violations.push({ adr: adr.number, title: adr.title, rule, file: f.path, line, detail, text: (linesOf(f)[line - 1] ?? "").trim().slice(0, TEXT_MAX) });
      switch (rule.kind) {
        case "forbid_import":
          for (const f of scope) {
            for (const ref of importsOf(f)) {
              if (ref.typeOnly) continue;
              const hit = importMatch(rule.target, ref.specifier, f.path, opts.exists, aliases);
              if (hit !== undefined) add(f, ref.line, `imports ${hit}`);
            }
          }
          break;
        case "forbid_call": {
          if (callRegExp(rule.call) === undefined) {
            report.broken.push(`ADR-${adr.number}: ${describeRule(rule)}: not an identifier or obj.method`);
            break;
          }
          for (const f of scope) {
            const v = view(f);
            const lines = new Set<number>();
            for (const at of findCalls(v.bare, rule.call)) {
              const line = v.lineOf(at);
              if (!lines.has(line)) {
                lines.add(line);
                add(f, line, `calls ${rule.call}()`);
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
          const re = linearRegExp(rule.pattern);
          for (const f of scope) {
            linesOf(f).forEach((text, i) => {
              if (re.test(text.slice(0, LINE_MAX))) add(f, i + 1, `matches /${rule.pattern}/${rule.message ? ` (${rule.message})` : ""}`);
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

/**
 * Splits a change's violations into the ones it introduced and the ones its base version already
 * had: the same ADR, rule, file, detail and line text (`base` already names each file by its
 * path in the change). Counted, so a second copy of an old line is new.
 */
export function splitPreexisting(violations: Violation[], base: Violation[]): { introduced: Violation[]; preexisting: Violation[] } {
  const key = (v: Violation) => `${v.adr}\n${describeRule(v.rule)}\n${v.file}\n${v.detail}\n${v.text}`;
  const left = new Map<string, number>();
  for (const v of base) left.set(key(v), (left.get(key(v)) ?? 0) + 1);
  const introduced: Violation[] = [];
  const preexisting: Violation[] = [];
  for (const v of violations) {
    const k = key(v);
    const n = left.get(k) ?? 0;
    if (n > 0) {
      left.set(k, n - 1);
      preexisting.push(v);
    } else {
      introduced.push(v);
    }
  }
  return { introduced, preexisting };
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
