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

## Access
`PITSTOP_TOKEN`, when set, guards every route except `/healthz` and `/version`: `Authorization: Bearer <token>`, or `?token=` where a browser cannot set headers. Unset means open; keep it set on Azure (`infra/main.bicep` wires the GitHub secret).

## Validation
`src/validate.ts` runs inside `Store.append`, under the append lock, against the entries after the commit's base (writes from `baseLsn`, reads from `readBaseLsn`). Write-write on a file or symbol: `rejected constraint_failed` with `conflictsWith`; the daemon rebases and retries. Write skew (a read symbol changed in the gap): `PITSTOP_VALIDATE=warn` (default) lands it with the skew in `checks.details` and a `warning` on the stream, `enforce` answers `rejected repair_failed`, `off` skips the validator. AI repair and the type-check gate replace `warn` in Phase 4.

## Known constraint
The stream keeps subscribers in memory, so the Container App runs exactly one replica (`infra/main.bicep`). To scale out later, fan new entries out through Postgres `LISTEN/NOTIFY`.

## Commands
- `npm run db:up` (repo root): local Postgres with pgvector.
- `npm run dev -w @pitstop/server`: server with reload, reads `../.env`.
- `PITSTOP_STORE=memory npm run dev -w @pitstop/server`: the same without Postgres (nothing persisted); enough for daemon work.
- `npm test` (repo root): unit tests; migration tests run when `DATABASE_URL` is set.

## Phases owned here
1: `POST /commit` fast path + stream. 2: Azure. 4: validator, Mergiraf, AI repair, type-check gate. 5: one ADR rule, early warnings, git mirror.
