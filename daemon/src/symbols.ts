/**
 * Read and write sets from the TypeScript compiler API (design doc section 5.2; daemon/CLAUDE.md,
 * Responsibility 4).
 *
 * Two programs are built from the worktree's own tsconfig.json: the state at `main` and the state
 * at `@`, both from in-memory trees. A symbol is a top-level declaration (function, class,
 * interface, type alias, enum, variable; namespaces are flattened as `ns.name`) or a class member
 * (`Class.member`), named `path#qualified.name` with the path relative to the worktree.
 *
 * - writeSet: symbols whose source text changed, plus those added or removed.
 * - sigWriteSet: the subset whose public shape changed: a function's signature as the checker
 *   prints it, a variable's type, an interface's or class's members, a type alias's structure. A
 *   removed symbol counts (its readers break); an added one does not (nobody could have read it).
 * - readSet: every project symbol referenced from a changed declaration's new text, types
 *   included, locals and parameters excluded, nothing from lib or node_modules.
 */
import ts from "typescript";
import type { SymbolId } from "@pitstop/protocol";

export interface SymbolSets {
  writeSet: SymbolId[];
  sigWriteSet: SymbolId[];
  readSet: SymbolId[];
}

/** Every tracked file of a worktree state: posix path relative to the worktree -> text. */
export type Tree = Map<string, string>;

export const EMPTY_SETS: SymbolSets = { writeSet: [], sigWriteSet: [], readSet: [] };

const isSource = (path: string): boolean => /\.(ts|tsx|mts|cts)$/.test(path);

export const hasTsProject = (tree: Tree): boolean => tree.has("tsconfig.json");

/**
 * The symbol sets of the change from `before` to `after`. `root` is the worktree directory and only
 * serves as the virtual location of the project (lib files still come from the real TypeScript).
 */
export function symbolSets(before: Tree, after: Tree, root = "/worktree"): SymbolSets {
  const base = posixRoot(root);
  const a = analyze(before, base);
  const b = analyze(after, base);

  const written = new Set<SymbolId>();
  const signatures = new Set<SymbolId>();
  for (const [id, decl] of b.symbols) {
    const old = a.symbols.get(id);
    if (!old) {
      written.add(id);
      continue;
    }
    if (old.text !== decl.text) written.add(id);
    if (old.shape !== decl.shape) {
      written.add(id);
      signatures.add(id);
    }
  }
  for (const id of a.symbols.keys()) {
    if (!b.symbols.has(id)) {
      written.add(id);
      signatures.add(id);
    }
  }

  const read = new Set<SymbolId>();
  for (const id of written) {
    const decl = b.symbols.get(id);
    if (!decl) continue;
    for (const ref of b.referencesFrom(decl)) if (ref !== id) read.add(ref);
  }

  return { writeSet: sorted(written), sigWriteSet: sorted(signatures), readSet: sorted(read) };
}

const sorted = (ids: Set<SymbolId>): SymbolId[] => [...ids].sort();

const posixRoot = (root: string): string => root.replace(/\\/g, "/").replace(/\/+$/, "") || "/";

interface Decl {
  id: SymbolId;
  node: ts.Node;
  text: string;
  shape: string;
}

class Analysis {
  readonly symbols = new Map<SymbolId, Decl>();
  private readonly owners = new Map<ts.Node, SymbolId>();
  private readonly checker: ts.TypeChecker;

  constructor(
    readonly program: ts.Program,
    readonly root: string,
  ) {
    this.checker = program.getTypeChecker();
    for (const sf of program.getSourceFiles()) {
      const path = this.pathOf(sf.fileName);
      if (path === undefined) continue;
      this.collect(sf.statements, path, "", sf);
    }
  }

