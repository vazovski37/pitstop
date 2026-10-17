# The demo scenario

Two agents, two laptops, one TeamDB slice (`demo/teamdb`). Agent A fixes a bug in auth; agent B adds a feature to the profile page. Git would merge the two cleanly and the app would crash; Pitstop refuses the second commit as write skew, names the symbol, and tells the agent what to re-read, and the agent adapts and commits again (`PITSTOP_REPAIR=agent`, what `demo/scripts/gate4.sh`, `rehearse.sh` and the Azure server run). Design doc section 13.7 has the stage script with timings and `demo/REHEARSAL.md` the run sheet; this file is what each laptop actually does.

## Start state

Both laptops hold the same copy of the slice, made by `demo/scripts/reset.sh <dir>` (a fresh git + jj repo, dependencies installed, typecheck and tests green), with a daemon running in it and the live view open. Nothing is in flight.

The log starts with the slice itself: the first daemon's first commit adds every file (`tsconfig.json`, `package.json`, `src/**`), so the server can rebuild the tree at any entry and type-check a repair against it. The second laptop's daemon then subscribes from 0 and receives that import.

The slice, at the symbols that matter:

| Symbol | At the start |
| --- | --- |
| `src/auth/session.ts#getCurrentUser` | `(now?) => SessionUser`. Throws when nobody is signed in. Bug: ignores `expiresAt` (TeamDB issue #58). |
| `src/auth/session.ts#SessionUser` | `User` plus `lastSeenAt: Date`, known only to the session layer. |
| `src/router.ts#handle` | `/` → `renderHome()`, `/profile` → `renderProfile(getCurrentUser().id)`. |
| `src/pages/HomePage.ts#renderHome` | calls `getCurrentUser()` for the name. |
| `src/pages/ProfilePage.ts#renderProfile` | `(userId) => string`; name and email from `findUser`; no last-seen yet (issue #61). |
| `src/utils/timeAgo.ts#timeAgo` | "3 hours ago". Already exists; the agent finds it by reading the code and it ends up in B's read set. There is no `similar_symbol` warning: semantic reuse is cut. |

## Laptop A (Vazovski): fix the bug

Prompt: **"Fix the expired-session bug in auth (issue #58): getCurrentUser must not return a user whose session has expired. Return null in that case instead of throwing, and make the callers handle it. Turn the todo test into a real one."**

Expected commit, `#121`:
- `getCurrentUser(now?)` returns `SessionUser | null` (null when nobody is signed in or `now >= expiresAt`). This is a signature change: `sigWriteSet` includes `src/auth/session.ts#getCurrentUser`.
- `src/router.ts`: `/profile` redirects to `/login` when the user is null. `src/pages/HomePage.ts`: the same, or a guest greeting.
- The todo in `session.test.ts` becomes a passing test.
- Not touched: `src/pages/ProfilePage.ts`.

## Laptop B (the second laptop, or a second worktree on one): add the feature

Started at the same time, on `#120`, so it never sees `#121` until it commits.

Prompt: **"Show when the user was last seen on the profile page (issue #61), like 'Last seen 3 hours ago'. Keep the router as it is; the page can ask the session layer for the current user."**

Expected commit, based on `#120`:
- `src/pages/ProfilePage.ts`: calls `getCurrentUser()` to get `lastSeenAt` and formats it with `timeAgo` (the agent finds `timeAgo` itself; no `similar_symbol` warning exists).
- `readSet` includes `src/auth/session.ts#getCurrentUser` and `src/auth/session.ts#SessionUser`; `writeSet` is `src/pages/ProfilePage.ts#renderProfile`.
- A router test for the new line.

## The catch

When B commits, `#121` is already in the log. B's write set does not overlap A's (no structural conflict), but B **read** `getCurrentUser`, which `#121` changed, and the change was to its signature. That is write skew: both commits are correct alone, and together `renderProfile` calls `.lastSeenAt` on a value that can now be null.

Expected on the server (`PITSTOP_REPAIR=agent`, what `gate4.sh`, `rehearse.sh` and Azure run):
1. The validator finds `getCurrentUser` in B's read set and in `#121`'s `sigWriteSet`.
2. B's commit is refused `escalated`: "write skew: #121 changed src/auth/session.ts#getCurrentUser (signature) … Re-read those files at head #121, adapt your change to them, and commit again". B's daemon moves its read base past `#121`.
3. At B's next safe point its daemon applies `#121` over the unfinished page and notes "#121 changed getCurrentUser (signature), which your change reads". B's agent guards the null (`if (!user) return redirect("/login")` or equivalent) and commits again.
4. `#122` lands, with no `repairs` row, and laptop A applies it at its next safe point.

With `PITSTOP_REPAIR=groq` instead, step 2 is the server asking Groq Cloud for that guard, type-checking the patch against the tree at head, and landing `#122` with `repairs: [{ againstLsn: 121, kind: "semantic", summary: … }]`; no gate exercises that path, try it on a laptop with `GROQ_API_KEY` set.

## What to check

- `GET /log?fromLsn=120`: `#121` has `sigWriteSet` with `getCurrentUser`; `#122` has `getCurrentUser` in `readSet` (and one `repair` against `121` only in `groq` mode).
- The live view shows both intents while they are open, the `overlapping_intent` warning to both agents about `getCurrentUser`, the `1 signature` badge on `#121`, and `#122` landing (highlighted as repaired only in `groq` mode). The refusal itself reaches the page once the server broadcasts escalations on the stream (on the plan).
- On laptop B, after `#122` applies, `/profile` for an expired session redirects instead of crashing.

## Reset

`demo/scripts/reset.sh <dir>` on each laptop, then restart the daemon there. Keep a second copy ready at the start state so a failed take costs seconds.
