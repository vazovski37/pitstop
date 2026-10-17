#!/usr/bin/env node
/**
 * Local daemon: one per worktree (design doc sections 6.3 and 8).
 *
 *   pitstop daemon               keep this worktree in sync with the server's log
 *   pitstop commit -m "<intent>" send the agent's unfinished work in @ as a commit
 *
 * Configuration comes from the environment (the repo's .env through `npm run dev -w @pitstop/daemon`):
 *   PITSTOP_SERVER     http://localhost:8080 by default
 *   PITSTOP_TOKEN      shared token, when the server has one
 *   PITSTOP_DEVELOPER  author.developer, defaults to the OS user name
 *   PITSTOP_AGENT      author.agent, defaults to "claude-code"
 *   PITSTOP_JJ_BIN / PITSTOP_GIT_BIN  the executables, when not on PATH
 */
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Author } from "@pitstop/protocol";
import { commit, CommitRejected } from "./commit.js";
import { binariesFromEnv, JjWorktree } from "./jj.js";
import { StreamClient } from "./stream.js";

export { describe } from "./messages.js";
export { commit, CommitRejected } from "./commit.js";
export { JjWorktree, type Applier, type ApplyResult } from "./jj.js";
export { StreamClient } from "./stream.js";
export { readState, writeState } from "./state.js";

export interface Config {
  serverUrl: string;
  token?: string;
  worktree: string;
  author: Author;
}

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

const USAGE = `usage:
  pitstop daemon               sync this worktree with the server's log
  pitstop commit -m "<intent>" commit the unfinished work in @`;

export async function main(argv: string[], config: Config = configFromEnv()): Promise<number> {
  const [command, ...rest] = argv;
  const log = (line: string) => console.log(`[pitstop] ${line}`);
  const applier = new JjWorktree(config.worktree, binariesFromEnv());

  if (command === "daemon") {
    const client = new StreamClient({
      url: streamUrl(config.serverUrl),
      ...(config.token === undefined ? {} : { token: config.token }),
      worktree: config.worktree,
      applier,
      log,
      onError: () => {
        process.exitCode = 1;
      },
    });
    await client.start();
    log(`watching ${config.worktree} from #${client.appliedLsn}; ctrl-c to stop`);
    await new Promise<void>((done) => {
      const stop = () => {
        client.close();
        done();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return process.exitCode === 1 ? 1 : 0;
  }

  if (command === "commit") {
    const at = rest.indexOf("-m");
    const intent = at === -1 ? undefined : rest[at + 1];
    if (intent === undefined || intent.trim() === "") {
      console.error(USAGE);
      return 2;
    }
    try {
      const changeset = await commit({
        serverUrl: config.serverUrl,
        ...(config.token === undefined ? {} : { token: config.token }),
        worktree: config.worktree,
        applier,
        intent,
        author: config.author,
        log,
      });
      log(`#${changeset.lsn} ${changeset.intent}`);
      return 0;
    } catch (err) {
      if (err instanceof CommitRejected) {
        log(err.message + (err.conflictsWith.length ? ` (conflicts with #${err.conflictsWith.join(", #")})` : ""));
        return 1;
      }
      throw err;
    }
  }

  console.error(USAGE);
  return 2;
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`[pitstop] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