  /** The ids of every project symbol a declaration refers to. */
  referencesFrom(decl: Decl): Set<SymbolId> {
    const out = new Set<SymbolId>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) this.resolve(node, out);
      node.forEachChild(visit);
    };
    decl.node.forEachChild(visit);
    return out;
  }

  private resolve(id: ts.Identifier, out: Set<SymbolId>): void {
    let symbol = this.checker.getSymbolAtLocation(id);
    if (!symbol) return;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    for (const d of symbol.declarations ?? []) {
      const owner = this.ownerOf(d);
      if (owner !== undefined) out.add(owner);
    }
  }

  private ownerOf(node: ts.Node): SymbolId | undefined {
    for (let n: ts.Node | undefined = node; n; n = n.parent) {
      const id = this.owners.get(n);
      if (id !== undefined) return id;
    }
    return undefined;
  }

  /** A project file's path relative to the root, or undefined for lib and node_modules files. */
  private pathOf(fileName: string): string | undefined {
    const name = fileName.replace(/\\/g, "/");
    if (!name.startsWith(`${this.root}/`)) return undefined;
    const rel = name.slice(this.root.length + 1);
    return rel.startsWith("node_modules/") ? undefined : rel;
  }

  private collect(statements: readonly ts.Statement[], path: string, prefix: string, sf: ts.SourceFile): void {
    const add = (node: ts.Node, name: string, text = node.getText(sf)) => {
      const id: SymbolId = `${path}#${prefix}${name}`;
      this.symbols.set(id, { id, node, text, shape: this.shape(node) });
      this.owners.set(node, id);
    };
    for (const st of statements) {
      if (ts.isFunctionDeclaration(st) && st.name) add(st, st.name.text);
      else if (ts.isClassDeclaration(st) && st.name) {
        add(st, st.name.text, sf.text.slice(st.getStart(sf), st.members.pos));
        for (const member of st.members) {
          const name = memberName(member);
          if (name !== undefined) add(member, `${st.name.text}.${name}`);
        }
      } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
        add(st, st.name.text);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) add(d, d.name.text);
      } else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name) && st.body && ts.isModuleBlock(st.body)) {
        this.collect(st.body.statements, path, `${prefix}${st.name.text}.`, sf);
      }
    }
  }

  /** What readers of the symbol depend on; a change here is a signature change. */
  private shape(node: ts.Node): string {
    const c = this.checker;
    const flags = ts.TypeFormatFlags.NoTruncation;
    const typeAt = (n: ts.Node) => c.typeToString(c.getTypeAtLocation(n), node, flags);
    if (ts.isFunctionLike(node)) {
      const sig = c.getSignatureFromDeclaration(node);
      return sig ? c.signatureToString(sig, node, flags) : node.getText();
    }
    if (ts.isVariableDeclaration(node)) return typeAt(node.name);
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      return `${node.questionToken ? "?" : ""}${typeAt(node.name)}`;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      return c.typeToString(c.getTypeAtLocation(node.name), node, flags | ts.TypeFormatFlags.InTypeAlias);
    }
    if (ts.isEnumDeclaration(node)) return node.members.map((m) => m.getText()).join("; ");
    if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
      const symbol = node.name && c.getSymbolAtLocation(node.name);
      if (!symbol) return node.getText();
      const instance = c.getDeclaredTypeOfSymbol(symbol);
      const parts: string[] = [];
      for (const p of c.getPropertiesOfType(instance)) {
        if (isPrivate(p)) continue;
        const optional = p.flags & ts.SymbolFlags.Optional ? "?" : "";
        parts.push(`${p.name}${optional}: ${c.typeToString(c.getTypeOfSymbolAtLocation(p, node), node, flags)}`);
      }
      for (const s of instance.getCallSignatures()) parts.push(`call ${c.signatureToString(s, node, flags)}`);
      for (const info of c.getIndexInfosOfType(instance)) {
        parts.push(`[${c.typeToString(info.keyType, node, flags)}]: ${c.typeToString(info.type, node, flags)}`);
      }
      if (ts.isClassDeclaration(node)) {
        const statics = c.getTypeOfSymbolAtLocation(symbol, node);
        for (const s of statics.getConstructSignatures()) parts.push(`new ${c.signatureToString(s, node, flags)}`);
        for (const p of c.getPropertiesOfType(statics)) {
          if (p.name === "prototype" || isPrivate(p)) continue;
          parts.push(`static ${p.name}: ${c.typeToString(c.getTypeOfSymbolAtLocation(p, node), node, flags)}`);
        }
      }
      return parts.sort().join("\n");
    }
    return node.getText();
  }
}

