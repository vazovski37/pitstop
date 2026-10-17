# The demo scenario

Two agents, two laptops, one TeamDB slice (`demo/teamdb`). Agent A fixes a bug in auth; agent B adds a feature to the profile page. Git would merge the two cleanly and the app would crash; Pitstop flags the second commit as write skew and repairs it. Design doc section 13.7 has the stage script with timings; this file is what each laptop actually does.

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
| `src/utils/timeAgo.ts#timeAgo` | "3 hours ago". Already exists; the reuse warning should point agent B at it. |

## Laptop A (Vazovski): fix the bug

Prompt: **"Fix the expired-session bug in auth (issue #58): getCurrentUser must not return a user whose session has expired. Return null in that case instead of throwing, and make the callers handle it. Turn the todo test into a real one."**

Expected commit, `#121`:
- `getCurrentUser(now?)` returns `SessionUser | null` (null when nobody is signed in or `now >= expiresAt`). This is a signature change: `sigWriteSet` includes `src/auth/session.ts#getCurrentUser`.
- `src/router.ts`: `/profile` redirects to `/login` when the user is null. `src/pages/HomePage.ts`: the same, or a guest greeting.
- The todo in `session.test.ts` becomes a passing test.
- Not touched: `src/pages/ProfilePage.ts`.

## Laptop B (teammate): add the feature

Started at the same time, on `#120`, so it never sees `#121` until it commits.

Prompt: **"Show when the user was last seen on the profile page (issue #61), like 'Last seen 3 hours ago'. Keep the router as it is; the page can ask the session layer for the current user."**

Expected commit, based on `#120`:
- `src/pages/ProfilePage.ts`: calls `getCurrentUser()` to get `lastSeenAt` and formats it with `timeAgo` (the `similar_symbol` warning should name `timeAgo`, so the agent does not write its own formatter).
- `readSet` includes `src/auth/session.ts#getCurrentUser` and `src/auth/session.ts#SessionUser`; `writeSet` is `src/pages/ProfilePage.ts#renderProfile`.
- A router test for the new line.

## The catch

When B commits, `#121` is already in the log. B's write set does not overlap A's (no structural conflict), but B **read** `getCurrentUser`, which `#121` changed, and the change was to its signature. That is write skew: both commits are correct alone, and together `renderProfile` calls `.lastSeenAt` on a value that can now be null.

Expected on the server:
1. The validator finds `getCurrentUser` in B's read set and in `#121`'s `sigWriteSet`.
2. The type-check gate on the merged tree fails on `ProfilePage.ts` ("Object is possibly null").
3. AI repair, given both intents and both diffs, adds `if (!user) return redirect("/login")` (or an equivalent guard) in `renderProfile`; type check and tests pass.
4. `#122` lands with `repairs: [{ againstLsn: 121, kind: "semantic", summary: ... }]`, and both laptops apply it at their next safe point.

## What to check

- `GET /log?fromLsn=120`: `#121` has `sigWriteSet` with `getCurrentUser`; `#122` has `getCurrentUser` in `readSet` and one `repair` against `121`.
- The live view shows both intents while they are open, the warning to B about `getCurrentUser` and `timeAgo`, and `#122` highlighted as repaired.
- On laptop B, after `#122` applies, `/profile` for an expired session redirects instead of crashing.

## Reset

`demo/scripts/reset.sh <dir>` on each laptop, then restart the daemon there. Keep a second copy ready at the start state so a failed take costs seconds.
