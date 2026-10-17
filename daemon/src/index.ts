#!/usr/bin/env node
/**
 * Local daemon: one per worktree (design doc sections 6.3, 8 and 10).
 *
 *   pitstop init <server-url> [--repo owner/name] [--token t] [--no-import]
 *                                        remember the server, create the repository, import the worktree
 *   pitstop daemon                       keep this worktree in sync with the server's log; local API for the agent side
 *   pitstop commit -m "<intent>"         send the agent's unfinished work in @ as a commit
 *   pitstop import [-m "<why>"]          send every tracked file as the log's first entry
 *   pitstop intent -m "<text>" [-s a,b]  declare an intent (symbols as path#name); the next commit closes it
 *   pitstop safe-point                   tell the running daemon the agent is between tools (the hook's command)
 *   pitstop status                       what the running daemon knows
 *
 * Configuration: .pitstop/config.json (written by init) under the environment; see config.ts.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commit, CommitRejected, importWorktree } from "./commit.js";
import { loadConfig, type Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { init } from "./init.js";
import { declareIntent } from "./intents.js";
import { binariesFromEnv, JjWorktree } from "./jj.js";
import { LocalClient } from "./local-client.js";

export { describe } from "./messages.js";
export { commit, CommitRejected, importWorktree } from "./commit.js";
export { configFrom, configFromEnv, loadConfig, readFileConfig, streamUrl, writeFileConfig, type Config } from "./config.js";
export { Daemon, readDaemonInfo, type SafePointResult, type Status } from "./daemon.js";
export { init } from "./init.js";
export { declareIntent } from "./intents.js";
export { JjWorktree, type Applier, type ApplyResult } from "./jj.js";
export { LocalClient, NoDaemon } from "./local-client.js";
export { StreamClient } from "./stream.js";
export { readState, writeState } from "./state.js";
export { symbolSets, type SymbolSets, type Tree } from "./symbols.js";

const USAGE = `usage:
  pitstop init <server-url> [--repo owner/name] [--token t] [--no-import]
  pitstop daemon                       sync this worktree with the server's log
  pitstop commit -m "<intent>"         commit the unfinished work in @
  pitstop import [-m "<why>"]          send every tracked file as the log's first entry
  pitstop intent -m "<text>" [-s a,b]  declare an intent; the next commit closes it
  pitstop safe-point                   tell the running daemon the agent is between tools
  pitstop status                       what the running daemon knows`;

const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

export async function main(argv: string[], config?: Config): Promise<number> {
  const [command, ...rest] = argv;
  const log = (line: string) => console.log(`[pitstop] ${line}`);
  const cfg = config ?? (await loadConfig());
  const applier = new JjWorktree(cfg.worktree, binariesFromEnv());
  const shared = {
    serverUrl: cfg.serverUrl,
    ...(cfg.token === undefined ? {} : { token: cfg.token }),
    ...(cfg.repo === undefined ? {} : { repo: cfg.repo }),
    worktree: cfg.worktree,
    author: cfg.author,
    log,
  };

  if (command === "init") {
    const serverUrl = rest.find((a) => !a.startsWith("-") && a !== flag(rest, "--repo") && a !== flag(rest, "--token"));
    if (serverUrl === undefined) {
      console.error(USAGE);
      return 2;
    }
    const repo = flag(rest, "--repo");
    const token = flag(rest, "--token") ?? cfg.token;
    const result = await init({
      ...shared,
      serverUrl,
      ...(token === undefined ? {} : { token }),
      ...(repo === undefined ? {} : { repo }),
      applier,
      noImport: rest.includes("--no-import"),
    });
    if (result.importedAs !== undefined) log(`imported as #${result.importedAs}`);
    log("now start `pitstop daemon` here");
    return 0;
  }

  if (command === "daemon") {
    const daemon = new Daemon({
      ...shared,
      applier,
      ...(process.env.PITSTOP_DAEMON_PORT ? { port: Number(process.env.PITSTOP_DAEMON_PORT) } : {}),
      onError: () => {
        process.exitCode = 1;
      },
    });
    let port: number;
    try {
      port = await daemon.start();
    } catch (err) {
      // Without the local API the agent side is blind: better to stop than to run half.
      await daemon.close().catch(() => undefined);
      throw err;
    }
    const where = cfg.repo === undefined ? cfg.serverUrl : `${cfg.serverUrl} (${cfg.repo})`;
    log(`watching ${cfg.worktree} from #${daemon.stream.appliedLsn} on ${where}; local API on 127.0.0.1:${port}; ctrl-c to stop`);
    await new Promise<void>((done) => {
      const stop = () => void daemon.close().finally(done);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return process.exitCode === 1 ? 1 : 0;
  }

  if (command === "commit" || command === "import") {
    const intent = flag(rest, "-m");
    if (command === "commit" && (intent === undefined || intent.trim() === "")) {
      console.error(USAGE);
      return 2;
    }
    try {
      const changeset =
        command === "commit"
          ? await commit({ ...shared, applier, intent: intent ?? "" })
          : await importWorktree({ ...shared, applier, ...(intent === undefined ? {} : { intent }) });
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

  if (command === "intent") {
    const text = flag(rest, "-m");
    if (text === undefined || text.trim() === "") {
      console.error(USAGE);
      return 2;
    }
    const symbols = (flag(rest, "-s") ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    const intent = await declareIntent({ ...shared, text, declaredSymbols: symbols });
    log(`${intent.id} ${intent.status}`);
    return 0;
  }

  if (command === "safe-point" || command === "status") {
    const client = new LocalClient(cfg.worktree);
    if (command === "status") {
      console.log(JSON.stringify(await client.status(), null, 2));
      return 0;
    }
    const result = await client.safePoint();
    for (const note of result.notes) console.log(note);
    if (result.applied.length > 0) log(`applied #${result.applied.join(", #")}`);
    return 0;
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
      process.exit(1); // not exitCode: a stream socket or server would keep the process alive
    },
  );
}
