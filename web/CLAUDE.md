# web/ — live view

Owner: **teammate**. Empty until Phase 5; create the Next.js app here then (`npx create-next-app@latest .`).

## What it shows (the screen judges look at during the demo)
- The log, newest first: LSN, agent, intent, files; repairs highlighted.
- Open intents and which symbols each declared.
- Each worktree's applied LSN vs the server head.
- Conflicts and repairs as they happen; click a line to see its intent.

## Rules
- Read-only client of the server's `/stream` and query API. It never writes.
- Message shapes come from `@pitstop/protocol`.
- Deployed by CI like the server; never from a laptop.
