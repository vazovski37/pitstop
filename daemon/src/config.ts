import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RepoId, type Author } from "@pitstop/protocol";
import { STATE_DIR, stateDir } from "./state.js";

export interface Config {
  serverUrl: string;
  token?: string;
  worktree: string;
  author: Author;
  /** The repository on the server (`owner/name`); absent means the server's default one. */
  repo?: string;
}

/** What `pitstop init` stores in `.pitstop/config.json`; the environment overrides it. */
export interface FileConfig {
  serverUrl?: string;
  token?: string;
  repo?: string;
  /** The agent name on this checkout's commits (written by `pitstop setup --agent`); PITSTOP_AGENT wins. */
  agent?: string;
  /**
   * The login the server knows this file's token by (`GET /me`, written by `pitstop setup`): the
   * server records it as `author.developer`, so it wins over PITSTOP_DEVELOPER. Kept for when the
   * server cannot be asked; the CLI asks again where it compares holders (`withServerIdentity`).
   */
  developer?: string;
}

export const CONFIG_FILE = "config.json";
export const configPath = (worktree: string): string => join(worktree, STATE_DIR, CONFIG_FILE);

/**
 * The checkout `start` is in: the nearest directory at or above it with `.pitstop/config.json`,
 * or undefined outside any. The MCP server and the hook look the same way (mcp/src/autostart.ts,
 * findWorktree), so the CLI run from `src/` acts on the same checkout as the agent side.
 */
export function findWorktree(start: string): string | undefined {
  for (let dir = resolve(start); ; ) {
    if (existsSync(configPath(dir))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function readFileConfig(worktree: string): Promise<FileConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(worktree), "utf8")) as Record<string, unknown>;
    const pick = (key: string) => (typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : undefined);
    const out: FileConfig = {};
    const serverUrl = pick("serverUrl");
    const token = pick("token");
    const repo = pick("repo");
    const agent = pick("agent");
    const developer = pick("developer");
    if (serverUrl !== undefined) out.serverUrl = serverUrl;
    if (token !== undefined) out.token = token;
    if (repo !== undefined) out.repo = repo;
    if (agent !== undefined) out.agent = agent;
    if (developer !== undefined) out.developer = developer;
    return out;
  } catch {
    return {};
  }
}

export async function writeFileConfig(worktree: string, config: FileConfig): Promise<void> {
  await stateDir(worktree);
  await writeFile(configPath(worktree), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Configuration, from the environment over `.pitstop/config.json`:
 *   PITSTOP_SERVER     http://localhost:8080 by default
 *   PITSTOP_TOKEN      the token, when the server wants one. It follows the server: the file's
 *                      token goes with the file's server and wins there; with PITSTOP_SERVER
 *                      naming another server, only PITSTOP_TOKEN goes to it
 *   PITSTOP_REPO       owner/name; absent means the server's default repository
 *   PITSTOP_DEVELOPER  author.developer under the shared token or on an open server, defaults to the
 *                      OS user name. With a personal token the server records its owner's login
 *                      instead: the file's `developer` (from setup) wins here, and
 *                      `withServerIdentity` asks the server
 *   PITSTOP_AGENT      author.agent, else the file's `agent`, else "claude-code"
 *   PITSTOP_JJ_BIN / PITSTOP_GIT_BIN / PITSTOP_MERGIRAF_BIN  the executables, when not on PATH
 */
export function configFrom(file: FileConfig, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const serverUrl = trimUrl(env.PITSTOP_SERVER ?? file.serverUrl ?? "http://localhost:8080");
  const envToken = env.PITSTOP_TOKEN?.trim() || undefined;
  const elsewhere = env.PITSTOP_SERVER !== undefined && (file.serverUrl === undefined || trimUrl(file.serverUrl) !== serverUrl);
  const token = elsewhere ? envToken : (file.token ?? envToken);
  const repo = env.PITSTOP_REPO?.trim() || file.repo;
  if (repo !== undefined) RepoId.parse(repo);
  // The file's login belongs to the file's token, so only to the file's server.
  const login = elsewhere ? undefined : file.developer;
  return {
    serverUrl,
    ...(token ? { token } : {}),
    ...(repo ? { repo } : {}),
    worktree: cwd,
    author: { developer: login ?? env.PITSTOP_DEVELOPER ?? userInfo().username, agent: env.PITSTOP_AGENT ?? file.agent ?? "claude-code" },
  };
}

const trimUrl = (url: string): string => url.replace(/\/+$/, "");

/**
 * The login the server knows `token` by (`GET /me`), or undefined: no token, the shared token or
 * an open server (401), or no answer. With a personal token the server writes this login as
 * `author.developer` on commits, intents and leases, whatever the daemon sends, so leases are
 * compared with it.
 */
export async function serverLogin(serverUrl: string, token: string | undefined, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (token === undefined) return undefined;
  try {
    const res = await fetchImpl(new URL("/me", serverUrl), { headers: serverHeaders(token), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { login?: unknown };
    return typeof body.login === "string" && body.login !== "" ? body.login : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The configuration with the developer the server records for its token (`serverLogin`), when it
 * names one; otherwise as it was (the shared token keeps PITSTOP_DEVELOPER or the OS user name).
 * Without it a holder would not recognise, or renew, its own lease.
 */
export async function withServerIdentity(config: Config, fetchImpl?: typeof fetch): Promise<Config> {
  const login = await serverLogin(config.serverUrl, config.token, fetchImpl);
  return login === undefined || login === config.author.developer ? config : { ...config, author: { ...config.author, developer: login } };
}

/**
 * The environment for a checkout's background daemon (`pitstop start`, and so the agent side's
 * autostart): what `.pitstop/config.json` names wins over the shell's PITSTOP_SERVER, PITSTOP_REPO,
 * PITSTOP_TOKEN and PITSTOP_AGENT, the way `pitstop setup` starts it, and a shell token meant for
 * another server is dropped rather than sent to this one.
 */
export function daemonEnv(file: FileConfig, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (file.serverUrl !== undefined) {
    if (out.PITSTOP_SERVER !== undefined && trimUrl(out.PITSTOP_SERVER) !== trimUrl(file.serverUrl)) delete out.PITSTOP_TOKEN;
    out.PITSTOP_SERVER = file.serverUrl;
  }
  if (file.token !== undefined) out.PITSTOP_TOKEN = file.token;
  if (file.repo !== undefined) out.PITSTOP_REPO = file.repo;
  if (file.agent !== undefined) out.PITSTOP_AGENT = file.agent;
  return out;
}

export const configFromEnv = (env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config => configFrom({}, env, cwd);

export const loadConfig = async (env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<Config> =>
  configFrom(await readFileConfig(cwd), env, cwd);

/** `http(s)://host` -> `ws(s)://host/stream` */
export const streamUrl = (serverUrl: string): string => `${serverUrl.replace(/^http/, "ws")}/stream`;

/** Headers for a request to the server. */
export const serverHeaders = (token: string | undefined, json = false): Record<string, string> => ({
  ...(json ? { "content-type": "application/json" } : {}),
  ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
});
