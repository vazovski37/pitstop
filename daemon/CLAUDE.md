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
