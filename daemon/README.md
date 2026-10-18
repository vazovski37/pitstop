# Pitstop for your repository

This is the guide for a team that wants its coding agents to commit through Pitstop: what to install, how to connect a repository, and what the daily loop looks like. It covers the client: the daemon (`daemon/`) and the agent tools (`mcp/`), shipped together as one package, `pitstop-cli` (`packages/cli/`). The server is hosted: nobody installs one; joining it is in [SETUP.md](../SETUP.md), "Joining the hosted service".

## How it works, in one paragraph

A Pitstop server keeps an ordered log of every change to a repository. Each checkout on each laptop runs a **daemon** that follows that log and applies new entries into the checkout at **safe points**, between the agent's tool calls, never mid-edit. An agent declares an **intent** before a task, works, and **commits** through an MCP tool; the server checks the commit against everything that landed meanwhile, including what the agent *read* and someone else changed (write skew), and either lands it, repairs it, or hands it back with exactly what to re-read. Your checkout stays a normal git repository the whole time, with Jujutsu colocated so unfinished work is never lost.

## What you need

| Piece | Why | Install |
| --- | --- | --- |
| Node.js 22 or newer | the daemon and the tools | nodejs.org |
| git | the checkout | `winget install Git.Git`, `xcode-select --install`, your package manager |
| Jujutsu (`jj`) 0.46 or newer | the daemon rebases your unfinished work with it | `winget install jj-vcs.jj`, `brew install jj`, `cargo binstall jj-cli` |
| Mergiraf, optional | merges conflicts by structure instead of leaving markers | `winget install Mergiraf.Mergiraf`, `brew install mergiraf` |
| A server URL and a token | where the log lives, and your key to it | from whoever runs the server (below) |

