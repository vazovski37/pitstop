# server/ — log, validator, AI repair

Owner: **Vazovski**. Teammate's Claude does not edit this folder (except `server/semantic/`, which the teammate owns).

## What this folder does
The single source of truth: the write-ahead log, the commit API, the WebSocket stream, the commit validator, structural merge, AI repair and constraint checks. Design reference: the technical design doc (written when the project was called Agent Git), sections 4 to 7 and 11.

## Rules
- Every message in or out matches a schema in `@pitstop/protocol`. Validate input with `CommitRequest.parse(...)` etc. Never invent a field locally.
- The log is append-only. No `update` or `delete` on `changesets`, `changeset_files` or `changeset_symbols`.
- Assign LSNs inside one Postgres transaction (`select coalesce(max(lsn), 0) + 1 ... for update` on a lock row, or a sequence plus the commit in the same transaction). Two concurrent commits must never get the same LSN or skip one.
- Schema changes go in a new `migrations/NNN_name.sql`. Never edit an applied migration.
- `buildApp()` in `src/app.ts` takes its dependencies as arguments so tests use `app.inject()` with fakes. Keep it that way.
- Never deploy from a laptop. Pushing to `main` deploys through GitHub Actions.

## Known constraint
The stream keeps subscribers in memory, so the Container App runs exactly one replica (`infra/main.bicep`). To scale out later, fan new entries out through Postgres `LISTEN/NOTIFY`.

## Commands
- `npm run db:up` (repo root): local Postgres with pgvector.
- `npm run dev -w @pitstop/server`: server with reload, reads `../.env`.
- `npm test` (repo root): unit tests; migration tests run when `DATABASE_URL` is set.

## Phases owned here
1: `POST /commit` fast path + stream. 2: Azure. 4: validator, Mergiraf, AI repair, type-check gate. 5: one ADR rule, early warnings, git mirror.
