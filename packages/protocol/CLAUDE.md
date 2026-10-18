# packages/protocol — the contract

Owner: **both**. This package is the interface between the server (Vazovski) and the daemon, MCP tools and live view (teammate).

## Rules
- Change a schema only after both owners agree. Propose the change in chat or a PR description first.
- Every schema change updates the matching fixture in `fixtures/` and keeps `npm test` green.
- Additive changes (a new optional field, a new message type) are safe. Renaming or removing a field breaks the other side: do it in one coordinated change.
- No runtime logic here beyond schemas, with one exception: the presence CRDT's merge (`src/presence.ts`), because every replica (server, daemon, browser) must run the very same merge for the document to converge. It stays pure and dependency-free (zod only). No imports from `server/` or `daemon/`.

## What lives here
- `src/index.ts`: zod schemas and the types derived from them (`CommitRequest`, `Changeset`, `CommitResponse`, `Intent`, `IntentRequest`, `Repo`, `RepoId`, `ServerMessage`, `ClientMessage`, `Health`), and the brain's (section 9): `Adr` with its `AdrRule`s, `Lease`, and the `brain`, `lease` and `presence` messages.
- `src/presence.ts`: presence as a state-based CRDT, a last-writer-wins map keyed by replica (one per worktree) with hybrid logical clock stamps; `mergePresence` is a join (commutative, associative, idempotent; `presence.test.ts` checks it on random histories). The web page cannot import runtime code from here (no bundler), so it repeats the few lines of `applyPresence`.
- `fixtures/*.json`: one valid example of each message. Both halves use these in their own tests; `brain.json` holds the ADR, lease and presence examples.

Design reference: the technical design doc (written when the project was called Agent Git), sections 5.2 and 8.2.
