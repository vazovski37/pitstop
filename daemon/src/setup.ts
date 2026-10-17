/**
 * `pitstop setup <server-url> <owner/name> [--token t] [--dir d] [--agent name]`: one command from
 * "Node, git and jj are installed" to "Claude Code can work here":
 *   a. checks Node 22+, git and jj (with install hints), and jj's identity (taken from git when missing);
 *   b. asks the server for the repository: an empty log is filled from the git checkout here, as
 *      `main` holds it (`jj git init --colocate` when needed, then init.ts's import), and only from
 *      a checkout with nothing uncommitted that is no checkout of another repository; a log with
 *      entries is cloned (clone.ts) into --dir or ./<name>; a checkout already set up for it is reused;
 *   c. wires Claude Code there by command name (wire.ts), leaving files git tracks alone, and
 *      records the agent's name;
 *   d. starts the daemon in the background (processes.ts), restarting a running one whose settings
 *      changed, and says where everything is.
 * The token comes from --token or PITSTOP_TOKEN only, never from the cwd's .pitstop/config.json,
 * which may belong to another checkout of another server.
 */
import { existsSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { RepoId, Repo, type Author } from "@pitstop/protocol";
import { cloneRepository, defaultHooks as defaultCloneHooks, type CloneHooks } from "./clone.js";
import { findWorktree, readFileConfig, serverHeaders, writeFileConfig, type FileConfig } from "./config.js";
import { run } from "./exec.js";
import { init, OtherCheckout } from "./init.js";
import { binariesFromEnv, eolConversionFor, JjWorktree, jjInitColocated, type Applier, type Binaries } from "./jj.js";
import { startDaemon, stopDaemon, type Started } from "./processes.js";
import { readState } from "./state.js";
import { excludeFromGit, SHARED_SETTINGS, trackedWiring, wireClaudeCode, WIRING_EXCLUDES, WIRING_FILES } from "./wire.js";

/** Setup cannot go on until the user does something; the message says what. */
export class SetupStopped extends Error {}

export interface ToolCheck {
  bin: Binaries;
  cwd: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  log: (line: string) => void;
}

/** What setup does to the machine, replaceable in tests. */
export interface SetupHooks {
  checkTools: (check: ToolCheck) => Promise<void>;
  clone: CloneHooks;
  applierFor: (dir: string, bin: Binaries) => Applier;
  start: (dir: string, env: NodeJS.ProcessEnv) => Promise<Started>;
  /** Stops the daemon running in `dir`: its pid, or undefined when none was running. */
  stop: (dir: string) => Promise<number | undefined>;
}

export const defaultSetupHooks: SetupHooks = {
  checkTools,
  clone: defaultCloneHooks,
  applierFor: (dir, bin) => new JjWorktree(dir, bin),
  start: (dir, env) => startDaemon(dir, { env }),
  stop: (dir) => stopDaemon(dir),
};

export interface SetupOptions {
  serverUrl: string;
  repo: string;
  token?: string;
  /** Where to clone (default ./<name>), or the checkout to import (default the cwd's git checkout). */
  dir?: string;
  /** The agent's name on commits; default the name a previous setup recorded, else `<os user>-claude`. */
  agent?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  bin?: Binaries;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  hooks?: Partial<SetupHooks>;
}

export interface SetupResult {
  dir: string;
  repo: Repo;
  how: "imported" | "cloned" | "existing";
  appliedLsn: number;
  agent: string;
  daemon: Started;
  /** Wiring files git tracks in this checkout: setup left them as they are. */
  tracked: string[];
  /** What the user still has to do by hand, one line each (e.g. register the MCP server when the team tracks .mcp.json). */
  todo: string[];
}

const HINTS: Record<"jj" | "git", Partial<Record<NodeJS.Platform, string>> & { other: string }> = {
  jj: {
    win32: "winget install jj-vcs.jj",
    darwin: "brew install jj",
    other: "cargo binstall jj-cli (or brew install jj; see https://jj-vcs.github.io/jj/latest/install-and-setup/)",
  },
  git: {
    win32: "winget install Git.Git",
    darwin: "xcode-select --install (or brew install git)",
    other: "your package manager, e.g. sudo apt install git",
  },
};

const hint = (tool: "jj" | "git", platform: NodeJS.Platform): string => HINTS[tool][platform] ?? HINTS[tool].other;

const output = (bin: string, args: string[], cwd: string): Promise<string | undefined> =>
  run(bin, args, { cwd }).then(
    (out) => out.trim(),
    () => undefined,
  );

const trimUrl = (url: string) => url.replace(/\/+$/, "");

/** (a) Node 22+, git and jj runnable, and jj knowing who the user is. */
export async function checkTools({ bin, cwd, platform, nodeVersion, log }: ToolCheck): Promise<void> {
  const major = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  if (!(major >= 22)) {
    throw new SetupStopped(`Pitstop needs Node.js 22 or newer; this is ${nodeVersion}. Install it from https://nodejs.org, then run setup again.`);
  }
  const git = await output(bin.git, ["--version"], cwd);
  const jj = await output(bin.jj, ["--version"], cwd);
  const missing = [...(git === undefined ? [`git: ${hint("git", platform)}`] : []), ...(jj === undefined ? [`jj (Jujutsu): ${hint("jj", platform)}`] : [])];
  if (missing.length > 0) {
    throw new SetupStopped(
      ["Pitstop needs these installed, then run setup again from a new terminal (so PATH is fresh):", ...missing.map((m) => `  ${m}`)].join("\n"),
    );
  }
  const version = /(\d+)\.(\d+)/.exec(jj ?? "");
  if (version && Number(version[1]) === 0 && Number(version[2]) < 46) log(`warning: ${jj} is older than jj 0.46, which Pitstop is tested with; upgrade if applying entries fails`);

  const jjName = (await output(bin.jj, ["config", "get", "user.name"], cwd)) ?? "";
  const jjEmail = (await output(bin.jj, ["config", "get", "user.email"], cwd)) ?? "";
  if (jjName !== "" && jjEmail !== "") return;
  const name = jjName || ((await output(bin.git, ["config", "user.name"], cwd)) ?? "");
  const email = jjEmail || ((await output(bin.git, ["config", "user.email"], cwd)) ?? "");
  if (name === "" || email === "") {
    throw new SetupStopped(
      'jj needs to know who you are. Run these two, then run setup again:\n  jj config set --user user.name "Your Name"\n  jj config set --user user.email you@example.com',
    );
  }
  if (jjName === "") {
    await run(bin.jj, ["config", "set", "--user", "user.name", name], { cwd });
    log(`set jj's user.name to "${name}" (from git)`);
  }
  if (jjEmail === "") {
    await run(bin.jj, ["config", "set", "--user", "user.email", email], { cwd });
    log(`set jj's user.email to ${email} (from git)`);
  }
}

/** (b) The repository as the server knows it; a stop with what to do when it cannot be had. */
export async function findRepository(serverUrl: string, id: string, token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Repo> {
  let res: Response;
  try {
    res = await fetchImpl(new URL(`/repos/${id}`, serverUrl), { headers: serverHeaders(token) });
  } catch (err) {
    throw new SetupStopped(`cannot reach ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  // The server answers 404 as well for a repository the token may not read, so strangers cannot learn names.
  if (res.status === 404) {
    throw new SetupStopped(
      `${serverUrl} has no repository ${id} that this token can read: check the name, and that the repository's owner has added your GitHub login as a member (or create it on the website if it is new).`,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new SetupStopped(
      `${serverUrl} answered ${res.status} for ${id}: ${token === undefined ? "pass a token with --token or PITSTOP_TOKEN" : "check the token; with accounts on, the repository's owner adds you as a member"}.`,
    );
  }
  if (!res.ok) throw new SetupStopped(`GET /repos/${id} on ${serverUrl} answered ${res.status}`);
  return Repo.parse(await res.json());
}

export const defaultAgent = (username: string = userInfo().username): string =>
  `${username.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "dev"}-claude`;

/** On Windows jj's index files have 128-character names, so a long checkout path breaks `jj git init` (daemon/CLAUDE.md). */
const warnLongPath = (dir: string, platform: NodeJS.Platform, log: (line: string) => void) => {
  if (platform === "win32" && dir.length > 90) {
    log(`warning: ${dir} is ${dir.length} characters long; on Windows jj fails under long paths (about 100 and up). If it does, use a short one like C:\\code\\<name> (--dir).`);
  }
};

const isPitstopCheckoutOf = async (dir: string, repo: string, serverUrl: string): Promise<boolean> => {
  if (!existsSync(join(dir, ".pitstop", "config.json"))) return false;
  const file = await readFileConfig(dir);
  return file.repo === repo && file.serverUrl !== undefined && trimUrl(file.serverUrl) === serverUrl;
};

/** Whether a running daemon set up from `before` would act on something else than setup is about to write. */
const settingsChanged = (before: FileConfig, after: { serverUrl: string; repo: string; token: string | undefined; agent: string }): boolean =>
  before.serverUrl === undefined ||
  trimUrl(before.serverUrl) !== after.serverUrl ||
  before.repo !== after.repo ||
  (after.token !== undefined && before.token !== after.token) ||
  before.agent !== after.agent;

const isWiring = (path: string) => WIRING_FILES.includes(path);

/** Paths `git status` reports in `top`: modified, staged, deleted or untracked (not ignored). */
async function gitChanges(top: string, bin: Binaries): Promise<string[]> {
  const out = await run(bin.git, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: top });
  const fields = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // the next field is where it came from
  }
  return paths;
}