const isPrivate = (symbol: ts.Symbol): boolean =>
  (symbol.declarations ?? []).some(
    (d) => ts.getCombinedModifierFlags(d as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected),
  );

const memberName = (member: ts.ClassElement): string | undefined => {
  if (ts.isConstructorDeclaration(member)) return "constructor";
  const name = member.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return undefined;
};

function analyze(tree: Tree, root: string): Analysis {
  return new Analysis(createProgram(tree, root), root);
}

/**
 * A program over an in-memory tree. Files under the root come from the tree only (so the two
 * states are symmetric and untracked files are invisible); node_modules under the root is treated
 * as absent, since the sets need declarations, not diagnostics; everything else (TypeScript's own
 * lib files) comes from disk.
 */
function createProgram(tree: Tree, root: string): ts.Program {
  const configText = tree.get("tsconfig.json");
  const config = configText === undefined ? {} : (ts.parseConfigFileTextToJson("tsconfig.json", configText).config ?? {});
  const { options } = ts.convertCompilerOptionsFromJson(
    (config as { compilerOptions?: unknown }).compilerOptions ?? {},
    root,
    "tsconfig.json",
  );
  options.noEmit = true;
  options.skipLibCheck = true;
  options.types ??= [];

  const rootNames = [...tree.keys()].filter(isSource).map((p) => `${root}/${p}`);
  const host = ts.createCompilerHost(options, true);

  type Where = { kind: "tree"; path: string } | { kind: "absent" } | { kind: "disk" };
  const locate = (fileName: string): Where => {
    const name = fileName.replace(/\\/g, "/");
    if (!name.startsWith(`${root}/`)) return { kind: "disk" };
    const path = name.slice(root.length + 1);
    if (path.startsWith("node_modules/") || path === "node_modules") return { kind: "absent" };
    return { kind: "tree", path };
  };
  const inTree = (path: string) => tree.has(path);
  const dirInTree = (path: string) => {
    const prefix = path === "" ? "" : `${path}/`;
    for (const key of tree.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };

  const sysFileExists = host.fileExists.bind(host);
  const sysReadFile = host.readFile.bind(host);
  const sysDirectoryExists = host.directoryExists?.bind(host) ?? (() => false);
  const sysGetDirectories = host.getDirectories?.bind(host) ?? (() => []);

  host.fileExists = (fileName) => {
    const where = locate(fileName);
    return where.kind === "tree" ? inTree(where.path) : where.kind === "disk" ? sysFileExists(fileName) : false;
  };
  host.readFile = (fileName) => {
    const where = locate(fileName);
    return where.kind === "tree" ? tree.get(where.path) : where.kind === "disk" ? sysReadFile(fileName) : undefined;
  };
  host.directoryExists = (dirName) => {
    const where = locate(dirName);
    if (where.kind === "tree") return dirInTree(where.path);
    if (where.kind === "disk") return dirName.replace(/\\/g, "/") === root || sysDirectoryExists(dirName);
    return false;
  };
  host.getDirectories = (dirName) => {
    const where = locate(dirName);
    if (where.kind === "absent") return [];
    if (where.kind === "disk") return sysGetDirectories(dirName);
    const prefix = where.path === "" ? "" : `${where.path}/`;
    const dirs = new Set<string>();
    for (const key of tree.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) dirs.add(rest.slice(0, slash));
    }
    return [...dirs];
  };
  host.getSourceFile = (fileName, languageVersion) => {
    const text = host.readFile(fileName);
    return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
  };
  host.getCurrentDirectory = () => root;
  host.realpath = (p) => p;
  host.writeFile = () => undefined;

  return ts.createProgram({ rootNames, options, host });
}
