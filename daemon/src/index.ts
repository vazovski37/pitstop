#!/usr/bin/env node
/**
 * Local daemon: one per worktree (design doc sections 6.3, 8 and 10).
 *
 *   pitstop setup <server-url> <owner/name> [--token t] [--dir d] [--agent name]
 *                                        check the tools, import or clone, wire Claude Code, start the daemon
 *   pitstop start / pitstop stop         this worktree's daemon in the background (the agent side starts it too)
 *   pitstop clone <server-url> <owner/name> [dir] [--token t]
 *                                        a fresh worktree of a repository on the server, built from its log
 *   pitstop init <server-url> [--repo owner/name] [--token t] [--no-import]
 *                                        remember the server, create the repository, import the worktree
 *   pitstop daemon                       keep this worktree in sync with the server's log; local API for the agent side
 *   pitstop commit -m "<intent>"         send the agent's unfinished work in @ as a commit
 *   pitstop import [-m "<why>"]          send every tracked file as the log's first entry
 *   pitstop intent -m "<text>" [-s a,b]  declare an intent (symbols as path#name); the next commit closes it
 *   pitstop safe-point                   tell the running daemon the agent is between tools (the hook's command)
 *   pitstop status                       what the running daemon knows
 *   pitstop brain                        the repository's ADRs, leases and open intents (design doc section 9)
 *   pitstop lease <path#name> [-r why] [--release]
 *                                        take (or release) a short lease on one symbol for the open intent
 *
 * Configuration: .pitstop/config.json (written by init) under the environment; see config.ts.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brainBrief, brainLines, fetchBrain, releaseLease, takeLease } from "./brain.js";
import { BUNDLED, VERSION } from "./build-info.js";
import { cloneRepository } from "./clone.js";
import { commit, CommitRejected, importWorktree } from "./commit.js";
import { configFromEnv, daemonEnv, findWorktree, loadConfig, readFileConfig, withServerIdentity, type Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { init } from "./init.js";
import { declareIntent } from "./intents.js";
import { binariesFromEnv, JjWorktree } from "./jj.js";
import { LocalClient } from "./local-client.js";
import { liveDaemon, startDaemon, stopDaemon } from "./processes.js";
import { setup, SetupStopped } from "./setup.js";
import { readState } from "./state.js";

export { describe } from "./messages.js";
export { cloneRepository } from "./clone.js";
export { commit, CommitRejected, importWorktree } from "./commit.js";
export { configFrom, configFromEnv, daemonEnv, findWorktree, loadConfig, readFileConfig, serverLogin, streamUrl, withServerIdentity, writeFileConfig, type Config } from "./config.js";
export { Daemon, readDaemonInfo, type SafePointResult, type Status } from "./daemon.js";
export { init } from "./init.js";
export { declareIntent } from "./intents.js";
export { brainBrief, brainLines, fetchBrain, releaseLease, symbolCallers, symbolHistory, takeLease, whyPath, type Brain } from "./brain.js";
export { JjWorktree, type Applier, type ApplyResult } from "./jj.js";
export { LocalClient, NoDaemon } from "./local-client.js";
export { StreamClient } from "./stream.js";
export { readState, writeState } from "./state.js";
export { symbolSets, type SymbolSets, type Tree } from "./symbols.js";
export { setup, SetupStopped, type SetupOptions, type SetupResult } from "./setup.js";
export { liveDaemon, startDaemon, stopDaemon } from "./processes.js";
export { excludeFromGit, wireClaudeCode } from "./wire.js";
export { BUNDLED, VERSION } from "./build-info.js";

const USAGE = `usage:
  pitstop setup <server-url> <owner/name> [--token t] [--dir d] [--agent name]
                                       set up a checkout for Claude Code: import or clone, wire, start the daemon
  pitstop start                        start this checkout's daemon in the background
  pitstop stop                         stop it
  pitstop clone <server-url> <owner/name> [dir] [--token t]
  pitstop init <server-url> [--repo owner/name] [--token t] [--no-import]
  pitstop daemon                       sync this worktree with the server's log
  pitstop commit -m "<intent>"         commit the unfinished work in @
  pitstop import [-m "<why>"]          send every tracked file as the log's first entry
  pitstop intent -m "<text>" [-s a,b]  declare an intent; the next commit closes it
  pitstop safe-point                   tell the running daemon the agent is between tools
  pitstop status                       what the running daemon knows
  pitstop brain                        the repository's ADRs, leases and open intents
  pitstop lease <path#name> [-r "<why>"] [--release]
                                       take (or release) a short lease on one symbol
  pitstop version`;

const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

export async function main(argv: string[], config?: Config): Promise<number> {
  const [command, ...rest] = argv;
  const log = (line: string) => console.log(`[pitstop] ${line}`);
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`pitstop ${VERSION}`);
    return 0;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.error(USAGE);
    return command === undefined ? 2 : 0;
  }

  if (command === "setup") {
    // The flag or the environment only, as for clone below.
    const token = flag(rest, "--token") ?? (config === undefined ? configFromEnv().token : config.token);
    const valued = new Set(["--token", "--dir", "--agent"]);
    const positional = rest.filter((a, i) => !a.startsWith("--") && !valued.has(rest[i - 1] ?? ""));
    const [serverUrl, repo] = positional;
    if (serverUrl === undefined || repo === undefined || positional.length > 2) {
      console.error(USAGE);
      return 2;
    }
    const dir = flag(rest, "--dir");
    const agent = flag(rest, "--agent");
    try {
      const result = await setup({
        serverUrl,
        repo,
        ...(token === undefined ? {} : { token }),
        ...(dir === undefined ? {} : { dir }),
        ...(agent === undefined ? {} : { agent }),
        ...(config === undefined ? {} : { cwd: config.worktree }),
        log,
      });
      const { daemon } = result;
      console.log("");
      log(`ready: ${result.dir} is a checkout of ${result.repo.id} at #${result.appliedLsn}; the agent there commits as "${result.agent}"`);
      log(`daemon ${daemon.started ? "started" : "already running"} (pid ${daemon.info.pid}); its log: ${daemon.log}`);
      for (const step of result.todo) log(`to do first: ${step}`);
      log(`next: open Claude Code in that directory (cd "${result.dir}" && claude): the pitstop tools, the hook and CLAUDE.local.md are in place`);
      log("to stop the daemon: `pitstop stop` there (Claude Code starts it again when it needs it)");
      return 0;
    } catch (err) {
      if (err instanceof SetupStopped) {
        console.error(`[pitstop] ${err.message}`);
        return 1;
      }
      throw err;
    }
  }

  // clone and init make a checkout where they are run; every other command acts on the checkout
  // around the cwd, found the way the MCP server and the hook find it, so `pitstop start` from
  // `src/` is the checkout's daemon, not a second one in `src/`.
  const located = config === undefined && command !== "clone" && command !== "init" ? findWorktree(process.cwd()) : undefined;
  if (config === undefined && located === undefined && (command === "start" || command === "daemon")) {
    console.error(`[pitstop] ${process.cwd()} is not inside a Pitstop checkout (no .pitstop/config.json here or above); run \`pitstop setup <server-url> <owner/name>\` (or \`pitstop init\`) first`);
    return 1;
  }
  const loaded = config ?? (await loadConfig(process.env, located ?? process.cwd()));
  // Where leases and intents are compared with their holders, be who the server records: a
  // personal token's owner, whatever PITSTOP_DEVELOPER or the OS user name says.
  const cfg = command === "daemon" || command === "intent" || command === "brain" || command === "lease" ? await withServerIdentity(loaded) : loaded;
  const applier = new JjWorktree(cfg.worktree, binariesFromEnv());
  const shared = {
    serverUrl: cfg.serverUrl,
    ...(cfg.token === undefined ? {} : { token: cfg.token }),
    ...(cfg.repo === undefined ? {} : { repo: cfg.repo }),
    worktree: cfg.worktree,
    author: cfg.author,
    log,
  };

  if (command === "clone") {
    // The flag or the environment only: the cwd's .pitstop/config.json belongs to another checkout,
    // possibly of another server, and its token must not be sent to the one named here.
    const token = flag(rest, "--token") ?? (config === undefined ? configFromEnv().token : config.token);
    const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--token");
    const [serverUrl, repo, dir] = positional;
    if (serverUrl === undefined || repo === undefined || !repo.includes("/")) {
      console.error(USAGE);
      return 2;
    }
    const target = resolve(dir ?? repo.split("/")[1] ?? repo);
    const result = await cloneRepository({
      serverUrl,
      ...(token === undefined ? {} : { token }),
      repo,
      dir: target,
      bin: binariesFromEnv(),
      log,
    });
    log(`cloned ${result.repo.id} (${result.entries} entries) into ${result.dir}`);
    return 0;
  }

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

  if (command === "start") {
    // The checkout's own server, repository, token and agent, whatever this shell (or the Claude
    // Code that runs this to start a missing daemon) carries.
    const result = await startDaemon(cfg.worktree, { env: daemonEnv(await readFileConfig(cfg.worktree)) });
    log(`daemon ${result.started ? "started" : "already running"} in ${cfg.worktree} (pid ${result.info.pid}, local API on 127.0.0.1:${result.info.port}); log: ${result.log}`);
    return 0;
  }

  if (command === "stop") {
    const pid = await stopDaemon(cfg.worktree);
    log(pid === undefined ? `no daemon is running in ${cfg.worktree}` : `stopped the daemon (pid ${pid})`);
    return 0;
  }

  if (command === "daemon") {
    // One per worktree: a second one would apply every entry over the first one's work.
    const running = await liveDaemon(cfg.worktree);
    if (running !== undefined && running.pid !== process.pid) {
      log(`a daemon is already running in ${cfg.worktree} (pid ${running.pid}); \`pitstop stop\` stops it`);
      return 1;
    }
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
    log(`watching ${cfg.worktree} from #${daemon.stream.appliedLsn} on ${where} as ${cfg.author.agent} (${cfg.author.developer}); local API on 127.0.0.1:${port}; ctrl-c to stop`);
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
    // The brain in brief, as the agent gets it through the declare_intent tool.
    const brain = await fetchBrain(shared).catch(() => undefined);
    if (brain !== undefined) for (const line of brainBrief(brain, intent.declaredSymbols, cfg.author, intent.id)) console.log(line);
    return 0;
  }

  if (command === "brain") {
    const { intentId } = await readState(cfg.worktree);
    for (const line of brainLines(await fetchBrain(shared), cfg.author, intentId)) console.log(line);
    return 0;
  }

  if (command === "lease") {
    const symbol = rest[0];
    if (symbol === undefined || !/^[^#]+#.+$/.test(symbol)) {
      console.error(USAGE);
      return 2;
    }
    const reason = flag(rest, "-r");
    const { intentId } = await readState(cfg.worktree);
    // A lease lives and ends with an intent: the daemon renews it while the intent is open, the commit releases it.
    const answer = rest.includes("--release")
      ? await releaseLease(shared, symbol, cfg.author, intentId)
      : intentId === undefined
        ? ({ status: "invalid", message: "declare your intent first (pitstop intent -m ...), then take the lease; it lives and ends with that intent" } as const)
        : await takeLease(shared, { symbol, holder: cfg.author, ...(reason === undefined ? {} : { reason }), intentId });
    log(answer.message);
    return answer.status === "held" || answer.status === "released" ? 0 : 1;
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

/** Runs the CLI as this process: its exit code, an error as one line. packages/cli's bundle calls it. */
export function runCli(argv: string[]): void {
  main(argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`[pitstop] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      // Exit naturally once nothing holds the loop; a stream socket or server left half-started
      // would keep the process alive, so force it after a moment (an immediate exit trips a libuv
      // assertion on Windows while a request handle is still closing).
      setTimeout(() => process.exit(1), 2_000).unref();
    },
  );
}

// From source or dist/ (`node daemon/dist/index.js`). In the bundle every module shares the
// bundle's file name, so this check would fire there too: its entry calls runCli instead.
const isMain = !BUNDLED && process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) runCli(process.argv.slice(2));
