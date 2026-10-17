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
- `pitstop import` once per repository, from the first worktree: every tracked text file as an add at base LSN 0, so the server can rebuild the tree at any entry (the type-check gate needs that). The second worktree's daemon then receives it from LSN 0.
- `pitstop daemon` (`npm run dev -w @pitstop/daemon -- daemon` from the repo) connects to `PITSTOP_SERVER` (default `http://localhost:8080`), subscribes from the LSN in `.pitstop/state.json`, applies entries in order and stops on the first failure. When it applies an entry over unfinished edits in `@`, it records the LSN those edits began at (`readBaseLsn` in the state file).
- `pitstop commit -m "<intent>"` sends `@` against `main` as a `CommitRequest` with file contents, the read and write sets from `symbols.ts` (empty when the worktree has no `tsconfig.json`), and `readBaseLsn` when the daemon recorded one. If the accepted entry is the next one for this worktree it is applied at once; otherwise the running daemon applies it in order.
- Environment: `PITSTOP_TOKEN`, `PITSTOP_DEVELOPER`, `PITSTOP_AGENT`, and `PITSTOP_JJ_BIN` / `PITSTOP_GIT_BIN` when the executables are not on PATH.
- No server at hand: `npm run fake-server -w @pitstop/daemon` replays `packages/protocol/fixtures/server-messages.json` on port 8081 and accepts commits. The tests use the same fake (`src/fake-server.ts`); the ones against a real jj repo (`src/jj.test.ts`) skip themselves where jj is not installed.

Symbol sets (`symbols.ts`): two TypeScript programs from the worktree's own `tsconfig.json`, the tree at `main` and the tree at `@`, both in memory. A symbol is a top-level declaration or a class member, `path#qualified.name`. Write set: text changed, added or removed. Signature write set: the checker's signature or type string changed, or the symbol was removed. Read set: every project symbol a changed declaration refers to, types included, lib and `node_modules` excluded. Comment and whitespace edits count as writes. `src/symbols.test.ts` runs the two laptops' edits from `demo/scenario.md` against `demo/teamdb`.

Source map: `stream.ts` (subscribe, order, gaps, readBaseLsn), `jj.ts` (the apply sequence below, `@` as file changes, trees at `main` and `@`), `symbols.ts`, `commit.ts` (commit and import), `state.ts`, `fake-server.ts`, `index.ts` (CLI).

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
