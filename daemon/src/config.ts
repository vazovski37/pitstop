import { userInfo } from "node:os";
import type { Author } from "@pitstop/protocol";

export interface Config {
  serverUrl: string;
  token?: string;
  worktree: string;
  author: Author;
}

/**
 * Configuration from the environment (the repo's .env through `npm run dev -w @pitstop/daemon`):
 *   PITSTOP_SERVER     http://localhost:8080 by default
 *   PITSTOP_TOKEN      shared token, when the server has one
 *   PITSTOP_DEVELOPER  author.developer, defaults to the OS user name
 *   PITSTOP_AGENT      author.agent, defaults to "claude-code"
 *   PITSTOP_JJ_BIN / PITSTOP_GIT_BIN  the executables, when not on PATH
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Config {
  const serverUrl = (env.PITSTOP_SERVER ?? "http://localhost:8080").replace(/\/+$/, "");
  const token = env.PITSTOP_TOKEN?.trim();
  return {
    serverUrl,
    ...(token ? { token } : {}),
    worktree: cwd,
    author: { developer: env.PITSTOP_DEVELOPER ?? userInfo().username, agent: env.PITSTOP_AGENT ?? "claude-code" },
  };
}

/** `http(s)://host` -> `ws(s)://host/stream` */
export const streamUrl = (serverUrl: string): string => `${serverUrl.replace(/^http/, "ws")}/stream`;

/** Headers for a request to the server. */
export const serverHeaders = (token: string | undefined, json = false): Record<string, string> => ({
  ...(json ? { "content-type": "application/json" } : {}),
  ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
});
