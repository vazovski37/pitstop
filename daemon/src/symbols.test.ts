import { describe, expect, it } from "vitest";
import { symbolSets, type Tree } from "./symbols.js";
import { demoTree, edited } from "./test-support.js";

const S = "src/auth/session.ts";
const ROUTER = "src/router.ts";
const HOME = "src/pages/HomePage.ts";
const PROFILE = "src/pages/ProfilePage.ts";

// Each case builds two TypeScript programs; under a full parallel `npm test` the first, cold one
// (lib.d.ts parsed from scratch) can take well over vitest's default 5 s.
describe("symbol sets on the demo slice (demo/scenario.md)", { timeout: 30_000 }, () => {
  const base = demoTree();

  it("sees no change between identical trees", () => {
    expect(symbolSets(base, base)).toEqual({ writeSet: [], sigWriteSet: [], readSet: [] });
  });

  it("laptop A: the expired-session fix changes getCurrentUser's signature and its callers", () => {
    let after = edited(
      base,
      S,
      `export function getCurrentUser(now = new Date()): SessionUser {
  if (!current) throw new Error("not signed in");
  return current.user;
}`,
      `export function getCurrentUser(now = new Date()): SessionUser | null {
  if (!current || now >= current.expiresAt) return null;
  return current.user;
}`,
    );
    after = edited(
      after,
      ROUTER,
      `      return html(renderProfile(getCurrentUser().id));`,
      `    {
      const user = getCurrentUser();
      return user ? html(renderProfile(user.id)) : redirect("/login");
    }`,
    );
    after = edited(
      after,
      HOME,
      "  return `<h1>Welcome back, ${user.name}</h1>`;",
      '  return user ? `<h1>Welcome back, ${user.name}</h1>` : "<h1>Welcome, guest</h1>";',
    );
    const sets = symbolSets(base, after, "C:\\laptop-a\\teamdb");
    expect(sets.writeSet).toEqual([`${S}#getCurrentUser`, `${HOME}#renderHome`, `${ROUTER}#handle`]);
    expect(sets.sigWriteSet).toEqual([`${S}#getCurrentUser`]);
    expect(sets.readSet).toEqual(
      expect.arrayContaining([`${S}#current`, `${S}#Session`, `${S}#getCurrentUser`, `${ROUTER}#redirect`, `${PROFILE}#renderProfile`]),
    );
    expect(sets.readSet.some((id) => /#(Date|Error|Map)$/.test(id))).toBe(false);
  });

  it("laptop B: the last-seen feature writes renderProfile and reads the session layer and timeAgo", () => {
    const after = edited(
      base,
      PROFILE,
      `import { findUser } from "../models/user.js";

/** The signed-in user's own profile page. Showing when they were last seen is TeamDB issue #61. */
export function renderProfile(userId: string): string {
  const user = findUser(userId);
  if (!user) return "<p>No such user</p>";
  return \`<h1>\${user.name}</h1>\\n<p>\${user.email}</p>\`;
}`,
      `import { getCurrentUser } from "../auth/session.js";
import { findUser } from "../models/user.js";
import { timeAgo } from "../utils/timeAgo.js";

/** The signed-in user's own profile page. */
export function renderProfile(userId: string): string {
  const user = findUser(userId);
  if (!user) return "<p>No such user</p>";
  const session = getCurrentUser();
  return \`<h1>\${user.name}</h1>\\n<p>\${user.email}</p>\\n<p>Last seen \${timeAgo(session.lastSeenAt)}</p>\`;
}`,
    );
    const sets = symbolSets(base, after);
    expect(sets.writeSet).toEqual([`${PROFILE}#renderProfile`]);
    expect(sets.sigWriteSet).toEqual([]);
    expect(sets.readSet).toEqual(
      expect.arrayContaining([`${S}#getCurrentUser`, `${S}#SessionUser`, "src/utils/timeAgo.ts#timeAgo", "src/models/user.ts#findUser"]),
    );
    expect(sets.readSet).not.toContain(`${PROFILE}#renderProfile`);
  });
});

describe("symbol sets on a small project", { timeout: 30_000 }, () => {
  const tsconfig = JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" }, include: ["src"] });
  const a = `export class Counter {
  private n = 0;
  bump(by: number): number {
    this.n += by;
    return this.n;
  }
  reset(): void {
    this.n = 0;
  }
}
export function f(x: number): number {
  return helper(x);
}
function helper(x: number) {
  return x * 2;
}
export const LIMIT = 10;
export type Id = string;
export interface Box {
  value: number;
}
export enum Color {
  Red,
  Green,
}
`;
  const base: Tree = new Map([
    ["tsconfig.json", tsconfig],
    ["src/a.ts", a],
    ["src/b.ts", `import { Counter, type Box } from "./a.js";\nexport const boxed = (c: Counter): Box => ({ value: c.bump(1) });\n`],
  ]);
  const A = "src/a.ts";
  const change = (from: string, to: string) => symbolSets(base, edited(base, A, from, to));

  it("a body change is a write but not a signature change", () => {
    expect(change("return x * 2;", "return x * 3;")).toEqual({ writeSet: [`${A}#helper`], sigWriteSet: [], readSet: [] });
  });

  it("an inferred return type that changes is a signature change", () => {
    const sets = change("return x * 2;", "return String(x);");
    expect(sets.writeSet).toEqual([`${A}#helper`]);
    expect(sets.sigWriteSet).toEqual([`${A}#helper`]);
  });

  it("names class members separately from the class", () => {
    const sets = change("this.n += by;", "this.n += by * 2;");
    expect(sets.writeSet).toEqual([`${A}#Counter.bump`]);
    expect(sets.sigWriteSet).toEqual([]);
    expect(sets.readSet).toEqual([`${A}#Counter.n`]);
  });

  it("a removed symbol is written and a signature change; an added one is only written", () => {
    const sets = change("export const LIMIT = 10;", "export function g(): void {}");
    expect(sets.writeSet).toEqual([`${A}#LIMIT`, `${A}#g`]);
    expect(sets.sigWriteSet).toEqual([`${A}#LIMIT`]);
  });

  it("an interface member, a type alias and an enum member are shape changes", () => {
    expect(change("value: number;", "value: number;\n  label?: string;").sigWriteSet).toEqual([`${A}#Box`]);
    expect(change("export type Id = string;", "export type Id = number;").sigWriteSet).toEqual([`${A}#Id`]);
    expect(change("Green,", "Green,\n  Blue,").sigWriteSet).toEqual([`${A}#Color`]);
  });

  it("reads cross files through imports and skip lib symbols", () => {
    const sets = symbolSets(base, edited(base, "src/b.ts", "c.bump(1)", "c.bump(new Date().getDay())"));
    expect(sets.writeSet).toEqual(["src/b.ts#boxed"]);
    expect(sets.readSet).toEqual([`${A}#Box`, `${A}#Counter`, `${A}#Counter.bump`]);
  });

  it("flattens namespaces", () => {
    const withNs = new Map(base);
    withNs.set("src/n.ts", "export namespace util {\n  export function id(x: string) {\n    return x;\n  }\n}\n");
    const after = new Map(withNs);
    after.set("src/n.ts", "export namespace util {\n  export function id(x: string) {\n    return x.trim();\n  }\n}\n");
    expect(symbolSets(withNs, after).writeSet).toEqual(["src/n.ts#util.id"]);
  });
});
