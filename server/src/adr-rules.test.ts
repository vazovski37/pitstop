import { describe, expect, it } from "vitest";
import type { Adr, AdrRule } from "@pitstop/protocol";
import {
  callRegExp,
  checkedFiles,
  checkFiles,
  describeRule,
  extractImports,
  findCalls,
  globProblem,
  globToRegExpSource,
  importAliases,
  importMatch,
  importTargets,
  LINEAR,
  maskSource,
  matchGlob,
  patternProblem,
  refusalMessage,
  ruleProblem,
  splitPreexisting,
} from "./adr-rules.js";

/** A backtracking engine needs minutes on these inputs; the budget only has to tell that from a busy, shared CI runner. */
const LINEAR_BUDGET_MS = 10_000;

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
  createdBy: "alice",
  createdAt: "2026-10-18T03:00:00Z",
  ...extra,
});

describe("globs", () => {
  it("** spans segments, * stays within one, ? is one character", () => {
    expect(matchGlob("src/pages/**", "src/pages/Profile.tsx")).toBe(true);
    expect(matchGlob("src/pages/**", "src/pages/admin/Users.tsx")).toBe(true);
    expect(matchGlob("src/pages/**", "src/pagesX/a.ts")).toBe(false);
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(matchGlob("**/*.test.ts", "a.test.ts")).toBe(true);
    expect(matchGlob("**/*.test.ts", "src/deep/a.test.ts")).toBe(true);
    expect(matchGlob("src/?.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/?.ts", "src/ab.ts")).toBe(false);
    expect(matchGlob("src/a.ts", "src/aXts")).toBe(false); // the dot is literal
    expect(matchGlob("./src/**", "src/a.ts")).toBe(true);
    expect(matchGlob("src/db/**", "src\\db\\client.ts")).toBe(true);
  });

  it("compiles to an anchored regular expression Postgres also reads", () => {
    expect(globToRegExpSource("src/**/x.ts")).toBe("^src/(?:.*/)?x\\.ts$");
    expect(globToRegExpSource("a+(b)")).toBe("^a\\+\\(b\\)$");
    expect(globToRegExpSource("src/*.{ts,tsx}")).toBe("^src/[^/]*\\.(?:ts|tsx)$");
  });

  it("reads braces and a trailing slash, which ruleProblem would otherwise let match nothing", () => {
    expect(matchGlob("src/**/*.{ts,tsx}", "src/a.ts")).toBe(true);
    expect(matchGlob("src/**/*.{ts,tsx}", "src/deep/B.tsx")).toBe(true);
    expect(matchGlob("src/**/*.{ts,tsx}", "src/a.js")).toBe(false);
    expect(matchGlob("src/{pages,components}/**", "src/components/x/Y.tsx")).toBe(true);
    expect(matchGlob("src/pages/", "src/pages/admin/Users.tsx")).toBe(true);
    expect(matchGlob("src/pages/", "src/pagesX/a.ts")).toBe(false);
    expect(matchGlob("src/***.ts", "src/a/b.ts")).toBe(true); // a run of stars is **
    expect(globProblem("src/{a,b")).toMatch(/unbalanced/);
    expect(globProblem("x".repeat(201))).toMatch(/longer than 200/);
    expect(globProblem("src/**")).toBeUndefined();
  });

  it("matches in linear time, so no glob stalls the server", () => {
    expect(LINEAR).toBe(true);
    const glob = `${"*a".repeat(30)}*b`; // backtracks for minutes on a backtracking engine
    const t0 = Date.now();
    expect(matchGlob(glob, `${"a".repeat(2_000)}.ts`)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(LINEAR_BUDGET_MS);
  }, 60_000);
});

describe("masking", () => {
  it("blanks comments in both views and strings only in the bare one, keeping lines", () => {
    const text = 'const a = "db.query(1)"; // db.query(2)\n/* db.query(3)\n */ db.query(4);';
    const { code, bare } = maskSource(text);
    expect(code.length).toBe(text.length);
    expect(code.split("\n")).toHaveLength(3);
    expect(code).toContain('"db.query(1)"');
    expect(code).not.toContain("db.query(2)");
    expect(code).not.toContain("db.query(3)");
    expect(bare).not.toContain("db.query(1)");
    expect(bare).toContain("db.query(4)");
  });

  it("skips regular expression literals, and never hides more than a line after an unterminated comment or template", () => {
    const regex = "const r = /`/;\nfetch('/api');\nconst s = x.split(/'/);\nreturn /\"/.test(y);\nrequire('../db/client');";
    const { bare } = maskSource(regex);
    expect(bare).toContain("fetch(");
    expect(bare).toContain("require(");
    expect(bare.split("\n")).toHaveLength(5);
    const jsx = "const a = <code>src/pages/*</code>;\nfetch('/api');\nconst t = `open\n";
    expect(maskSource(jsx).bare).toContain("fetch(");
    expect(maskSource("a = b / c; fetch(x) / 2;").bare).toContain("fetch(x)"); // a division is not a regex
  });
});

describe("imports", () => {
  it("finds import/export from, dynamic import and require, with lines, and ignores comments", () => {
    const text = [
      'import { db } from "../db/client";',
      "import type { User } from '../db/types.js';",
      "import {",
      "  a,",
      "  b,",
      '} from "./multi";',
      'export * from "./reexported";',
      'export { c } from "lodash/fp";',
      'const lazy = await import("../db/lazy");',
      'const old = require("fs");',
      '// import { no } from "../db/commented";',
      'import "./side-effect.css";',
      'export const notAnImport = "../db/string";',
    ].join("\n");
    expect(extractImports(text)).toEqual([
      { specifier: "../db/client", line: 1 },
      { specifier: "../db/types.js", line: 2, typeOnly: true },
      { specifier: "./multi", line: 3 },
      { specifier: "./reexported", line: 7 },
      { specifier: "lodash/fp", line: 8 },
      { specifier: "../db/lazy", line: 9 },
      { specifier: "fs", line: 10 },
      { specifier: "./side-effect.css", line: 12 },
    ]);
  });

  it("does not read an import inside a string or template, and puts a semicolon-less re-export's import on its own line", () => {
    const strings = ["const s = 'import x from \"src/db/client\"';", 'const t = `import("../db/lazy")`;', 'const u = "require(\'../db/x\')";'].join("\n");
    expect(extractImports(strings)).toEqual([]);
    expect(extractImports('export { a, b }\nimport c from "src/db/x";')).toEqual([{ specifier: "src/db/x", line: 2 }]);
    expect(extractImports("export type { User } from '../db/schema';")).toEqual([{ specifier: "../db/schema", line: 1, typeOnly: true }]);
    expect(extractImports("import type from 'typefest';")).toEqual([{ specifier: "typefest", line: 1 }]); // a default import named `type`
  });

  it("runs in linear time on a hostile file", () => {
    const t0 = Date.now();
    extractImports(`import ${" ".repeat(200_000)}x`);
    extractImports("import ".repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(LINEAR_BUDGET_MS);
  }, 60_000);

  it("resolves path aliases from tsconfig.json, and @/ and ~/ to src/ without one", () => {
    const next = importAliases('{\n  // Next.js\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"], "@db": ["src/db/index.ts"], }, },\n}');
    expect(importMatch("src/db/**", "@/db/client", "src/pages/a.tsx", undefined, next)).toBe("src/db/client.ts");
    expect(importMatch("src/db/**", "@db", "src/pages/a.tsx", undefined, next)).toBe("src/db/index.ts");
    expect(importMatch("src/db/**", "@/db/client", "src/pages/a.tsx", undefined, importAliases(undefined))).toBe("src/db/client.ts");
    expect(importMatch("src/db/**", "~/db/client", "src/pages/a.tsx", undefined, importAliases("{}"))).toBe("src/db/client.ts");
    const based = importAliases('{"compilerOptions": {"baseUrl": "src"}}');
    expect(importMatch("src/db/**", "db/client", "src/pages/a.tsx", undefined, based)).toBe("src/db/client.ts");
    expect(importMatch("src/db/**", "@scope/db", "src/pages/a.tsx", undefined, next)).toBeUndefined();
    const report = checkFiles([adr(1, [{ kind: "forbid_import", files: "src/pages/**", target: "src/db/**" }])], [{ path: "src/pages/a.tsx", content: 'import { db } from "@/db/client";\n' }]);
    expect(report.violations.map((v) => v.detail)).toEqual(["imports src/db/client.ts"]);
  });

  it("resolves relative specifiers against the importing file, trying .ts, .tsx, .js and /index.ts", () => {
    expect(importTargets("../db/client", "src/pages/Profile.tsx").paths[0]).toBe("src/db/client.ts");
    expect(importTargets("../db/client.js", "src/pages/Profile.tsx").paths).toEqual(["src/db/client.ts", "src/db/client.tsx", "src/db/client.js"]);
    const tree = new Set(["src/db/index.ts", "src/ui/Button.tsx"]);
    expect(importTargets("../db", "src/pages/a.ts", (p) => tree.has(p)).paths).toEqual(["src/db/index.ts"]);
    expect(importTargets("../ui/Button", "src/pages/a.ts", (p) => tree.has(p)).paths).toEqual(["src/ui/Button.tsx"]);
    expect(importTargets("../../../outside", "src/pages/a.ts").paths).toEqual([]);
    expect(importTargets("axios", "src/pages/a.ts")).toMatchObject({ external: true });
  });

  it("matches a path glob or a package name", () => {
    expect(importMatch("src/db/**", "../db/client", "src/pages/a.tsx")).toBe("src/db/client.ts");
    expect(importMatch("src/db/client.ts", "../db/client.js", "src/pages/a.tsx")).toBe("src/db/client.ts");
    expect(importMatch("src/db/**", "../services/users", "src/pages/a.tsx")).toBeUndefined();
    expect(importMatch("axios", "axios", "src/a.ts")).toBe("axios");
    expect(importMatch("lodash", "lodash/fp", "src/a.ts")).toBe("lodash/fp");
    expect(importMatch("lodash", "lodash-es", "src/a.ts")).toBeUndefined();
    expect(importMatch("src/db/**", "src/db/client", "src/pages/a.ts")).toBe("src/db/client.ts"); // a baseUrl import
  });
});

describe("calls and patterns", () => {
  it("matches a call, not a declaration, a member of something else or a string", () => {
    const hits = (call: string, text: string) => findCalls(maskSource(text).bare, call).length;
    expect(hits("db.query", "await db.query('x')")).toBe(1);
    expect(hits("db.query", "await this.db.query('x')")).toBe(1);
    expect(hits("db.query", "db?.query<User>(sql)")).toBe(1);
    expect(hits("db.query", "dbx.query(1); db.queryAll(2); 'db.query(3)'")).toBe(0);
    expect(hits("eval", "eval(code)")).toBe(1);
    expect(hits("eval", "x.eval(code); function eval(c) {}; evaluate(c); function* eval(d) {}")).toBe(0);
    expect(hits("then", "promise\n  .then(x)")).toBe(0);
    expect(callRegExp("not a call!")).toBeUndefined();
  });

  it("does not take a method definition or signature for a call", () => {
    const hits = (text: string) => findCalls(maskSource(text).bare, "query").length;
    expect(hits("class Repo {\n  query() {\n    return 1;\n  }\n}")).toBe(0);
    expect(hits("const repo = {\n  async query(sql) {\n  },\n};")).toBe(0);
    expect(hits("interface Db {\n  query(sql: string): Promise<Row[]>;\n  static get query(): number;\n}")).toBe(0);
    expect(hits("  query(sql);\n")).toBe(1);
    expect(hits("  const rows = query(sql);\n  if (ok) { query(other) }\n")).toBe(2);
  });

  it("refuses patterns that are too long, broken or cannot run in linear time; runs the rest in linear time", () => {
    expect(patternProblem("console\\.log\\(")).toBeUndefined();
    expect(patternProblem("x".repeat(201))).toMatch(/longer/);
    expect(patternProblem("(unclosed")).toMatch(/not a regular expression/);
    expect(patternProblem("(a)\\1")).toMatch(/linear time/);
    expect(patternProblem("a(?!b)")).toMatch(/linear time/);
    expect(patternProblem("a{1,1000}")).toMatch(/linear time/);
    // Catastrophic on a backtracking engine; harmless on the linear one, so allowed.
    for (const pattern of ["(a|aa)+$", "((a+))+$", "(a|a)*b", "(\\w|\\d)+$"]) {
      expect(patternProblem(pattern)).toBeUndefined();
      const t0 = Date.now();
      const report = checkFiles([adr(9, [{ kind: "forbid_pattern", files: "**", pattern }])], [{ path: "x.txt", content: `${"a".repeat(1_000)}!\n` }]);
      expect(report.violations).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(LINEAR_BUDGET_MS);
    }
    expect(ruleProblem({ kind: "forbid_call", files: "**", call: "a b" })).toMatch(/identifier/);
    expect(ruleProblem({ kind: "forbid_call", files: "**", call: "a".repeat(101) })).toMatch(/longer than 100/);
    expect(ruleProblem({ kind: "forbid_import", files: "**", target: "x" })).toBeUndefined();
    expect(ruleProblem({ kind: "forbid_import", files: "src/{a", target: "x" })).toMatch(/^files: unbalanced/);
    expect(ruleProblem({ kind: "forbid_import", files: "**", target: "y".repeat(201) })).toMatch(/^target: glob longer/);
    expect(ruleProblem({ kind: "forbid_pattern", files: "**", pattern: "x", message: "m".repeat(501) })).toMatch(/message longer/);
    expect(ruleProblem({ kind: "ai_review", files: "**", question: "q".repeat(1_001) })).toMatch(/question longer/);
  }, 60_000);

  it("matches a pattern on a CRLF file's lines", () => {
    const report = checkFiles([adr(2, [{ kind: "forbid_pattern", files: "**", pattern: "debugger;$" }])], [{ path: "a.ts", content: "let a = 1;\r\ndebugger;\r\n" }]);
    expect(report.violations.map((v) => [v.line, v.text])).toEqual([[2, "debugger;"]]);
  });
});

describe("checkFiles", () => {
  const pages: Adr = adr(1, [
    { kind: "forbid_import", files: "src/pages/**", target: "src/db/**" },
    { kind: "forbid_call", files: "src/pages/**", call: "db.query" },
  ]);
  const logger: Adr = adr(2, [{ kind: "forbid_pattern", files: "src/**", pattern: "console\\.log\\(", message: "use the logger" }]);
  const review: Adr = adr(3, [{ kind: "ai_review", files: "src/auth/**", question: "Are expired sessions kept out?" }]);

  it("reports each violation with its ADR, rule, file and line", () => {
    const report = checkFiles([pages, logger], [
      { path: "src/pages/Profile.tsx", content: 'import { db } from "../db/client";\n\nexport const P = () => db.query("select 1");\n' },
      { path: "src/services/users.ts", content: 'import { db } from "../db/client";\nconsole.log("hi");\n' },
    ]);
    expect(report.applied).toBe(3);
    expect(report.violations.map((v) => [v.adr, v.file, v.line, v.detail])).toEqual([
      [1, "src/pages/Profile.tsx", 1, "imports src/db/client.ts"],
      [1, "src/pages/Profile.tsx", 3, "calls db.query()"],
      [2, "src/services/users.ts", 2, "matches /console\\.log\\(/ (use the logger)"],
    ]);
  });

  it("passes code that follows the rules, and skips rules out of scope or not accepted", () => {
    const fine = checkFiles([pages], [{ path: "src/pages/Profile.tsx", content: 'import { getUser } from "../services/users";\n' }]);
    expect(fine).toMatchObject({ violations: [], applied: 2 });
    const none = checkFiles([pages], [{ path: "README.md", content: 'import x from "src/db/client"' }]);
    expect(none).toMatchObject({ violations: [], applied: 0 });
    const proposed = checkFiles([{ ...pages, status: "proposed" }], [{ path: "src/pages/a.ts", content: 'import "../db/x";' }]);
    expect(proposed).toMatchObject({ violations: [], applied: 0 });
  });

  it("lists the ai_review rules in scope without running them", () => {
    const report = checkFiles([review], [{ path: "src/auth/session.ts", content: "export const s = 1;\n" }, { path: "src/a.ts", content: "" }]);
    expect(report.applied).toBe(0);
    expect(report.reviews.map((r) => [r.adr.number, r.files.map((f) => f.path)])).toEqual([[3, ["src/auth/session.ts"]]]);
  });

  it("notes a rule that cannot run instead of failing the commit", () => {
    const broken = adr(4, [{ kind: "forbid_pattern", files: "**", pattern: "(a)\\1" }]);
    const report = checkFiles([broken], [{ path: "a.ts", content: "aaaa" }]);
    expect(report.violations).toEqual([]);
    expect(report.broken[0]).toMatch(/ADR-4/);
  });

  it("reads imports and calls in code files only; a pattern reads every file", () => {
    const rules = adr(5, [
      { kind: "forbid_import", files: "src/pages/**", target: "src/db/**" },
      { kind: "forbid_call", files: "src/pages/**", call: "fetch" },
      { kind: "forbid_pattern", files: "src/pages/**", pattern: "TODO" },
    ]);
    const report = checkFiles([rules], [
      { path: "src/pages/README.md", content: '```ts\nimport { db } from "../db/client";\nfetch("/x");\n```\nTODO\n' },
      { path: "src/pages/data.json", content: '{"import": "x"}\n' },
    ]);
    expect(report.violations.map((v) => [v.file, v.line, v.detail])).toEqual([["src/pages/README.md", 5, "matches /TODO/"]]);
    expect(report.applied).toBe(1);
  });

  it("skips type-only imports, which compile to nothing", () => {
    const report = checkFiles([pages], [{ path: "src/pages/a.ts", content: 'import type { Row } from "../db/schema";\nimport { type Row2, db } from "../db/client";\n' }]);
    expect(report.violations.map((v) => v.line)).toEqual([2]);
  });

  it("tells a change's own violations from the ones its file already had", () => {
    const before = checkFiles([pages], [{ path: "src/pages/Legacy.tsx", content: 'import { db } from "../db/client";\nexport const L = 1;\n' }]).violations;
    const typo = checkFiles([pages], [{ path: "src/pages/Legacy.tsx", content: 'import { db } from "../db/client";\nexport const L = 2;\n' }]).violations;
    expect(splitPreexisting(typo, before)).toMatchObject({ introduced: [], preexisting: [{ line: 1 }] });
    const more = checkFiles([pages], [{ path: "src/pages/Legacy.tsx", content: 'import { db } from "../db/client";\nexport const L = () => db.query("x");\n' }]).violations;
    expect(splitPreexisting(more, before)).toMatchObject({ introduced: [{ line: 2, detail: "calls db.query()" }], preexisting: [{ line: 1 }] });
  });

  it("checks only files added or modified with content", () => {
    expect(
      checkedFiles([
        { path: "a.ts", op: "add", content: "a" },
        { path: "b.ts", op: "delete" },
        { path: "c.ts", op: "modify" },
        { path: "d.ts", op: "rename", fromPath: "e.ts", content: "d" },
      ]).map((f) => f.path),
    ).toEqual(["a.ts", "d.ts"]);
  });

  it("writes a refusal an agent can act on", () => {
    const report = checkFiles([pages], [{ path: "src/pages/Profile.tsx", content: 'import { db } from "../db/client";\n' }]);
    expect(refusalMessage(report.violations, [pages], 1)).toBe(
      [
        "refused by this repository's architecture decisions (brain v1):",
        'ADR-1 "ADR 1": src/pages/Profile.tsx:1 imports src/db/client.ts, which the rule forbid_import src/pages/** -> src/db/** forbids. Do instead: decision 1',
        "Change those lines to follow the decision and commit again.",
      ].join("\n"),
    );
    expect(describeRule({ kind: "ai_review", files: "src/auth/**", question: "q?" })).toBe("ai_review src/auth/**: q?");
  });
});
