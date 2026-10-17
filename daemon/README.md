# Pitstop for your repository

This is the guide for a team that wants its coding agents to commit through Pitstop: what to install, how to connect a repository, and what the daily loop looks like. It covers the two client pieces, the daemon (`daemon/`) and the agent tools (`mcp/`). Running your own server is in [SETUP.md](../SETUP.md).

## How it works, in one paragraph

A Pitstop server keeps an ordered log of every change to a repository. Each checkout on each laptop runs a **daemon** that follows that log and applies new entries into the checkout at **safe points**, between the agent's tool calls, never mid-edit. An agent declares an **intent** before a task, works, and **commits** through an MCP tool; the server checks the commit against everything that landed meanwhile, including what the agent *read* and someone else changed (write skew), and either lands it, repairs it, or hands it back with exactly what to re-read. Your checkout stays a normal git repository the whole time, with Jujutsu colocated so unfinished work is never lost.

## What you need

| Piece | Why | Install |
| --- | --- | --- |
| Node.js 22 or newer | the daemon and the tools | nodejs.org |
| git | the checkout | git-scm.com |
| Jujutsu (`jj`) 0.46 or newer | the daemon rebases your unfinished work with it | `winget install jj-vcs.jj`, `brew install jj` |
| Mergiraf, optional | merges conflicts by structure instead of leaving markers | `winget install Mergiraf.Mergiraf`, `brew install mergiraf` |
| A server URL and a token | where the log lives | from whoever runs the server (below) |
| This repository, built | the daemon and tools are not published yet | `git clone https://github.com/vazovski37/pitstop && cd pitstop && npm install && npm run build` |

Tell jj who you are once: `jj config set --user user.name "Your Name"` and `jj config set --user user.email you@example.com`.

The commands below are `node <pitstop>/daemon/dist/index.js …`, where `<pitstop>` is where you cloned this repository. Put an alias on it: `alias pitstop='node /path/to/pitstop/daemon/dist/index.js'` (PowerShell: `function pitstop { node C:\path\to\pitstop\daemon\dist\index.js @args }`). The rest of this page writes `pitstop`.

**Getting a token.** On a server with accounts, open the server's page in a browser, sign in with GitHub, and create a personal token; it starts with `pst_` and is shown once. On a self-hosted server without accounts, the shared `PITSTOP_TOKEN` from its configuration is the token. Either goes into `--token` below, or into `PITSTOP_TOKEN` in your environment.

## Connect a repository

**The first checkout of a repository** (its files are already on your disk, in a git repository):

```bash
cd my-repo
pitstop init https://your-pitstop-server --repo myteam/my-repo --token pst_…
```

`init` writes `.pitstop/config.json`, creates `myteam/my-repo` on the server (you become its owner), and sends every tracked text file as the log's first entry. It prints what it did. Then start the daemon and leave it running in that terminal:

```bash
pitstop daemon
```

**Every other checkout**, on the same laptop or a teammate's, comes from the log:

```bash
pitstop clone https://your-pitstop-server myteam/my-repo [dir] --token pst_…
cd my-repo
pitstop daemon
```

A teammate needs to be a writer of the repository first: the owner runs `PUT /repos/myteam/my-repo/members/<github-login>` with `{"role":"writer"}` against the server, with their own token.

## Wire up Claude Code

In the checkout, once:

```bash
node <pitstop>/mcp/dist/setup.js .
```

This writes two files: `.mcp.json`, which registers the `pitstop` MCP server, and `.claude/settings.json`, which adds a `PostToolUse` hook. Both carry absolute paths to your Pitstop build, so keep them out of the repository (`.gitignore` them) or let each laptop run setup itself. Existing entries in both files are kept.

Open Claude Code in the checkout. It now has five tools:

