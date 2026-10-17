# packages/protocol — the contract

Owner: **both**. This package is the interface between the server (Vazovski) and the daemon, MCP tools and live view (teammate).

## Rules
- Change a schema only after both owners agree. Propose the change in chat or a PR description first.
- Every schema change updates the matching fixture in `fixtures/` and keeps `npm test` green.
- Additive changes (a new optional field, a new message type) are safe. Renaming or removing a field breaks the other side: do it in one coordinated change.
- No runtime logic here beyond schemas. No imports from `server/` or `daemon/`.

## What lives here
- `src/index.ts`: zod schemas and the types derived from them (`CommitRequest`, `Changeset`, `CommitResponse`, `Intent`, `IntentRequest`, `Repo`, `RepoId`, `ServerMessage`, `ClientMessage`, `Health`).
- `fixtures/*.json`: one valid example of each message. Both halves use these in their own tests.

Design reference: the technical design doc (written when the project was called Agent Git), sections 5.2 and 8.2.
