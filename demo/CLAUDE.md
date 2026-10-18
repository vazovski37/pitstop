# demo/ — the stage

Owner: **both**. Vazovski prepares it; both rehearse with it.

## What this folder holds
- `teamdb/`: a small slice of TeamDB that the two agents edit during the demo. It is a workspace of this repo so `npm run typecheck` and `npm test` keep it green, but on stage it runs as its own repository: `scripts/reset.sh <dir>` copies it out as a fresh git + jj repo.
- `scenario.md`: who is who, what each checkout does, the prompts, the expected commits, the write skew the server must catch and who decides it, and the brain steps after it.
- `REHEARSAL.md`: the run sheet for the hosted flow: two GitHub accounts, a repository made on the website, the Set up Claude prompt on each laptop, the owner as resolver deciding the held commit on the Conflicts tab, then an ADR and a lease. Every step with what each screen shows, the long and the three-minute version, what to do when a step fails, and the offline gates.
- `scripts/`: `reset.sh` (a fresh copy of the slice; in the hosted flow it makes checkout A, which setup imports), `gate1.sh` (the Phase 1 gate: one laptop, a local server, two worktrees kept identical) and `gate4.sh` (the Phase 4 gate: one laptop, a local server, the plain escalation), `rehearse.sh` (two checkouts with the administrator's shared token, no accounts, the plain escalation).

## Rules
- **Do not fix the known bugs in `teamdb/`.** Issue #58 (expired sessions) and issue #61 (last-seen on the profile page) are the demo: the agents fix them live. The test that documents #58 is an `it.todo` in `session.test.ts`.
- Keep `teamdb/` self-contained: its `tsconfig.json` and `package.json` must work after `reset.sh` copies it out of this repo. No imports from the rest of the monorepo.
- Change `scenario.md` whenever the slice changes; the two must agree on symbol names. `src/pages/ProfilePage.ts` importing `../models/user.js` is the existing violation the ADR step's Re-check shows: keep it.
- Keep `REHEARSAL.md` in step with what the website and the agent tools print; it quotes them.
