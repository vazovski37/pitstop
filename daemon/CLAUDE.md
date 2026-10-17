# daemon/ — the local replica

Owner: **teammate**. Vazovski's Claude does not edit this folder.

## What this folder does
One process per worktree. It keeps the local folder in sync with the server's log and turns the agent's edits into commits. Design reference: the technical design doc (written when the project was called Agent Git), sections 6.3, 8 and 13.1.

## Responsibilities
1. Connect to `GET /stream` (WebSocket), send `{ "type": "subscribe", "fromLsn": <applied LSN> }`, apply entries strictly in LSN order; re-request on a gap.
2. Apply entries only at **safe points** (between agent tool calls, never during a test or build run). The Claude Code hook in `mcp/` signals them.
3. Use **Jujutsu colocated with git** (`jj git init --colocate`). The agent's unfinished work is jj's working-copy change `@`. To apply an entry: move `main` to it, then rebase `@` onto `main`. jj records conflicts instead of stopping; run Mergiraf on conflicted files and notify the agent only if something remains.
4. Compute read and write sets with the TypeScript compiler API (exact references), marking signature changes as `sigWriteSet`.
5. Send commits as `CommitRequest` (from `@pitstop/protocol`) with an idempotency key, retrying safely.

## Rules
- Every message matches `@pitstop/protocol`. Test against `packages/protocol/fixtures/` (see `src/index.test.ts`).
- Never delete or overwrite the agent's unfinished edits. If an apply fails, stop applying and report; jj's operation log can undo.
- Phase 0 spike first: confirm the exact jj command sequence for "move main, rebase @, detect conflicts" and write it down in this file.

## Phases owned here
1: stream + apply into a jj worktree + send commits. 2: read/write sets. 4: safe points, rebase of unfinished work, agent notifications.

## Running it (Phases 1 and 2)
In a worktree that is `jj git init --colocate`d with a `main` bookmark:
- `pitstop init <server-url> [--repo owner/name] [--token t]` once per worktree: writes `.pitstop/config.json` (the environment still overrides it: `PITSTOP_SERVER`, `PITSTOP_TOKEN`, `PITSTOP_REPO`), creates the repository on the server (`POST /repos`, idempotent), and, when that repository's log is empty and this worktree has applied nothing, imports the worktree as its first entry. A second worktree of the same repository is only configured; its daemon then receives the import from LSN 0. Once a repository is configured, subscribe, commits and intents carry it, and `GET /log` is asked for it.
- `pitstop import` by hand: every tracked text file as an add at base LSN 0, so the server can rebuild the tree at any entry (the type-check gate needs that).
- `pitstop daemon` (`npm run dev -w @pitstop/daemon -- daemon` from the repo) connects to `PITSTOP_SERVER` (default `http://localhost:8080`), subscribes from the LSN in `.pitstop/state.json`, applies entries in order and stops on the first failure. When it applies an entry over unfinished edits in `@`, it records the LSN those edits began at (`readBaseLsn` in the state file).
- `pitstop commit -m "<intent>"` sends `@` against `main` as a `CommitRequest` with file contents, the read and write sets from `symbols.ts` (empty when the worktree has no `tsconfig.json`), and `readBaseLsn` when the daemon recorded one. If the accepted entry is the next one for this worktree it is applied at once; otherwise the running daemon applies it in order.
- Environment: `PITSTOP_TOKEN`, `PITSTOP_DEVELOPER`, `PITSTOP_AGENT`, and `PITSTOP_JJ_BIN` / `PITSTOP_GIT_BIN` when the executables are not on PATH.
- No server at hand: `npm run fake-server -w @pitstop/daemon` replays `packages/protocol/fixtures/server-messages.json` on port 8081 and accepts commits. The tests use the same fake (`src/fake-server.ts`); the ones against a real jj repo (`src/jj.test.ts`) skip themselves where jj is not installed.

