# The demo scenario

Two agents, two people, one TeamDB slice (`demo/teamdb`). Agent A fixes a bug in auth; agent B adds a feature to the profile page. Git would merge the two cleanly and the result would not type-check: B's profile page reads `.lastSeenAt` from `getCurrentUser()`, which can now return null. Pitstop holds B's commit back as write skew and names the symbol. On the hosted server it waits on the website for a person on the team, who sends it back with a note; the agent adapts and commits again. `demo/REHEARSAL.md` is the run sheet with every screen; this file is what each checkout actually does.

## Who is who

| | Checkout A | Checkout B |
| --- | --- | --- |
| Person | the repository's owner (Vazovski), signed in with GitHub | the teammate, signed in with their own GitHub account, a writer |
| Agent name | `agent-a` (`pitstop setup … --agent agent-a`) | `agent-b` |
| Task | fix the expired-session bug (issue #58) | show last-seen on the profile page (issue #61) |
| Decides on write skew | yes: the owner is the resolver | no |

Who decides matters. A held-back commit waits on the website only when someone other than its committer can decide: the members marked resolver, or, when none is marked, the owners (`server/src/app.ts`, `decidersOf`). With the owner as resolver and B committing as the teammate, B's commit waits for the owner. If the teammate were the only resolver, B's commit would go straight back to agent B instead (see "The catch").

## Start state

- **Checkout A** is a fresh copy of the slice made by `demo/scripts/reset.sh <dir>`: a git repository on `main` with everything committed, jj colocated, dependencies installed, typecheck and tests green. The owner creates an empty repository on the website and runs the Set up Claude prompt there; `pitstop setup` imports the slice as entry **#1** (`import <folder name>`, 14 files, empty symbol sets), so the server can rebuild the tree at any entry.
- **Checkout B** comes from the same prompt, made by the teammate after #1 landed: `pitstop setup` clones the log into a new folder and starts its daemon at #1. The clone has no `node_modules`; run `npm ci` in it before the agent runs `tsc` or `vitest`.
- Both daemons run in the background, both checkouts show in the Live tab's Who's here, nothing is in flight.

The slice, at the symbols that matter:

| Symbol | At the start |
| --- | --- |
| `src/auth/session.ts#getCurrentUser` | `(now?) => SessionUser`. Throws when nobody is signed in. Bug: ignores `expiresAt` (TeamDB issue #58). |
| `src/auth/session.ts#SessionUser` | `User` plus `lastSeenAt: Date`, known only to the session layer. |
| `src/router.ts#handle` | `/` → `renderHome()`, `/profile` → `renderProfile(getCurrentUser().id)`. |
| `src/pages/HomePage.ts#renderHome` | calls `getCurrentUser()` for the name. |
| `src/pages/ProfilePage.ts#renderProfile` | `(userId) => string`; name and email from `findUser` (`src/models/user.ts`, imported on line 1); no last-seen yet (issue #61). |
| `src/utils/timeAgo.ts#timeAgo` | "3 hours ago". Already exists; the agent finds it by reading the code and it ends up in B's read set. |

## Checkout A: fix the bug

Prompt: **"Fix the expired-session bug in auth (issue #58): getCurrentUser must not return a user whose session has expired. Return null in that case instead of throwing, and make the callers handle it. Turn the todo test into a real one."**

Expected commit, **#2**:
- `getCurrentUser(now?)` returns `SessionUser | null` (null when nobody is signed in or `now >= expiresAt`). This is a signature change: `sigWriteSet` is `src/auth/session.ts#getCurrentUser`.
- `src/router.ts`: `/profile` redirects to `/login` when the user is null. `src/pages/HomePage.ts`: the same, or a guest greeting. `writeSet` adds `src/router.ts#handle` and `src/pages/HomePage.ts#renderHome`.
- Tests: the todo in `session.test.ts` becomes a passing test, and `router.test.ts` changes too (it signs in at a fixed time, so a real expiry check breaks it). Five files, as `demo/scripts/gate4.sh` commits them.
- Not touched: `src/pages/ProfilePage.ts`.

## Checkout B: add the feature

Started at the same time, on #1. B's daemon holds #2 until B's next tool call, as long as B's agent made a tool call in the last ten minutes. On stage that next call is the commit itself, so B commits from #1 and #2 lands right after it (step 3 of "The catch"). Any other tool call on B between A's commit and B's commit applies #2 before the commit, with step 3's note. If B has been idle for more than ten minutes, #2 applies as soon as it lands, without that note. Either way B's reads are checked from #1, so the catch still happens.

Prompt: **"Show when the user was last seen on the profile page (issue #61), like 'Last seen 3 hours ago'. Keep the router as it is; the page can ask the session layer for the current user."** On stage, add: "When tsc and vitest pass, stop and tell me; do not commit until I say so." That keeps the order A then B.

Expected commit, based on #1:
- `src/pages/ProfilePage.ts` only: calls `getCurrentUser()` for `lastSeenAt` and formats it with `timeAgo`.
- `writeSet` is `src/pages/ProfilePage.ts#renderProfile`, no signature change. `readSet` includes `src/auth/session.ts#getCurrentUser`, `src/auth/session.ts#SessionUser`, `src/utils/timeAgo.ts#timeAgo` and `src/models/user.ts#findUser`.
- B touches no test file. A router test from B would collide with A's `router.test.ts` and turn the story into a plain write-write refusal.

## The catch

When B commits, #2 is already in the log. B's write set does not overlap A's (no structural conflict), but B's change **reads** `getCurrentUser`, which #2 changed, and the change was to its signature. That is write skew: both commits are correct alone, and together `renderProfile` reads `.lastSeenAt` from a value that can now be null.

What the hosted server does (`PITSTOP_REPAIR=agent`, set in `infra/main.bicep`):
1. The validator finds `getCurrentUser` in B's read set and in #2's `sigWriteSet`: `#2 changed src/auth/session.ts#getCurrentUser (signature)`.
2. **On this repository the owner decides, so the commit waits.** B's commit is refused `escalated` and parked as `pk_…`: "This repository's resolver (<owner>) decides on it: your commit waits as pk_… at <site>/#/r/<owner>/<name>/conflicts. Do not commit this change again; at a later safe point you will be told whether it landed or what to change." B's daemon moves its read base past #2. A `dependency_changed` warning goes on the stream, so the Live tab shows it and the Conflicts tab counts it.
3. At B's next safe point its daemon applies #2 under the unfinished page and notes `#2 "Fix the expired-session bug in auth" changed src/auth/session.ts#getCurrentUser (signature), which your change reads`.
4. **The owner sends it back** on the Conflicts tab with a note ("guard the null user before reading lastSeenAt"). B's agent gets the note at its next tool call. By then it has usually stopped after the refusal, and it makes no tool call by itself, so prompt it (`Check the pitstop status tool.`); it then guards the null and commits again. #3 lands with no `repairs` row; checkout A applies it at its next safe point.

The other outcomes, for when the stage does not match:
- **Let it through** instead of sending back: the parked commit lands as it was, as #3, with `checks.details` `write skew accepted by <owner>: …` and a `repairs` row `write skew accepted as is by <owner>`. That page does not type-check against #2, so on stage send it back.
- **Nobody else can decide** (the committer is the only resolver or owner, or the repository has no members, as `gate4.sh` and `rehearse.sh` make it): the plain escalation. B's agent gets `write skew: … Re-read those files at head #2, adapt your change to them, and commit again with baseLsn 2.`, adapts on its own, and #3 lands. The stream still says so: `"<intent>" by <developer> went back to agent-b to adapt: write skew, …`.
- **`PITSTOP_REPAIR=groq`**: the server asks Groq Cloud for the guard, type-checks the patch against the tree at head, and lands #3 with `repairs: [{ againstLsn: 2, kind: "semantic", summary: … }]`. No gate exercises that path; try it on a laptop with `GROQ_API_KEY` set.

## After the catch: the brain

- **An ADR.** The owner proposes and accepts "Pages never import models" on the Brain tab: one rule, files may not import, files `src/pages/**`, module `src/models/**`. The brain moves to v1. `src/pages/ProfilePage.ts` already imports `../models/user.js` (line 1 in the slice; after #3 it is on whatever line B's agent left it, line 2 when the agent puts `../auth/session.js` above it as `gate4.sh` does), so Re-check lists it at that line with the entries that landed under brain v0 (#1 and #3), unless B's agent dropped `findUser`, in which case Re-check says `Everything at head follows the accepted rules.`; a commit that edits that file without touching the line is not blocked (the violation is noted as pre-existing). A commit that adds `import { findUser } from "../models/user.js";` to `src/pages/HomePage.ts` is refused with the file, the line, the rule and "Do instead:" with the decision.
- **A lease.** Agent A declares a new intent naming `src/auth/session.ts#getCurrentUser` and takes a lease on it with the `lease` tool. Agent B, declaring an intent on the same symbol, is told in the answer that it is leased; a commit from B that writes `getCurrentUser` is refused until A commits or the lease expires. A lease blocks writes only: B's #61 page only reads `getCurrentUser`, so the lease step needs a task that changes it.

## What to check

- `GET /log?repo=<owner>/<name>&fromLsn=1` with a personal token: #2 has `sigWriteSet` with `getCurrentUser`; #3 has `getCurrentUser` in `readSet` and no repairs.
- The Live tab: both intents while open and gone at their commits, the `overlapping_intent` warning to both agents (only when both intents declare `src/auth/session.ts#getCurrentUser`; the prompts above do not ask for it, so B may have to be told to declare it, as in `REHEARSAL.md` at 0:45), the `1 signature` badge on #2, the parked warning `for agent-b: … waits for <owner>: write skew, …`, the send-back warning, and #3 landing.
- The Conflicts tab: the card while it waits, then `Sent back by <owner>` with the note.
- On checkout B at #3, `npx tsc -p tsconfig.json --noEmit` and `npx vitest run` pass. B's first page failed `tsc` once #2 applied under it, because the user from `getCurrentUser()` is possibly null. `/profile` with no live session redirects to `/login`; that guard is A's router change in #2, not #3.

## Reset

Each take needs a new repository name: the log is append-only and repositories cannot be deleted. Close Claude Code and run `pitstop stop` in the old checkouts first (Windows will not delete a folder a daemon runs in), then `demo/scripts/reset.sh <dir>` for checkout A, a new repository on the website, the teammate added and the resolver marked again, and both prompts made again (a prompt names its repository). `demo/REHEARSAL.md` has the steps.
