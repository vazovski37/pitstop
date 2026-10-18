import { describe, expect, it } from "vitest";
import type { Adr, AdrRule } from "@pitstop/protocol";
import {
  callRegExp,
  checkedFiles,
  checkFiles,
  describeRule,
  extractImports,
  globToRegExpSource,
  importMatch,
  importTargets,
  maskSource,
  matchGlob,
  patternProblem,
  refusalMessage,
  ruleProblem,
} from "./adr-rules.js";

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
  });
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
      { specifier: "../db/types.js", line: 2 },
      { specifier: "./multi", line: 3 },
      { specifier: "./reexported", line: 7 },
      { specifier: "lodash/fp", line: 8 },
      { specifier: "../db/lazy", line: 9 },
      { specifier: "fs", line: 10 },
      { specifier: "./side-effect.css", line: 12 },
    ]);
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
    const re = (call: string) => callRegExp(call) as RegExp;
    const hits = (call: string, text: string) => [...maskSource(text).bare.matchAll(re(call))].length;
    expect(hits("db.query", "await db.query('x')")).toBe(1);
    expect(hits("db.query", "await this.db.query('x')")).toBe(1);
    expect(hits("db.query", "db?.query<User>(sql)")).toBe(1);
    expect(hits("db.query", "dbx.query(1); db.queryAll(2); 'db.query(3)'")).toBe(0);
    expect(hits("eval", "eval(code)")).toBe(1);
    expect(hits("eval", "x.eval(code); function eval(c) {}; evaluate(c)")).toBe(0);
    expect(callRegExp("not a call!")).toBeUndefined();
  });

  it("refuses patterns that are too long, broken or catastrophic", () => {
    expect(patternProblem("console\\.log\\(")).toBeUndefined();
    expect(patternProblem("x".repeat(201))).toMatch(/longer/);
    expect(patternProblem("(unclosed")).toMatch(/not a regular expression/);
    expect(patternProblem("(a+)+$")).toMatch(/nested quantifiers/);
    expect(patternProblem("(.*a){10}")).toMatch(/nested quantifiers/);
    expect(ruleProblem({ kind: "forbid_call", files: "**", call: "a b" })).toMatch(/identifier/);
    expect(ruleProblem({ kind: "forbid_import", files: "**", target: "x" })).toBeUndefined();
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
    const broken = adr(4, [{ kind: "forbid_pattern", files: "**", pattern: "(a+)+" }]);
    const report = checkFiles([broken], [{ path: "a.ts", content: "aaaa" }]);
    expect(report.violations).toEqual([]);
    expect(report.broken[0]).toMatch(/ADR-4/);
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