Symbol sets (`symbols.ts`): two TypeScript programs from the worktree's own `tsconfig.json`, the tree at `main` and the tree at `@`, both in memory. A symbol is a top-level declaration or a class member, `path#qualified.name`. Write set: text changed, added or removed. Signature write set: the checker's signature or type string changed, or the symbol was removed. Read set: every project symbol a changed declaration refers to, types included, lib and `node_modules` excluded. A declaration's text excludes the comments above it, so a doc-comment-only edit is not a write; whitespace inside the declaration is. `src/symbols.test.ts` runs the two laptops' edits from `demo/scenario.md` against `demo/teamdb`.

## The agent side (Phase 4)
`pitstop daemon` also serves a local HTTP API on `127.0.0.1`, port in `.pitstop/daemon.json`, for the MCP tools and the hook in `mcp/` (`daemon.ts`; `local-client.ts` finds and calls it):
- `POST /safe-point`: the agent is between tools. Pending entries are applied now, and the answer carries notes for the agent: entries that changed symbols its change reads or writes (from `symbols.ts` on `@`), files it is editing that an entry touched, conflict markers an apply left, and the server's `warning`s for this agent since the last safe point. Once a safe point has been seen, entries wait for the next one; a daemon that has seen none for ten minutes applies as they arrive, as in Phase 1.
- `POST /intents {text, symbols?}`: opens a transaction on the server (`intents.ts`); the id goes into the state file, heartbeats carry it, the next commit closes it. Declaring also fixes `readBaseLsn` at the applied LSN of that moment.
- `POST /commit {intent}`: the same as the CLI; 200 with the changeset, or 409 with the server's rejection verbatim (`reason`, `message`, `conflictsWith`), which the commit tool shows the agent. A skew refusal (`escalated`, `repair_failed`) names the entries the agent read past and tells it to re-read them at head, so `commit.ts` moves `readBaseLsn` past those entries: the adapted commit is checked from there, not refused for the same skew again. The safe-point notes stay a heads-up only; they see the agent's edits, not what it read before editing, so they never move the read base. Found by the Phase 4 gate on 2026-10-17.
- `GET /status`, `GET /why?path=`, `GET /callers?symbol=` (the last two from `GET /log`, until the server has a query API).
- Conflicts: the rebase writes git-style (diff3) markers (`--config ui.conflict-marker-style=git`). When Mergiraf is installed (`winget install Mergiraf.Mergiraf`, or `PITSTOP_MERGIRAF_BIN`), each conflicted file goes through `jj resolve --tool mergiraf <file>` (Mergiraf refuses `mergiraf solve` inside a jj repository); what structure allows (both sides added a key, a function, an import) is merged and reported as `resolved`, the rest keeps its markers and is reported to the agent at the next safe point.
- CLI: `pitstop intent -m "<text>" [-s a#b,c#d]`, `pitstop safe-point` (the hook's command), `pitstop status`.

The daemon and `pitstop commit` are separate processes on one worktree, and the server pushes an accepted entry on the stream before it answers the commit, so both would apply the same entry at once. Every apply runs under `.pitstop/lock` (`state.ts`, `withWorktreeLock`) and re-reads the state once it holds the lock; the second one finds the entry applied. A lock older than a minute belongs to a dead process and is taken over. Found by the Phase 1 gate on 2026-10-17.

Source map: `stream.ts` (subscribe, order, gaps, readBaseLsn, holding for safe points), `daemon.ts` (the process: local API, safe points, notes), `intents.ts`, `jj.ts` (the apply sequence below, `@` as file changes, trees at `main` and `@`), `symbols.ts`, `commit.ts` (commit and import), `state.ts` (state file and lock), `config.ts`, `local-client.ts`, `fake-server.ts` (now also `POST /intents`, `GET /log`, scripted rejections), `index.ts` (CLI).

## jj apply sequence
Tested on Windows 11 with jj 0.46.0 (`winget install jj-vcs.jj`) and git 2.x, in a colocated repo (`jj git init --colocate`), on 2026-10-17. The daemon runs these as child processes with the worktree as cwd; no shell is involved, so quote nothing.

The entry's commit is built with git plumbing, not by switching jj's working copy: the agent's files on disk are touched exactly once, by the final rebase.

```bash
# 0. Snapshot the agent's unfinished edits into @ and remember where to roll back to.
jj util snapshot
jj op log -n1 --no-graph -T id            # -> RESTORE_OP (128 hex chars)

# 1. Build the entry's commit on top of main. One blob per FileChange with content;
#    for a delete use `git update-index --force-remove <path>` instead of --cacheinfo.
git rev-parse refs/heads/main             # -> OLD_MAIN
git hash-object -w --stdin < <content>    # -> BLOB, one per file
GIT_INDEX_FILE=.git/pitstop-index git read-tree OLD_MAIN
GIT_INDEX_FILE=.git/pitstop-index git update-index --add --cacheinfo 100644,BLOB,<path>
GIT_INDEX_FILE=.git/pitstop-index git write-tree   # -> TREE; then delete .git/pitstop-index
git commit-tree TREE -p OLD_MAIN -m "#<lsn> <intent>"   # -> NEW_MAIN

# 2. Move main. The third argument is a compare-and-swap: fails if main moved underneath us.
git update-ref refs/heads/main NEW_MAIN OLD_MAIN

# 3. Rebase the agent's working copy @ onto the new main. jj imports git refs itself on every
#    command in a colocated repo, so `jj git import` is not needed (it prints "No import needed").
jj rebase -d main

# 4. Detect conflicts. The revset is `conflicts()`; `conflicted()` does not exist in 0.46.
jj log -r conflicts() --no-graph -T change_id   # empty output = clean; otherwise one change id per line
```

Observed results:
- Clean case (agent edited `b.txt`, entry changed `a.txt`): after step 3, `a.txt` has the entry's content, `b.txt` keeps the agent's edit, `@` sits on the new `main`.
- Conflict case (both changed the same line): step 3 still succeeds, `@` is marked `(conflict)`, step 4 prints its change id, and the file on disk carries jj's markers (`<<<<<<<`, `%%%%%%%`, `+++++++`, `>>>>>>>`). This is the input for Mergiraf (Phase 4).

Rollback, two levels:
- `jj undo` reverts only the rebase: `@` goes back onto the old main with the agent's edit intact and no markers, but `main` (jj bookmark and git ref) stays on the new entry.
- `jj op restore RESTORE_OP` reverts everything since step 0: `main` returns to OLD_MAIN in both jj and git, `@` is as snapshotted. Use this when an apply fails, then report; never retry over a half-applied state.

Windows 11 gotchas:
- jj stores index segments as 128-character file names under `.jj/repo/index/segments/`. Under a long worktree path (about 100 characters or more) `jj git init` fails with "The system cannot find the path specified (os error 3)". Keep worktrees short, like `C:\Users\<you>\Desktop\pitstop`. A `subst` drive letter does not help because jj canonicalizes the path.
- The jj identity must be set (`jj config set --user user.name/user.email`) or `@` is created with an empty author.
- Replacing `.pitstop/state.json` by rename fails with `EPERM` for a few milliseconds while another process (the daemon, the CLI, a test) still has it open for reading; `state.ts` retries both the read and the rename.
- When git made the repository's first commits (as `demo/scripts/reset.sh` does) and `jj git init --colocate` came after, git HEAD stays a symbolic ref to `main`. Step 2 would then move HEAD as well, and jj treats a moved HEAD as a `git checkout` the user already did, so step 3 leaves the files on disk untouched. The daemon detaches HEAD at its current commit before step 0 (`git update-ref --no-deref HEAD <commit>`), which jj does not notice. Found by the Phase 1 gate on 2026-10-17.
