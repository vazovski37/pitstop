# demo/ — the stage

Owner: **both**. Vazovski prepares it; both rehearse with it.

## What this folder holds
- `teamdb/`: a small slice of TeamDB that the two agents edit during the demo. It is a workspace of this repo so `npm run typecheck` and `npm test` keep it green, but on stage it runs as its own repository: `scripts/reset.sh <dir>` copies it out as a fresh git + jj repo.
- `scenario.md`: what each laptop does, the prompts, the expected commits, and the write skew the server must catch and repair.
- `scripts/`: `reset.sh` now; the Phase 1 gate script once the daemon exists.

## Rules
- **Do not fix the known bugs in `teamdb/`.** Issue #58 (expired sessions) and issue #61 (last-seen on the profile page) are the demo: the agents fix them live. Tests that document them are `it.todo`.
- Keep `teamdb/` self-contained: its `tsconfig.json` and `package.json` must work after `reset.sh` copies it out of this repo. No imports from the rest of the monorepo.
- Change `scenario.md` whenever the slice changes; the two must agree on symbol names.
