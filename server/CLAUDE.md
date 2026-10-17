# server/ — log, validator, AI repair

Owner: **Vazovski**. Teammate's Claude does not edit this folder (except `server/semantic/`, which the teammate owns).

## What this folder does
The single source of truth: the write-ahead log, the commit API, the WebSocket stream, the commit validator, structural merge, AI repair and constraint checks. Design reference: the technical design doc (written when the project was called Agent Git), sections 4 to 7 and 11.

## Rules
- Every message in or out matches a schema in `@pitstop/protocol`. Validate input with `CommitRequest.parse(...)` etc. Never invent a field locally.
- The log is append-only. No `update` or `delete` on `changesets`, `changeset_files` or `changeset_symbols`.
- Assign LSNs inside one Postgres transaction. `PgStore.append` takes `pg_advisory_xact_lock` and uses `max(lsn) + 1`, so two concurrent commits never get the same LSN or skip one. Keep every append on that path.
- Schema changes go in a new `migrations/NNN_name.sql`. Never edit an applied migration.
- `buildApp()` in `src/app.ts` takes its dependencies as arguments so tests use `app.inject()` with fakes. Keep it that way.
- Never deploy from a laptop. Pushing to `main` deploys through GitHub Actions.

## Repositories
One server, many repositories (`repos` table, migration 003). LSNs count per repository and every log table is keyed by `(repo, lsn)`; `PgStore.append` locks per repository. A request without `repo` means `local/default`; an unknown repository is `invalid_request` (`POST /repos` first). A stream socket follows one repository from its `subscribe` on and is answered with `head` before any entry. `GET /repos`, `GET /repos/:owner/:name`, `GET /log?repo=`.

## Mirror
`src/mirror.ts` with `src/github.ts`: when `MIRROR_GITHUB_TOKEN` is set, every accepted entry of a repository with a mirror (`PUT /repos/:owner/:name/mirror`, table `repo_mirrors`) becomes a commit on its GitHub branch through the Git Data API, no git binary and no clone. Commits use the daemon's recipe (`daemon/src/jj.ts`, `buildCommit`: author `agent <developer@pitstop.local>`, committer `pitstop daemon`, both dates `createdAt`, message `#lsn intent`), so every laptop and GitHub name the same commit; the worker warns when GitHub's id differs. One worker per repository, in LSN order, position in Postgres; a push that is not a fast-forward marks the mirror `diverged` until a new `PUT`. The mirror is an export, never the truth.

## Access
`src/auth.ts`. Three identities: the shared `PITSTOP_TOKEN` (super-user), a personal token `pst_…` (a user; `author.developer` becomes their login), or a session cookie from sign in with GitHub (`GET /auth/github`, needs `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`). A server with neither a shared token nor accounts is open. With accounts, `repo_members` (migration 005) decide: commits, intents and the mirror need writer or owner; the log, the stream and `GET /repos/:o/:n` need reader or a public repository; a repository with no members is open to any signed-in user. Routes: `/me`, `/tokens`, `/repos/:o/:n/members/:login`, `PATCH /repos/:o/:n {visibility}`. `Authorization: Bearer <token>`, or `?token=` where a browser cannot set headers; the browser's WebSocket carries the cookie.

## Validation
`src/validate.ts` runs inside `Store.append`, under the append lock, against the entries after the commit's base (writes from `baseLsn`, reads from `readBaseLsn`). Write-write on a file or symbol: `rejected constraint_failed` with `conflictsWith`; the daemon rebases and retries. Write skew (a read symbol changed in the gap): `PITSTOP_VALIDATE=warn` (default) lands it with the skew in `checks.details` and a `warning` on the stream, `enforce` answers `rejected repair_failed`, `off` skips the validator. With a resolver (`PITSTOP_REPAIR`), the validator only reports skew: `agent` answers `rejected escalated` with what changed, and the coding agent that committed fixes its change and commits again; `groq` (`src/repair.ts`, `src/groq.ts`) asks Groq Cloud for a patch to the commit's own files, type-checks it against `treeAt(head)`, retries once with the errors, and escalates after two failures. A repaired entry lands with the patched files and a `repairs` row, so every worktree receives the fixed version. The repair runs inside the append lock, so a model call holds other commits for a few seconds.

## Early warnings
`POST /intents` compares the new intent's `declaredSymbols` with the repository's open intents (`Store.openIntents`) and broadcasts one `warning` of kind `overlapping_intent` to each side (`validate.ts`, `overlapWarnings`). No staleness filter yet: an intent stays open until a commit names it. `similar_symbol` (semantic reuse) is cut unless time is left.

## Checks
`src/checks.ts` runs `tsc --noEmit` on `Store.treeAt(head)` plus the commit's files, in a temp folder, with the server's own TypeScript (a dependency, so the image has it). The tree must carry its own `tsconfig.json` and need nothing from `node_modules`: the demo slice does, the pitstop repo itself does not. `PITSTOP_CHECK=always` gates every commit (a failure is `rejected constraint_failed` with tsc's errors); `off` (default) leaves it to the repair path. `treeAt` needs the repository to have entered the log as a full import at its first entry.

## Live view
`web/` (its own `CLAUDE.md`) is a static page the server serves at `/` with `@fastify/static` when `buildApp` gets `webDir`; `index.ts` takes `PITSTOP_WEB_DIR` or `web/dist` next to the server, and the Dockerfile builds it into the image. The files are open routes (`/*`): on a shared-token server the page asks for the token itself and sends it on every request. API routes are registered before the static wildcard, so they win. `GET /repos/:owner/:name/worktrees` (reader access) answers what each connected daemon heartbeated on its socket, `appliedLsn` and the open `intentId`, with the intent's agent as the name and the head to compare against; the stream keeps that per socket (`Stream.worktrees`), so it lives on the one replica like the subscribers.

## Known constraint
The stream keeps subscribers in memory, so the Container App runs exactly one replica (`infra/main.bicep`). To scale out later, fan new entries out through Postgres `LISTEN/NOTIFY`.

## Commands
- `npm run db:up` (repo root): local Postgres with pgvector.
- `npm run dev -w @pitstop/server`: server with reload, reads `../.env`.
- `PITSTOP_STORE=memory npm run dev -w @pitstop/server`: the same without Postgres (nothing persisted); enough for daemon work.
- `npm test` (repo root): unit tests; migration tests run when `DATABASE_URL` is set.

## Phases owned here
1: `POST /commit` fast path + stream. 2: Azure. 4: validator, Mergiraf, AI repair, type-check gate. 5: one ADR rule, early warnings, git mirror.