**Getting a token.** On the hosted server with accounts on: sign in with GitHub at `<server>/auth/github`, then create a personal token with `POST /tokens` and a body of `{"name":"laptop"}` (from the browser's console with `fetch`, so the session cookie goes along; a page for it is on the plan). The answer carries `secret` once; it starts with `pst_`. While accounts are off, whoever runs the server gives you its shared `PITSTOP_TOKEN`. Either goes into `--token` below, once per checkout: setup keeps it in that checkout's `.pitstop/config.json` (git-ignored), and every command and daemon there takes it from that file and sends it to that file's server only. Do not export it in your shell profile: a token for one server has no business in a checkout of another.

## Install

The server hands out its own client:

```bash
npm install -g https://your-pitstop-server/pitstop-cli.tgz
pitstop version
```

That puts three commands on your PATH: `pitstop` (the CLI and the daemon), `pitstop-mcp` (the MCP server Claude Code starts) and `pitstop-hook` (Claude Code's hook). The same line again updates them. Nothing else is downloaded but TypeScript, which the daemon uses to see which symbols a change reads and writes.

## Set up a checkout

One command, from the directory you want to work in:

```bash
pitstop setup https://your-pitstop-server myteam/my-repo --token pst_…
```

What it does, and where it stops to tell you what to run:

1. Checks Node 22+, git and jj (with the install line for your system), and that jj knows who you are; when it does not, it takes your name and email from `git config`.
2. Asks the server for `myteam/my-repo` (created on the website first; lowercase `owner/name`).
   - **Its log is empty:** the git checkout you are in becomes its first entry, exactly as its `main` branch holds it: the checkout must be on a branch named `main` with at least one commit (`git branch -m master main` if that is what you have), and with **nothing uncommitted**. Setup stops and lists every edited, staged or untracked file (`.gitignore`d ones do not count): the log is append-only and every clone replays the first entry, so commit them, add them to `.gitignore`, or `git stash -u` them first. It then runs `jj git init --colocate` when needed; where git converts line endings (`core.autocrlf`, as Git for Windows sets it), jj is told to convert them the same way, so the entry carries the LF that git stores, not your checkout's CRLF.
   - **It has entries:** it is cloned from the log into `./my-repo`, or `--dir <dir>`.
   - **The directory is already a checkout of it** (you ran setup before): it is reused, nothing is imported or cloned.
   - **The directory is a checkout of another repository, or of the same name on another server:** setup stops; run it from a directory outside that checkout.
3. Wires Claude Code in that checkout, by command name, so the files hold no path of your laptop: `.mcp.json` (the `pitstop` server; `cmd /c pitstop-mcp` on Windows), `.claude/settings.local.json` (your own settings file: the `PostToolUse` hook, `pitstop-hook`, the server enabled, and its tools allowed with `mcp__pitstop` in `permissions.allow`, so Claude does not ask before each pitstop call), and `CLAUDE.local.md` (the house rules for the agent, below). Whatever those files already hold is kept, other hooks included. Those three go into `.git/info/exclude`, so they never end up in a commit; the rest of `.claude/` (the team's `settings.json`, commands, agents, skills) is committed like any other file. A wiring file your repository already tracks is the team's and is left alone: when that is `.mcp.json`, setup ends with the one line that registers the server for you only, `claude mcp add --scope local pitstop -- pitstop-mcp` (`-- cmd /c pitstop-mcp` on Windows).
4. Records the agent's name in `.pitstop/config.json` (`--agent alice-claude`; default `<your user>-claude`, or what an earlier setup recorded) and starts the daemon in the background, its output in `.pitstop/daemon.log`.

It ends with where the checkout is. Open Claude Code there (`cd my-repo && claude`); the `pitstop` tools are loaded and the agent knows the rules. Run setup again whenever something looks off: it re-checks, re-wires, starts the daemon if none runs, and restarts it when the agent name, token or server changed.

The token comes from `--token` or `PITSTOP_TOKEN` only, never from a `.pitstop/config.json` in the directory you run it from (that one may belong to another checkout of another server).

**A prompt for your Claude.** Setup can be run by the agent itself; give it something like: *"Run `npm install -g https://your-pitstop-server/pitstop-cli.tgz`, then `pitstop setup https://your-pitstop-server myteam/my-repo --token pst_…` here. If it stops, do what it says and run it again. Then tell me which directory to open you in."*

**The daemon.** `pitstop stop` anywhere in the checkout stops it, `pitstop start` starts it again in the background, with the server, repository, token and agent in the checkout's `.pitstop/config.json` (whatever your shell says). Both, like `commit`, `intent` and `status`, act on the nearest directory at or above the current one that has `.pitstop/config.json`, and `start` outside any checkout refuses. You rarely need either: when Claude Code opens the checkout and finds no daemon, the MCP server starts one, and so does the hook after a tool call.

**The house rules** (`CLAUDE.local.md`, and the MCP server's instructions): declare an intent with `declare_intent` before changing code; commit only with the `commit` tool, never `git commit`, `git push`, `jj commit` or `jj git push`; a refused commit names what changed, so re-read it, adapt, and commit again; follow the repository's architecture decisions, and leave a symbol another agent leased alone until its lease ends.

With accounts on, a teammate needs to be a writer of the repository first: after the teammate has signed in to the server once, the owner runs `PUT /repos/myteam/my-repo/members/<github-login>` with `{"role":"writer"}` against the server, with their own token (`reader` is enough to clone, not to commit).

## What Claude Code gets

Nine tools:

| Tool | What it does |
| --- | --- |
| `declare_intent` | opens a transaction: one line on what you are about to do, and the symbols you expect to touch (`path#name`); other agents see it, and the server warns about overlapping work. The answer carries the repository's **brain**: its version, each accepted architecture decision (ADR) with its rules in one line, and any lease another agent holds on the symbols you declared |
| `commit` | sends the unfinished work as a commit with one line of intent; the answer says it landed, was repaired, or what to re-read and retry |
| `brain` | the repository's brain: version, accepted (and proposed) ADRs with their rules, live leases, open intents |
| `lease` | takes a short lease on one hot symbol (`path#name`) with a reason, before a risky change to it: while you hold it, another agent's commit that writes it is refused. It lives while your intent is open (heartbeats renew it; five minutes by default without one) and goes when you commit; `release: true` gives it back early. Refused, with the holder, when another agent has it |
| `history` | every change to a symbol, newest first: who, which intent, whether its signature changed; who has it declared or leased now |
| `why` | which entries touched a file, latest first, with their intents, repairs and the brain version they passed |
| `callers` | which entries read a symbol (from the read sets of landed changes, not a parsed call graph) and what they wrote, and which entries changed it |
| `status` | where this checkout stands: applied and head entry, pending entries, open intents |
| `who` | who else is working in the repository right now: each agent, its developer, working or idle, its intent, the files and symbols it is in, how fresh that is, and which of those files you are in too |

After every tool call the hook tells the daemon the agent is between tools. Entries that arrived meanwhile are applied then, and the agent is told what they touched: a symbol its change reads, a file it is editing, a conflict left in a file, a warning from the server, and another agent working in the same files or symbols right now (once, while it lasts). The same note says when an ADR was accepted or superseded (`brain v3: ADR-3 accepted: <title>: <decision>`), and when another agent took or gave up a lease on a symbol you declared or a file you are editing. Without an agent attached, the daemon applies entries as they arrive.

**Presence.** Each checkout's daemon tells the server, every heartbeat, what its agent is doing: working or idle, the open intent, the files with unfinished edits, the declared symbols. The server merges these into one live document per repository (a CRDT, so every copy agrees whatever order updates arrive in) and passes it to every checkout and to the website's Live tab. It is only ever a heads-up: nothing is refused because of it. A stopped daemon leaves at once; one that vanishes (a laptop that sleeps) fades out after two minutes. The daemon's own id for the checkout is in `.pitstop/replica`; if you copy a checkout folder, delete that file in the copy (the daemon's log says so when two checkouts share one).

The same loop by hand, from a terminal in the checkout: `pitstop intent -m "…" -s path#name` (prints the brain in brief too), `pitstop commit -m "…"`, `pitstop status`, `pitstop safe-point`, `pitstop brain`, `pitstop lease path#name [-r "why"] [--release]`.

**Architecture decisions** are proposed by a writer and accepted by an owner on the server (`POST /repos/:owner/:name/adrs`, then `…/adrs/<n>/accept`; the website shows them). An ADR is a decision in a sentence or two with its reason and consequences, which every agent receives when it declares an intent, plus rules the server checks on every commit: `forbid_import` (files matching a glob may not import a module matching another glob, or a package), `forbid_call` (may not call `db.query` or `eval`), `forbid_pattern` (may not contain a line matching a regular expression), and `ai_review` (a question a model answers about changes in scope, as advice only, when the server has a model). Accepting or superseding one moves the repository's brain version; every entry records the version it passed.

## By hand

What setup does, step by step, for when you want to see each part, or run the client from a clone of this repository instead of the tarball: `git clone https://github.com/vazovski37/pitstop && cd pitstop && npm install && npm run build`, then `alias pitstop='node /path/to/pitstop/daemon/dist/index.js'` (PowerShell: `function pitstop { node C:\path\to\pitstop\daemon\dist\index.js @args }`). With the tarball installed, `pitstop` is already there.

Tell jj who you are once: `jj config set --user user.name "Your Name"` and `jj config set --user user.email you@example.com`.

**The first checkout of a repository** (its files are already on your disk, in a git repository). The checkout must be on a branch named `main`, with jj alongside git: run `jj git init --colocate` in it once (rename `master` to `main` first if that is what you have).

```bash
cd my-repo
pitstop init https://your-pitstop-server --repo myteam/my-repo --token pst_…
```

`init` writes `.pitstop/config.json`, creates `myteam/my-repo` on the server (lowercase `owner/name`; with accounts on, you become its owner), and sends every tracked text file as the log's first entry. It prints what it did. `--no-import` only configures; `pitstop import [-m "…"]` sends the files later, as long as the checkout is still at #0. Then start the daemon and leave it running in that terminal:

```bash
pitstop daemon
```

**Every other checkout**, on the same laptop or a teammate's, comes from the log:

```bash
pitstop clone https://your-pitstop-server myteam/my-repo [dir] --token pst_…
cd my-repo
pitstop daemon
```

**Claude Code**, from a build of this repository: in the checkout, `node <pitstop>/mcp/dist/setup.js .` writes `.mcp.json` and the `PostToolUse` hook in `.claude/settings.local.json` with absolute paths to that build (keep `.mcp.json` out of the repository, or let each laptop run it). Existing entries in both files are kept, and either setup replaces the other's pitstop entries. Then open Claude Code in the checkout.

## Environment

| Variable | Means | Default |
| --- | --- | --- |
| `PITSTOP_SERVER` | the server | `.pitstop/config.json`, else `http://localhost:8080` |
| `PITSTOP_TOKEN` | your token; only for a server `PITSTOP_SERVER` names, or a checkout whose `.pitstop/config.json` has none | `.pitstop/config.json` |
| `PITSTOP_REPO` | the repository, `owner/name` | `.pitstop/config.json` |
| `PITSTOP_DEVELOPER` | who you are on commits (with a personal token, your login wins) | your OS user name |
| `PITSTOP_AGENT` | which agent this checkout is; make it distinct per laptop | the `agent` in `.pitstop/config.json` (`pitstop setup --agent`), else `claude-code` |
| `PITSTOP_WORKTREE` | the checkout the MCP server and the hook act on | the nearest directory with `.pitstop/config.json` at or above Claude Code's |
| `PITSTOP_DAEMON_PORT` | the daemon's local API port | a free one |
| `PITSTOP_JJ_BIN`, `PITSTOP_GIT_BIN`, `PITSTOP_MERGIRAF_BIN` | the executables when not on PATH | `jj`, `git`, `mergiraf` |

For commands you run by hand, the environment wins over `.pitstop/config.json`: a `PITSTOP_SERVER` or `PITSTOP_REPO` left in a shell redirects them there. The token follows the server: a checkout's own token goes to its own server and wins there, and only `PITSTOP_TOKEN` goes to a server `PITSTOP_SERVER` names instead. The background daemon always runs with the checkout's settings: the one `pitstop setup` starts gets what setup was given, and one started by `pitstop start` (or by Claude Code, which runs it) gets what `.pitstop/config.json` says, whatever the shell carries. Set none of these globally; the environment is for one-off runs and scripts.

## What the server does with write skew

The server's owner chooses: `PITSTOP_VALIDATE` is `warn` by default (a commit with write skew lands, with a warning on the stream), `enforce` refuses it, `off` skips the check; and `PITSTOP_REPAIR`, `off` by default in the code, is `agent` on the hosted server and in this repository's `.env.example` (the committing agent is told what changed and commits again), or `groq` (the server asks Groq Cloud for a patch and lands it as a repair). The refusals below are what `agent` produces; under `groq` a write skew lands repaired instead, and `why` shows the repair's summary.

## What a refusal means

- **`constraint_failed`**: a file or symbol you changed was also changed by an entry that landed first. The daemon has applied that entry to your checkout; re-read the named files, adapt, and commit again.
- **`escalated`** (or `repair_failed`): write skew. You read something, for example a function's signature, that another entry changed after you read it. The message names the entries and the symbols. Re-read them at the current head, adapt your change, and commit again. From then on your reads are checked from the entry you were told about, so the adapted commit is not refused for the same reason.
- **`escalated` that says a resolver decides**: on a repository with members, write skew waits for the member marked resolver (or the owners) on the website. Do not commit the change again (the server refuses it while it waits); at a later safe point the note says whether it landed as it is or was sent back, and with what to change.
- **`constraint_failed` that names an ADR**: your change breaks an architecture decision. The message gives each offending line and the rule, then what the decision says to do instead, for example `ADR-1 "Pages never touch the database": src/pages/Profile.tsx:3 imports src/db/client.ts, which the rule forbid_import src/pages/** -> src/db/** forbids. Do instead: Pages read data through src/services.` Change those lines and commit again; there is no way around it short of an owner superseding the ADR.
- **`constraint_failed` that names a lease**: your change writes a symbol another agent holds a lease on; the message names the holder, their intent and when the lease ends. Leave that symbol out of this commit (commit the rest), or wait: the lease goes when its holder commits, when they release it, or when it expires (a crashed agent's intent goes stale after five minutes without a heartbeat, and its leases with it).
- **`invalid_request`**: the request itself was wrong: a repository that does not exist on the server (`pitstop init` first), a base LSN ahead of the log, a malformed file. The message says which. "Nothing to commit" is raised on your side before any request, and a token that may not write the repository is a plain `401`/`403` (see "When something is off").

## What lives where

- `.pitstop/` in each checkout: `config.json` (server, token, repository, agent), `state.json` (the last entry applied, the open intent), `daemon.json` (the running daemon's pid and local port), `daemon.log` (the background daemon's output), a lock. It ignores itself; never commit it.
- `.mcp.json`, `.claude/settings.local.json` and `CLAUDE.local.md`, when `pitstop setup` wrote them: listed in `.git/info/exclude`, so neither git nor jj ever commits them. One your repository already tracks is left as it is (setup says so). Everything else in `.claude/` is part of the repository.
- `main` in git and jj is always the last entry applied. Your unfinished work is jj's working copy `@` on top of it. Everything the daemon does to `main` is a plain git commit with the entry's author and timestamp, so every `pitstop clone` of a repository has identical history, entry for entry, with the same commit ids. The checkout that ran `init` keeps its older git history underneath #1, so its ids differ from the clones' (and from the mirror's) even though the trees are the same; a clone has no history before the import.
- Nothing is pushed to GitHub by the daemon. The server can mirror a repository to GitHub as an export (`PUT /repos/:owner/:name/mirror`); the log stays the source of truth.

## Limits today

- Read and write sets, which make write skew detectable, exist for **TypeScript** projects: the checkout needs its own `tsconfig.json`. Other languages commit fine, with empty sets, so only file-level conflicts are caught.
- Text files only. `import` skips binary files with a note; `commit` does not yet, so do not add binary files to a Pitstop repository. The server's type-check gate needs the `tsconfig.json` to work without `node_modules`.
- A clone replays the log entry by entry, about a second each; fine for hundreds of entries. A clone contains only what the log has: a repository initialised with `--no-import` and never imported cannot be cloned completely.
- `callers` knows what landed changes referred to (their read sets), not a parsed call graph of the whole repository: code nobody changed through Pitstop has no callers yet.
- The ADR rules read TypeScript and JavaScript text (imports, calls, patterns); other languages only meet `forbid_pattern`.
- On Windows, keep the checkout's path short (jj's index files have 128-character names) and let `jj` write to the checkout freely.

## When something is off

| You see | What it means | What to do |
| --- | --- | --- |
| `No daemon is running in … Starting one did not work` | the tools found no daemon and could not start one | `pitstop start` in that checkout says why; so does `.pitstop/daemon.log` |
| `no daemon is running in …` (the CLI) | `.pitstop/daemon.json` is missing or stale | `pitstop start` in that checkout |
| `a daemon is already running in …` | `pitstop daemon` refuses a second one per checkout | nothing, or `pitstop stop` first |
| setup: `… is on branch master` | an import follows a branch named `main` | `git branch -m master main`, then setup again |
| setup: `… has changes that are not committed to main` | the first entry is `main` as it is; the listed files would otherwise reach the agent's first commit | commit them, `.gitignore` them, or `git stash -u` (with jj: `jj new main`), then setup again |
| setup: `… is already a Pitstop checkout of …` | you ran setup inside a checkout of another repository or server | run it from a directory outside that checkout |
| `… is not inside a Pitstop checkout` | `pitstop start`/`daemon` found no `.pitstop/config.json` here or above | `cd` into the checkout, or run `pitstop setup` first |
| setup: `jj git init` fails with `os error 3` (Windows) | the checkout's path is too long for jj | a shorter path, e.g. `--dir C:\code\my-repo` |
| `server answered 401/403 with something that is not a CommitResponse` | the token is missing, wrong, or not a writer of the repository | check `PITSTOP_TOKEN`; the owner adds you with `PUT …/members/<login>` |
| the clone has only some files | the log did not begin with a full import (`--no-import`, never imported) | the owner re-creates the repository with `pitstop init` (or `import`) from a clean checkout |
| `the log of … skips #N` | the server returned the log with a hole | retry; if it repeats, the server's log is the problem |
| `this worktree is at #N, ahead of the log` | `.pitstop/state.json` was copied from elsewhere or the server was reset | `pitstop clone` into a fresh directory and carry your unfinished work over (`git diff main` as a patch); delete `state.json` only in a checkout with nothing on `main` yet, since a replay stacks every entry on top of what is there |
| `gave up, stopped at #N` | the server kept skipping the next entry | the same as above; if it repeats, the server's log is the problem |
| `apply failed, stopped at #N` | an entry could not be applied; jj was rolled back to before it | read the message, fix the cause (usually a file the daemon could not write), restart the daemon |
| conflict markers in a file after a safe point | an entry changed lines you were editing; Mergiraf could not merge them by structure | resolve the markers, then commit; `jj resolve --list` shows the files |
| `EPERM` around `state.json` | another process had the file open for a moment (Windows) | it retries by itself; nothing to do |

## Reporting problems

Open an issue on `vazovski37/pitstop` (private until the public release: ask Vazovski for access) with the daemon's log lines (`[pitstop] …`, in `.pitstop/daemon.log` when it runs in the background), the server's answer if a commit was refused, `pitstop status` and `pitstop version`.
