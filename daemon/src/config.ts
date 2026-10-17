import { readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
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
}

export const CONFIG_FILE = "config.json";
export const configPath = (worktree: string): string => join(worktree, STATE_DIR, CONFIG_FILE);

export async function readFileConfig(worktree: string): Promise<FileConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(worktree), "utf8")) as Record<string, unknown>;
    const pick = (key: string) => (typeof raw[key] === "string" && raw[key] !== "" ? (raw[key] as string) : undefined);
    const out: FileConfig = {};
    const serverUrl = pick("serverUrl");
    const token = pick("token");
    const repo = pick("repo");
    const agent = pick("agent");
    if (serverUrl !== undefined) out.serverUrl = serverUrl;
    if (token !== undefined) out.token = token;
    if (repo !== undefined) out.repo = repo;
    if (agent !== undefined) out.agent = agent;
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
 *   PITSTOP_TOKEN      shared token, when the server has one
 *   PITSTOP_REPO       owner/name; absent means the server's default repository
 *   PITSTOP_DEVELOPER  author.developer, defaults to the OS user name
 *   PITSTOP_AGENT      author.agent, else the file's `agent`, else "claude-code"
 *   PITSTOP_JJ_BIN / PITSTOP_GIT_BIN / PITSTOP_MERGIRAF_BIN  the executables, when not on PATH
 */
export function configFrom(file: FileConfig, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const serverUrl = (env.PITSTOP_SERVER ?? file.serverUrl ?? "http://localhost:8080").replace(/\/+$/, "");
  const token = env.PITSTOP_TOKEN?.trim() || file.token;
  const repo = env.PITSTOP_REPO?.trim() || file.repo;
  if (repo !== undefined) RepoId.parse(repo);
  return {
    serverUrl,
    ...(token ? { token } : {}),
    ...(repo ? { repo } : {}),
    worktree: cwd,
    author: { developer: env.PITSTOP_DEVELOPER ?? userInfo().username, agent: env.PITSTOP_AGENT ?? file.agent ?? "claude-code" },
  };
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