/** Paths that differ between `main` and jj's working copy `@` in `top`. */
async function jjChanges(top: string, bin: Binaries): Promise<string[]> {
  const out = await run(bin.jj, ["diff", "--summary", "--from", "main", "--to", "@"], { cwd: top });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(/^[A-Z] /, "").replace(/\\/g, "/"));
}

export async function setup(opts: SetupOptions): Promise<SetupResult> {
  const log = opts.log ?? (() => undefined);
  const env = opts.env ?? process.env;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const bin = opts.bin ?? binariesFromEnv(env);
  const platform = opts.platform ?? process.platform;
  const hooks: SetupHooks = { ...defaultSetupHooks, ...opts.hooks };
  const fetchImpl = opts.fetch ?? fetch;
  const serverUrl = trimUrl(opts.serverUrl);
  if (!/^https?:\/\/[^/]/.test(serverUrl)) throw new SetupStopped(`the server is a URL like https://pitstop.example.com (got ${opts.serverUrl})`);
  const id = RepoId.safeParse(opts.repo.toLowerCase());
  if (!id.success) throw new SetupStopped(`a repository is owner/name, like myteam/my-repo (got ${opts.repo})`);
  const token = opts.token;

  // a. The tools.
  await hooks.checkTools({ bin, cwd, platform, nodeVersion: opts.nodeVersion ?? process.versions.node, log });

  // b. The repository, then the checkout: one set up before, an import, or a clone.
  const repo = await findRepository(serverUrl, id.data, token, fetchImpl);
  log(`${repo.id} on ${serverUrl} is at #${repo.headLsn}`);
  const name = repo.id.split("/")[1] ?? repo.id;
  const gitTop = async (dir: string) => {
    const top = await output(bin.git, ["rev-parse", "--show-toplevel"], dir);
    return top === undefined || top === "" ? undefined : resolve(top);
  };
  const here = existsSync(cwd) ? await gitTop(cwd) : undefined;
  const candidates = [...(opts.dir === undefined ? [] : [resolve(cwd, opts.dir)]), ...(here === undefined ? [] : [here]), cwd, join(cwd, name)];
  let existing: string | undefined;
  for (const dir of candidates) {
    if (await isPitstopCheckoutOf(dir, repo.id, serverUrl)) {
      existing = dir;
      break;
    }
  }
  const previous = existing === undefined ? undefined : await readFileConfig(existing);
  const agent = opts.agent ?? previous?.agent ?? defaultAgent();
  const author: Author = { developer: env.PITSTOP_DEVELOPER ?? userInfo().username, agent };

  /** A stop for a directory that is a Pitstop checkout of something else. */
  const otherCheckout = (dir: string, file: FileConfig) =>
    new SetupStopped(
      `${dir} is already a Pitstop checkout of ${file.repo ?? "the default repository"} on ${file.serverUrl ?? "a server"}; run setup for ${repo.id} on ${serverUrl} from a directory outside it.`,
    );

  let dir: string;
  let how: SetupResult["how"];
  if (existing !== undefined && repo.headLsn > 0) {
    dir = existing;
    how = "existing";
    log(`${dir} is already a checkout of ${repo.id}`);
  } else if (repo.headLsn === 0) {
    dir = await importHere(existing ?? (opts.dir === undefined ? cwd : resolve(cwd, opts.dir)));
    how = "imported";
  } else {
    dir = resolve(cwd, opts.dir ?? name);
    // Not inside another checkout unless asked: its jj would see the clone's files as its own work.
    const around = opts.dir === undefined ? findWorktree(cwd) : undefined;
    if (around !== undefined) throw otherCheckout(around, await readFileConfig(around));
    warnLongPath(dir, platform, log);
    // clone.ts speaks to someone who runs `pitstop daemon` next; setup starts it below.
    const cloneLog = (line: string) => {
      if (line !== `${repo.id} is at #${repo.headLsn}`) log(line.replace(/; run `pitstop daemon` there$/, ""));
    };
    await cloneRepository({ serverUrl, ...(token === undefined ? {} : { token }), repo: repo.id, dir, bin, fetch: fetchImpl, log: cloneLog }, hooks.clone);
    how = "cloned";
  }

  async function importHere(start: string): Promise<string> {
    const top = existsSync(start) ? await gitTop(start) : undefined;
    if (top === undefined) {
      throw new SetupStopped(
        `${repo.id} has no entries yet, and ${start} is not a git checkout. Run setup inside the git checkout whose files should become the repository's first entry.`,
      );
    }
    // A checkout of another repository or server stays one: its config, state and daemon belong to that log.
    const configured = await readFileConfig(top);
    if (configured.serverUrl !== undefined && (configured.repo !== repo.id || trimUrl(configured.serverUrl) !== serverUrl)) {
      throw otherCheckout(top, configured);
    }
    const { appliedLsn } = await readState(top);
    if (appliedLsn > 0) {
      throw new SetupStopped(
        `${top} has applied #${appliedLsn} of ${repo.id} already, but ${repo.id} on ${serverUrl} has no entries (was the server reset?). Import from a fresh git checkout of these files instead, one without .pitstop/ and .jj/.`,
      );
    }
    const files = (await output(bin.git, ["ls-files", "--cached", "--others", "--exclude-standard"], top)) ?? "";
    if (files === "") throw new SetupStopped(`${repo.id} has no entries yet, and ${top} has no files to import.`);
    warnLongPath(top, platform, log);
    const hasJj = existsSync(join(top, ".jj"));
    if (!hasJj) {
      const branch = (await output(bin.git, ["symbolic-ref", "--short", "-q", "HEAD"], top)) ?? "";
      if (branch === "") throw new SetupStopped(`${top} has no branch checked out (detached HEAD). Check out main (git switch main), then run setup again.`);
      if (branch !== "main") {
        throw new SetupStopped(
          `${top} is on branch ${branch}; Pitstop follows a branch named main. Rename it with \`git branch -m ${branch} main\` (a GitHub remote renames its default branch under Settings > Branches), then run setup again.`,
        );
      }
    }
    if ((await output(bin.git, ["rev-parse", "--verify", "-q", "refs/heads/main"], top)) === undefined) {
      throw new SetupStopped(
        hasJj
          ? `${top} has no branch named main, which Pitstop follows. Create or rename one, then run setup again.`
          : `main in ${top} has no commit yet. Make one (git add -A, then git commit -m "first commit"), then run setup again.`,
      );
    }

    // The first entry is what main holds. Anything else here (edits, untracked files, secrets
    // among them) jj would carry into the agent's first commit, and the log keeps it forever.
    let eolNote = "";
    if (hasJj) {
      // A jj that never converted line endings holds CRLF where git holds LF: set it as git has
      // it, and touch what differs so jj reads it again; line endings alone then stop counting.
      const eol = await eolConversionFor(top, bin);
      if (eol !== undefined && (await output(bin.jj, ["config", "get", "working-copy.eol-conversion"], top)) !== eol) {
        await run(bin.jj, ["config", "set", "--repo", "working-copy.eol-conversion", eol], { cwd: top });
        log(`set jj's working-copy.eol-conversion to ${eol} in ${top}, as git converts line endings here`);
        const now = new Date();
        for (const path of await jjChanges(top, bin)) await utimes(join(top, path), now, now).catch(() => undefined);
        eolNote = " (line endings alone do not count)";
      }
    }
    const changed = (hasJj ? await jjChanges(top, bin) : await gitChanges(top, bin)).filter((p) => !isWiring(p));
    if (changed.length > 0) {
      const shown = changed.slice(0, 20).map((p) => `  ${p}`);
      if (changed.length > shown.length) shown.push(`  … and ${changed.length - shown.length} more`);
      throw new SetupStopped(
        [
          `${top} has changes that are not committed to main${eolNote}; the repository's first entry is main as it is, and Pitstop would carry these into the agent's first commit:`,
          ...shown,
          `Commit them, add them to .gitignore, or ${hasJj ? "move them off the working copy (`jj new main` keeps them in a change of their own)" : "stash them (git stash -u)"}, then run setup again.`,
        ].join("\n"),
      );
    }

    // Before jj's first snapshot (and only once the checks passed): an excluded file never enters `@`.
    await excludeFromGit(top, WIRING_EXCLUDES, bin);
    if (!hasJj) {
      const eol = await jjInitColocated(top, bin);
      log(`jj git init --colocate in ${top}${eol === undefined ? "" : ` (working-copy.eol-conversion ${eol}, as git converts line endings here)`}`);
    } else {
      // Wiring an earlier jj snapshotted, before it was excluded, leaves @ now.
      const snapped = (await jjChanges(top, bin).catch(() => [])).filter(isWiring);
      if (snapped.length > 0) await run(bin.jj, ["file", "untrack", ...snapped], { cwd: top });
    }
    let result;
    try {
      result = await init({
        serverUrl,
        ...(token === undefined ? {} : { token }),
        repo: repo.id,
        worktree: top,
        applier: hooks.applierFor(top, bin),
        author,
        importFrom: "main",
        fetch: fetchImpl,
        log,
      });
    } catch (err) {
      if (err instanceof OtherCheckout) throw new SetupStopped(err.message);
      throw err;
    }
    if (result.importedAs !== undefined) log(`imported ${basename(top)} as #${result.importedAs}`);
    return top;
  }

  // c. Claude Code, by command name; the agent's name for the daemon. Files git tracks are the
  //    team's: looked at before anything is written, and left alone.
  const file = await readFileConfig(dir);
  await writeFileConfig(dir, { ...file, serverUrl, ...(token === undefined ? {} : { token }), repo: repo.id, agent });
  const trackedHere = await trackedWiring(dir, bin, [...WIRING_FILES, SHARED_SETTINGS]);
  await excludeFromGit(dir, WIRING_EXCLUDES, bin);
  const wired = await wireClaudeCode(dir, { repo: repo.id, serverUrl, platform, tracked: trackedHere });
  const todo: string[] = [];
  for (const path of wired.skipped) log(`warning: git tracks ${path} here, so setup left it as it is`);
  if (wired.localMcp !== undefined) {
    todo.push(`register the pitstop MCP server for yourself (git tracks this checkout's .mcp.json, so setup did not touch it): ${wired.localMcp}`);
  }

  // d. The daemon, with what setup was told winning over whatever this shell carries. One that
  //    runs with other settings (a new agent name, a new token) is restarted: it read them once.
  if (how === "existing" && previous !== undefined && settingsChanged(previous, { serverUrl, repo: repo.id, token, agent })) {
    const pid = await hooks.stop(dir);
    if (pid !== undefined) log(`stopped the daemon (pid ${pid}) to start it with the new settings`);
  }
  const daemon = await hooks.start(dir, {
    ...env,
    PITSTOP_SERVER: serverUrl,
    PITSTOP_REPO: repo.id,
    PITSTOP_AGENT: agent,
    ...(token === undefined ? {} : { PITSTOP_TOKEN: token }),
  });
  const appliedLsn = (await readState(dir)).appliedLsn;
  return { dir, repo, how, appliedLsn, agent, daemon, tracked: wired.skipped, todo };
}