| Tool | What it does |
| --- | --- |
| `declare_intent` | opens a transaction: one line on what you are about to do, and the symbols you expect to touch (`path#name`); other agents see it, and the server warns about overlapping work |
| `commit` | sends the unfinished work as a commit with one line of intent; the answer says it landed, was repaired, or what to re-read and retry |
| `why` | which entries touched a file, latest first, with their intents and repairs |
| `callers` | which entries read a symbol and which changed it |
| `status` | where this checkout stands: applied and head entry, pending entries, open intents |

After every tool call the hook tells the daemon the agent is between tools. Entries that arrived meanwhile are applied then, and the agent is told what they touched: a symbol its change reads, a file it is editing, a conflict left in a file, a warning from the server. Without an agent attached, the daemon applies entries as they arrive.

The same loop by hand, from a terminal in the checkout: `pitstop intent -m "…" -s path#name`, `pitstop commit -m "…"`, `pitstop status`, `pitstop safe-point`.

## What a refusal means

- **`constraint_failed`**: a file or symbol you changed was also changed by an entry that landed first. The daemon has applied that entry to your checkout; re-read the named files, adapt, and commit again.
- **`escalated`** (or `repair_failed`): write skew. You read something, for example a function's signature, that another entry changed after you read it. The message names the entries and the symbols. Re-read them at the current head, adapt your change, and commit again. From then on your reads are checked from the entry you were told about, so the adapted commit is not refused for the same reason.
- **`invalid_request`**: the commit itself was malformed, for example nothing to commit, or a repository the token may not write. The message says which.

On a server with AI repair on, a write skew may instead land as a repaired entry; the commit answer and `why` show the repair's summary.

## What lives where

- `.pitstop/` in each checkout: `config.json` (server, token, repository), `state.json` (the last entry applied, the open intent), `daemon.json` (the running daemon's local port), a lock. It ignores itself; never commit it.
- `main` in git and jj is always the last entry applied. Your unfinished work is jj's working copy `@` on top of it. Everything the daemon does to `main` is a plain git commit with the entry's author and timestamp, so two checkouts of one repository have identical history.
- Nothing is pushed to GitHub by the daemon. The server can mirror a repository to GitHub as an export (`PUT /repos/:owner/:name/mirror`); the log stays the source of truth.

## Limits today

- Read and write sets, which make write skew detectable, exist for **TypeScript** projects: the checkout needs its own `tsconfig.json`. Other languages commit fine, with empty sets, so only file-level conflicts are caught.
- Text files only; binary files are skipped with a note. The server's type-check gate needs the `tsconfig.json` to work without `node_modules`.
- A clone replays the log entry by entry, about a second each; fine for hundreds of entries.
- On Windows, keep the checkout's path short (jj's index files have 128-character names) and let `jj` write to the checkout freely.

## When something is off

| You see | What it means | What to do |
| --- | --- | --- |
| `no daemon is running in …` | the tools and the hook cannot find `.pitstop/daemon.json` | start `pitstop daemon` in that checkout |
| `the log of … skips #1` | the repository's log did not begin with an import | ask the owner; `pitstop init` makes the import |
| `this worktree is at #N, ahead of the log` | `.pitstop/state.json` was copied from elsewhere or the server was reset | delete `.pitstop/state.json` and restart the daemon; it applies from the start |
| `gave up, stopped at #N` | the server kept skipping the next entry | the same as above; if it repeats, the server's log is the problem |
| `apply failed, stopped at #N` | an entry could not be applied; jj was rolled back to before it | read the message, fix the cause (usually a file the daemon could not write), restart the daemon |
| conflict markers in a file after a safe point | an entry changed lines you were editing; Mergiraf could not merge them by structure | resolve the markers, then commit; `jj resolve --list` shows the files |
| `EPERM` around `state.json` | another process had the file open for a moment (Windows) | it retries by itself; nothing to do |

## Reporting problems

Open an issue on `vazovski37/pitstop` with the daemon's log lines (`[pitstop] …`), the server's answer if a commit was refused, and `pitstop status`.
