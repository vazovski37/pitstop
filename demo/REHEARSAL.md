# The rehearsal

The run sheet for the demo on the hosted server: two people, two Claude Code sessions, one Pitstop
repository made on the website, and the write skew from `scenario.md` held back and decided by a
person on the Conflicts tab. Then the brain: an architecture decision and a lease.

Everything quoted below (tool results, notes, page labels, toasts, event lines) is taken from the
code and its tests on 18 October 2026. The sheet has not yet been run end to end with two real
Claude Code sessions, so agent wording will vary; the server's and the page's texts will not. The
old shared-token story, which needs no accounts, is at the end ("Offline: the gates").

The server: `https://pitstop-server.bravebay-485f06a6.swedencentral.azurecontainerapps.io`, `$S`
below. It runs `PITSTOP_REPAIR=agent` with GitHub sign-in on.

Who is who:

| | Laptop A | Laptop B |
| --- | --- | --- |
| Person | the owner (Vazovski), signed in as their GitHub login | the teammate, signed in as their own GitHub login |
| Role in the repository | owner, and the **resolver** | writer |
| Agent name | `agent-a` | `agent-b` |
| Task | fix the expired-session bug (issue #58) | show last-seen on the profile page (issue #61) |
| Checkout | `C:\code\teamdb` (made by `reset.sh`) | `C:\code\<repository name>` (cloned by setup) |

**The owner is the resolver, not the teammate.** A held-back commit waits on the website only when
someone other than its committer can decide. B commits as the teammate, so the owner decides. If the
teammate were the only resolver, B's skew would go straight back to agent B and the Conflicts tab
would stay empty.

## Before the day, once

1. **Two GitHub accounts, both signed in once.** The teammate opens `$S`, clicks `Sign in with
   GitHub`, and that is all. Until then an invite stays `invited` and cannot be made resolver.
2. **Tools on each laptop:** Node.js 22+, git, jj (`winget install jj-vcs.jj`, then a new
   terminal so it is on PATH), Claude Code. jj needs a name and email; setup copies them from git,
   or stops with the two `jj config set --user …` commands to run. A client installed before this
   sheet's fixes reached the server needs reinstalling: `pitstop version` must say `0.1.6` or later
   (`npm install -g $S/pitstop-cli.tgz`; the setup prompt does it too). With 0.1.6 the daemon
   asks the server who its token belongs to, so the lease step needs no `PITSTOP_DEVELOPER`.
3. **Browsers.** The owner's browser is on the projector, signed in as the owner. The teammate uses
   their own browser (on one laptop: a second browser profile or a private window).
4. **Run the whole sheet once, a day before.** A used repository cannot be reset or deleted (the log
   is append-only), so each take gets its own name: `teamdb-take1`, `teamdb-take2`, … under the
   owner's login.

## Before each take: about five minutes, off camera

The setup prompt makes Claude Code run `pitstop setup … --token pst_…`, and Claude Code prints that
command with the full token. Do this part before recording, or revoke the tokens under Account
afterwards. The Set up Claude tab itself masks the token (`pst_ab12…`) unless you press Show token.

**Laptop A, the source checkout:**

```bash
bash demo/scripts/reset.sh /c/code/teamdb
```

It ends `ready: /c/code/teamdb (typecheck and tests green)`. If the folder held an earlier take,
close Claude Code there and run `pitstop stop` in it first: Windows will not delete a folder a daemon
runs in.

**Laptop A, on the website:**
1. Home page, New repository: Name `teamdb-take1`, `Create repository`. Toast:
   `<owner>/teamdb-take1 is ready. Next: set up Claude.`, and the page opens the Set up Claude tab.
2. The state line says `This repository is empty: the first setup imports the code from your
   existing checkout as entry #1.` In `Agent name` (it starts as `<owner>-claude`) type `agent-a`.
   Press `Create a token and write the prompt`, then `Copy prompt`. Its setup line ends
   `--token pst_ab12… --agent agent-a`.
3. In a terminal, start `claude` anywhere and paste the prompt. When Claude asks where the project
   is, answer `C:\code\teamdb`. Approve its commands as it installs the client and runs setup.
4. Setup's last lines:
   ```
   [pitstop] imported teamdb as #1
   [pitstop] ready: C:\code\teamdb is a checkout of <owner>/teamdb-take1 at #1; the agent there commits as "agent-a"
   [pitstop] daemon started (pid N); its log: C:\code\teamdb\.pitstop\daemon.log
   [pitstop] next: open Claude Code in that directory (cd "C:\code\teamdb" && claude): the pitstop tools, the hook and CLAUDE.local.md are in place
   [pitstop] to stop the daemon: `pitstop stop` there (Claude Code starts it again when it needs it)
   ```
   On Windows also `set jj's working-copy.eol-conversion to input-output …`; that is expected.
5. Close that Claude Code session. Open the second terminal and run `cd "C:\code\teamdb"`, then `claude` (two commands: Windows PowerShell 5.1, Windows Terminal's default, rejects `&&`). Trust
   the folder. The pitstop tools and the hook are already allowed; nothing else asks.

**Laptop A, Members tab:**
1. `Invite a teammate`: GitHub login of the teammate, Role `Writer`, `Send invite`. Toast:
   `<login> is added as writer.` (if it says `is invited … They join the first time they sign in`,
   they have not signed in yet: do that, then reload this tab).
2. Your own row: switch `Resolver` on. Toast: `<owner> now decides on conflicts.` The row gets the
   badge `resolver`.

**Laptop B, after #1 landed:**
1. The teammate signs in, opens the repository card on their home page, `Set up Claude` tab. Reload
   the tab if it still says the repository is empty: it must say `This repository has 1 entry: setup
   builds a fresh checkout from them and keeps it in sync.`
2. `Agent name` `agent-b`, then `Create a token and write the prompt`, `Copy prompt`. In a
   terminal on B, `claude` in `C:\code`, paste the prompt plus `Then run npm ci in the checkout.`
   Answer `C:\code` when it asks where the checkout should go.
3. Setup clones: `applied #1 of 1`, then `ready: C:\code\teamdb-take1 is a checkout of
   <owner>/teamdb-take1 at #1; the agent there commits as "agent-b"`. `npm ci` installs the slice's
   tools (without it `npx tsc` fetches an unrelated package).
4. Close that session; `cd "C:\code\teamdb-take1"`, then `claude`.

On one laptop for both: run B's setup from `C:\code` as above (it clones beside checkout A, into `C:\code\teamdb-take1`), never from inside `C:\code\teamdb`: there setup finds checkout A (same repository and server), reuses it, writes agent-b and the teammate's token into its config and restarts its daemon with them.

**Check, on the projector (Live tab):**

| Where | What it shows |
| --- | --- |
| Header | `head #1`, pill `live`, tabs `Live`, `Conflicts`, `Brain v0`, `Members`, `Set up Claude` |
| Log | `1 entry`: `#1 import teamdb`, agent-a, the owner, `14 files`, `base #0` |
| Who's here | 2: `agent-a` and `agent-b`, each `idle`, `applied #1 of #1` |
| Worktrees | 2: two rows `● worktree · applied #1 of #1` (named `worktree` while the daemon has no open intent; each row appears with its daemon's first heartbeat, about 30 s after the daemon starts) |
| Open intents | `None open.` |

The onboarding box (`Get this repository going`) disappears once the repository has an entry and a
second member; that is expected.

## The run: about twelve minutes

Times are from the first prompt. Agent time is the uncertain part: two to four minutes per task in
rehearsal, so the clock assumes three. Do not reload the projector's page during the run: a reload
replays only the head, the open intents and who is here, not the event history.

### 0:00 Both agents check in

Type on each laptop: `Call the pitstop status tool.`

- **Each screen:** `C:\code\… is at #1 (head #1), nothing pending; no open intent of yours.`
- **Say:** "Two checkouts, each a live replica of one log on the server."

### 0:30 Laptop A gets its task

Type on A, the prompt from `scenario.md`:

> Fix the expired-session bug in auth (issue #58): getCurrentUser must not return a user whose
> session has expired. Return null in that case instead of throwing, and make the callers handle
> it. Turn the todo test into a real one.

The house rules in `CLAUDE.local.md` make the agent declare its intent first.

- **A's screen:** `Intent int_… is open at #1: "Fix the expired-session bug in auth". Declared: src/auth/session.ts#getCurrentUser. Use the commit tool when the work is done.` and `Brain v0: no accepted ADRs.`
- **Live:** Open intents 1; Who's here `agent-a … working` with the intent; As it happens
  `agent-a intends: "Fix the expired-session bug in auth"`.
- **If it fails:** the agent edits without declaring: `Declare your intent with the pitstop declare_intent tool first, symbols src/auth/session.ts#getCurrentUser.`

### 0:45 Laptop B gets its task

Type on B:

> Show when the user was last seen on the profile page (issue #61), like 'Last seen 3 hours ago'.
> Keep the router as it is; the page can ask the session layer for the current user. When tsc and
> vitest pass, stop and tell me; do not commit until I say so.

- **B's screen:** `Intent int_… is open at #1: "Show last-seen on the profile page". Declared: src/pages/ProfilePage.ts#renderProfile, src/auth/session.ts#getCurrentUser. …`
  After its next tool call the hook adds, under `Pitstop:`:
  `warning: agent-a is already working on src/auth/session.ts#getCurrentUser (intent: Fix the expired-session bug in auth); expect a conflict unless you coordinate`
  and `agent-a (<owner>) is also changing src/auth/session.ts#getCurrentUser, for 'Fix the expired-session bug in auth'`.
- **A's screen,** at A's next tool call, under `Pitstop:`: `warning: agent-b just started on src/auth/session.ts#getCurrentUser (intent: Show last-seen on the profile page)` and `agent-b (<teammate>) is also changing src/auth/session.ts#getCurrentUser, for 'Show last-seen on the profile page'` (the second line can come one tool call later).
- **Live:** Open intents 2; As it happens, newest first:
  `for agent-a: agent-b just started on src/auth/session.ts#getCurrentUser (…)` and
  `for agent-b: agent-a is already working on src/auth/session.ts#getCurrentUser (…); expect a conflict unless you coordinate`, both orange.
- **Say:** "Like pg_stat_activity: Pitstop saw the overlap before either agent wrote a line."
- **If it fails:** no warning: the warnings fire only on exactly the same declared symbol; tell B's
  agent to declare again with `src/auth/session.ts#getCurrentUser`. B stops to ask whether to go
  on: `Go ahead; A's change is small, you will be told what it did.`

### 1:00 to 4:00 Both agents work

Nothing to type. A edits `session.ts`, `router.ts`, `HomePage.ts` and the two test files, and runs
`npx tsc -p tsconfig.json --noEmit` and `npx vitest run`. B edits `ProfilePage.ts`, runs the same,
and stops: "tests pass, ready to commit".

- **Live:** Who's here shows each agent's files as chips while they edit.
- **Say:** what the log is (every change with its intent, its read set and its write set) and what a
  daemon is (a replica that applies entries only between its agent's tool calls, like a garbage
  collector's safe points).
- **If it fails:** B finishes first: fine, it waits. A commits on its own: fine, that is the next
  step. B commits before A: see "B lands first".

### 4:00 Laptop A commits

When A's checks pass (or type `Commit it with the pitstop commit tool.`):

- **A's screen:** `Committed as #2 "Fix the expired-session bug in auth" (5 files); main moved to it.`
- **Live:** `head #2`; the `#2` row on top with the orange badge `1 signature`; As it happens, newest first:
  `agent-a's intent committed: "Fix the expired-session bug in auth"` and
  `#2 landed: "Fix the expired-session bug in auth" by agent-a, 5 files`. Click the row: signatures
  `src/auth/session.ts#getCurrentUser`.
- **B's checkout:** nothing yet. B's agent is attached, so #2 waits for B's next tool call.
- **Say:** "That badge is the point: a public signature changed, and B's code relies on it."

### 4:30 Laptop B commits, and it is held for the resolver

Type on B: `Commit now with the pitstop commit tool.`

- **B's screen,** the tool result, the server's message with the tool's prefix once and nothing
  added but the entry it conflicts with:
  `Commit rejected (escalated): write skew: #2 changed src/auth/session.ts#getCurrentUser (signature). This repository's resolver (<owner>) decides on it: your commit waits as pk_… at $S/#/r/<owner>/teamdb-take1/conflicts. Do not commit this change again; at a later safe point you will be told whether it landed or what to change. Conflicts with #2.`
  To Claude Code the refusal is a failed tool, and it runs no PostToolUse hook after a failed tool, so nothing is applied yet. At B's next tool call (the agent usually re-reads a file at once; if B is idle, type on B: `Check the pitstop status tool.`) the hook applies #2 and adds, in this order: `Pitstop applied #2 to this worktree.`,
  `warning: "Show last-seen on the profile page" by <teammate> waits for <owner>: write skew, #2 changed src/auth/session.ts#getCurrentUser (signature) (pk_…)`,
  and `#2 "Fix the expired-session bug in auth" changed src/auth/session.ts#getCurrentUser (signature), which your change reads`.
  (If B's agent ran another tool before the commit, #2 was applied then with the `#2 "…" changed …` line, and the warning comes alone under `Pitstop:`.)
- **Live:** As it happens `for agent-b: "Show last-seen on the profile page" by <teammate> waits for <owner>: write skew, #2 changed src/auth/session.ts#getCurrentUser (signature) (pk_…)`;
  the `Conflicts` tab gets the badge `1`. The log still has two entries: a held commit is not an entry.
- **Say:** "Git would have merged this: different files. The app would have crashed on the profile
  page. Pitstop held it, and a person on the team decides."
- **If it fails:** see "The commit is not held".

If B's agent commits again while it waits, the tool answers `Commit rejected (constraint_failed): your commit "Show last-seen on the profile page" (pk_…) is waiting for this repository's resolver; you will be told at a safe point whether it landed or what to change.` and nothing more. Should it keep trying anyway, type on B: `Wait: the resolver decides. Do not commit until Pitstop tells you.`

### 5:00 The owner decides on the Conflicts tab

On the projector, open `Conflicts`. The card:

- the intent `Show last-seen on the profile page`, the badge `Waiting for a decision`, `agent-b`,
  `for <teammate>`, the `pk_…` id;
- the box `Write skew: something it relied on changed underneath it`: "Entry **#2** changed the
  signature of `getCurrentUser` in `src/auth/session.ts`." and "This commit's agent read that code
  before the change landed (the log was at #2 when it tried to land), so its files may still rely on
  the old version. Git would have merged it without a word.";
- `1 file`, `src/pages/ProfilePage.ts`, expandable.

Type in `Note for its author (sent with Send back)`: `guard the null user before reading
lastSeenAt`, then press `Send back with a note`.

- **Owner's screen:** toast `"Show last-seen on the profile page" went back to <teammate>; their agent adapts and commits again.`; the card now reads `Sent back by <owner>` with the note.
- **Live:** `for agent-b: <owner> sent "Show last-seen on the profile page" (pk_…) back: guard the null user before reading lastSeenAt. Re-read what changed (#2 changed src/auth/session.ts#getCurrentUser (signature)), adapt your change, and commit again.`
- **Say:** "The resolver is a teammate, not a model. The final word on a semantic conflict belongs to
  the team."
- **Do not press `Let it through` on stage.** It lands B's page as it was, as #3, with the badges
  `repaired` and `write skew` and the line `repaired against #2 (semantic): write skew accepted as is
  by <owner>`, and that page does not type-check against #2.

### 5:30 Laptop B adapts and lands

The note reaches B's agent only at its next tool call. If B's agent is idle, type on B:
`Check the pitstop status tool.`

- **B's screen:** the hook's note `warning: <owner> sent "Show last-seen on the profile page" (pk_…) back: guard the null user …`. The agent runs `tsc` (it now fails where the page reads `lastSeenAt`: `'me' is possibly 'null'`, with whatever name the agent gave the result of `getCurrentUser()`, or `Object is possibly 'null'` if it calls `getCurrentUser().lastSeenAt` inline), adds the guard, re-runs the checks and commits.
- **B's screen, the commit:** `Committed as #3 "Show last-seen on the profile page" (1 file); main moved to it.`
- **Live:** `head #3`, the `#3` row on top, no repair badge; As it happens, newest first: `agent-b's intent committed: …` and `#3 landed: "Show last-seen on the profile page" by agent-b, 1 file`. Click the row: reads include `getCurrentUser` and `timeAgo`.
- **Say:** "The agent read the note and fixed it. No human edited code."
- **If it fails:** held again for the same skew: that refusal is a new `pk_…` card on `Conflicts`,
  and while it waits every commit from B is refused as waiting. The same skew again means #2 is not
  applied in B's checkout (`.pitstop/state.json` shows `"appliedLsn": 1`): tell the agent to call
  `status`, whose hook applies it, and check the file now shows `"appliedLsn": 2` (still 1: the
  apply failed, see `.pitstop/daemon.log`). Then send the new card back and tell the agent to commit
  again. Type errors it cannot fix: paste the guard,
  ``const seen = me ? `\n<p>Last seen ${timeAgo(me.lastSeenAt)}</p>` : "";``.

### 6:30 Laptop A receives it

Type on A: `Call the pitstop status tool, then run npx vitest run.`

- **A's screen:** the status result `C:\code\teamdb is at #2 (head #3), 1 pending (applied at your
  next safe point); no open intent of yours.` (entries land between tool calls, so the status call
  comes first). The hook then applies #3 without printing anything: it writes only when it has a
  note, and #3 touches nothing A is editing. Then the tests run green with B's profile line
  included. If #3 landed more than ten minutes after A's last tool call, A's daemon applied it on
  arrival, and the status says `is at #3 (head #3), nothing pending`.
- **Live:** Who's here shows both at `applied #3 of #3`.
- **Say:** "Both checkouts hold the same tree, through the log, never through a merge."

### 7:00 The brain: an architecture decision

On the projector, `Brain` tab, `Propose a decision`:
- Title `Pages never import models`
- Decision `Pages get their data through the session layer or a service, never by importing src/models.`
- Why `One place owns how users are loaded.`
- Rule: `Files may not import`, files `src/pages/**`, module `src/models/**`. Both boxes must be
  filled, or the rule is dropped and the ADR is text only.

`Propose`: toast `ADR-1 proposed: an owner accepts it to put it in force`. Then `Accept` on the card:
toast `ADR-1 accepted: brain v1`; the tab badge becomes `v1`; As it happens
`ADR-1 accepted: Pages never import models (brain v1)`.

- **Each agent,** at its next tool call: `brain v1: ADR-1 accepted: Pages never import models: Pages get their data … Rules: forbid_import src/pages/** -> src/models/**.`
- **Re-check now** (look at `src/pages/ProfilePage.ts` at head first: the result depends on whether
  B's page still imports `findUser`): `N files at #3 checked against brain v1.`, a violation
  `ADR-1 Pages never import models` / `src/pages/ProfilePage.ts:N` / `imports src/models/user.ts` (N is the line of the `findUser` import in B's page at head: `2` when B added its `getCurrentUser` import above it, as the gate scripts do; `1` when B put it below),
  and queue lines like `#1 "import teamdb" by agent-a passed brain v0, before ADR-1: src/pages/ProfilePage.ts`.
  If B removed the import, it says `Everything at head follows the accepted rules.`
- **A refused commit.** An agent told about the ADR will avoid breaking it, so do this one by hand
  in a terminal in checkout A: add `import { findUser } from "../models/user.js";` as line 2 of
  `src/pages/HomePage.ts`, then `pitstop commit -m "Home page reads the user model"`:
  ```
  [pitstop] symbols: 0 written (0 signatures), 0 read
  [pitstop] commit rejected (constraint_failed): refused by this repository's architecture decisions (brain v1):
  ADR-1 "Pages never import models": src/pages/HomePage.ts:2 imports src/models/user.ts, which the rule forbid_import src/pages/** -> src/models/** forbids. Do instead: Pages get their data through the session layer or a service, never by importing src/models.
  Change those lines to follow the decision and commit again.
  ```
  Then remove the line again. An ADR refusal goes only to the committer: narrate it from the
  terminal; nothing appears on the Live tab.
- **Say:** "A CHECK constraint for architecture, versioned like a schema: every entry records the
  brain version it passed, and Re-check finds the older code that breaks the new rule."

### 9:00 The brain: a lease

Type on A:

> Declare an intent to make sessions expire after 30 minutes, symbol src/auth/session.ts#getCurrentUser, and take a pitstop lease on that symbol with the reason "changing session expiry".

- **A's screen:** the intent, then `Lease taken: src/auth/session.ts#getCurrentUser is yours until HH:MMZ. Other agents' commits that write it are refused until you commit (which releases it) or it expires; your daemon renews it while your intent is open.`
- **Live:** `agent-a leased src/auth/session.ts#getCurrentUser: changing session expiry`; the Brain tab's Leases card lists it with a `Release` button.

Then type on B:

> Declare an intent to make getCurrentUser refresh lastSeenAt, symbol src/auth/session.ts#getCurrentUser.

- **B's screen,** in the declare answer: `Leased by another agent (your commit writing it is refused until it is released or expires): src/auth/session.ts#getCurrentUser leased to agent-a (<owner>) until HH:MMZ: changing session expiry.` B's agent usually stops there and says it will wait. Asked to take the lease itself, it gets `Lease refused: src/auth/session.ts#getCurrentUser is leased to agent-a (<owner>) for intent int_… until …: changing session expiry. Leave that symbol alone (a commit writing it is refused) or wait until the lease ends.`
- **Say:** "A lease has exactly one winner, granted in one Postgres transaction. Presence is a CRDT
  because it never needs one."
- **End it:** type on A `Make that change and commit it with the pitstop commit tool.` The commit closes the intent and releases the lease: Live `agent-a released src/auth/session.ts#getCurrentUser`. A commit with nothing changed fails (`nothing to commit: @ has no changes against main`), and the lease stays. Or press `Release` on the Brain tab: toast `src/auth/session.ts#getCurrentUser released`, and the same Live line.

## The three-minute version

Do the steps from 0:00 through "1:00 to 4:00" before the talk and stop before "4:00 Laptop A commits" (add `When tsc and vitest pass, stop and tell me; do not commit until I say so.` to A's prompt too, or A commits on its own). Also fill in the ADR from 7:00 on the Brain tab and press `Propose`, not `Accept`. Then both agents have declared, edited and passed their checks
and B is waiting for the word. On stage, with the Live tab on the projector:

| | Who | Do | Expect |
| --- | --- | --- | --- |
| 0:00 | A | `Commit it with the pitstop commit tool.` | `Committed as #2 …`; Live `#2`, badge `1 signature` |
| 0:20 | B | `Commit now with the pitstop commit tool.` | held: `… your commit waits as pk_… Do not commit this change again …`; Live `for agent-b: … waits for <owner> …`; Conflicts badge `1` |
| 0:50 | owner | Conflicts tab: note `guard the null user before reading lastSeenAt`, `Send back with a note` | card `Sent back by <owner>`; Live `for agent-b: <owner> sent … back: …` |
| 1:10 | B | `Check the pitstop status tool.` (if idle) | the note; the agent guards the null and commits: `Committed as #3 …` |
| 2:20 | owner | Brain tab: accept the prepared ADR, `Re-check now` | `brain v1`; `src/pages/ProfilePage.ts:2` (the line of B's `findUser` import; `:1` if B added its imports below it, none if B dropped it) |
| 2:45 | | the numbers | |

## If it fails

**The commit is not held** (B's commit lands as #3, or B gets the plain `Re-read those files at head
#2 …` refusal and the Conflicts tab stays empty). Someone other than B's committer must be able to
decide: check the Members tab. The owner's row should carry `resolver`, and B must be signed in as the
teammate, not as the owner. If the only resolver is the teammate, B's skew goes back to agent B; the
Live tab then says `"…" by <teammate> went back to agent-b to adapt: write skew, …`, and the story
becomes "the agent adapts on its own", which is also fine to narrate.

**B declared its intent after #2 was applied on B** (then B's reads are checked from #2): the commit
lands with no skew. Keep the "do not commit until I say so" sentence and the order: A commits only
once B waits.

**B lands first** (B committed before A, so B is #2, clean). The skew then hits A, whose router
change reads `renderProfile`. A is the owner and the only decider, so A's commit is not held: A gets
the plain escalation, adapts and commits again. Narrate it mirrored rather than resetting.

**The note never arrives on B.** Notes and warnings reach an agent only at its next tool call. Type
anything on B that makes it call a tool (`Check the pitstop status tool.`).

**Both agents have the same name**: both prompts carried the same `Agent name`, or one was copied
before the field existed (then setup's default, `<os user>-claude`). Run setup again in the
checkout with `--agent agent-b` (it needs the token again: `--token` or `PITSTOP_TOKEN`); it
restarts the daemon (`stopped the daemon (pid N) to start it with the new settings`). With the
same name, each agent also receives the other's warnings.

**The lease holder is told its own lease is another agent's** (`lease: agent-a (<owner>) holds …;
a commit of yours that changes it is refused until then`): that laptop's client is older than
0.1.6 (`pitstop version`), which compared leases with the OS user name. Reinstall it
(`npm install -g $S/pitstop-cli.tgz`), then `pitstop stop` and `pitstop start` in the checkout;
`.pitstop/daemon.log` then says `as agent-a (<owner>)`. The lease still blocks B meanwhile; it is
just not renewed.

**Setup refuses laptop A's folder** (`… has changes that are not committed to main …`, then the files): something changed after `reset.sh`. Run
`reset.sh` again. Setup also refuses a folder already set up for another repository: use a fresh
`reset.sh` folder per take.

**Setup cannot read the repository** (`… has no repository <id> that this token can read: check the
name, and that the repository's owner has added your GitHub login as a member …`): B is not a member
yet, or the repository name on the setup line is wrong. A prompt from an older take does not stop here. With its token revoked, setup says `… answered 401 for <owner>/teamdb-take1: check the token; with accounts on, the repository's owner adds you as a member.`. With a live token, it sets up that older repository: it reuses the old folder if it is still there (`… is already a checkout of <owner>/teamdb-take1`), and clones it otherwise. Check that setup's `ready:` line names this take's repository.

**The Resolver switch is greyed out:** the teammate's row is still an invite. They sign in once; the
owner reloads the Members tab (it does not refresh on its own).

**Claude Code does not show the pitstop tools:** `/mcp` in the session. Setup pre-approves the
project's MCP server and the pitstop tools in `.claude/settings.local.json`; if the repository
already tracks a `.mcp.json`, setup prints a `claude mcp add --scope local pitstop -- …` line to run
once.

**A daemon stopped applying** (`.pitstop/daemon.log` ends with `apply failed, stopped at #N: …` or
`gave up, stopped at #N: …`). The process is still alive and its local API still answers, so neither
opening Claude Code nor `pitstop start` replaces it (`pitstop start` prints `daemon already running
in …`): run `pitstop stop`, then `pitstop start`, in the checkout. **No daemon at all** (the tools
say so): opening Claude Code in the checkout starts one, and so does the next pitstop tool call. A
new daemon resubscribes from its last applied entry.

**jj problems:** "The system cannot find the path specified" from `jj git init` is the long-path
bug; keep checkouts short (`C:\code\…`). `jj` not found: open a new terminal after installing it.

**The Live tab looks stale:** `offline` pill: it reconnects every 2 s. `no access`: the signed-in
person cannot read this repository. Ages in the log do not tick on their own (they move when an entry lands or one is clicked); the ages under Open intents redraw every 5 s. Do not
reload mid-run.

**The server is down** (`$S/healthz` does not answer): the resolver beat needs the hosted server,
since a local server has no GitHub sign-in and therefore no members. Switch to the offline story
below.

## Offline: the gates

These need no GitHub accounts and no website sign-in. gate1 and gate4 start their own server on this laptop. rehearse.sh uses the hosted server unless `PITSTOP_SERVER` names another one. When the hosted server is down, it stops and prints the command for a local in-memory server on port 8097. Its Claude Code sessions need the internet in any case. All three run `reset.sh`, whose `npm install` needs the npm registry or the packages already in npm's cache. They use the shared
token or an open server, so their repositories have no members and the skew always goes back to the
agent (the plain escalation); nothing waits on a Conflicts tab.

- `bash demo/scripts/gate4.sh ~/g4`: the whole story on one laptop in about ninety seconds, against
  a local server on port 8098, driven by the CLI instead of agents. Open `http://127.0.0.1:8098/#/r/teamdb/demo` once it prints `== beat 3` (the bare `/` shows only the landing on this open server; opened earlier, before `init` has made teamdb/demo, the pill says `no access` and never retries, so reload it), while
  it runs for the live view. It ends `A and B are identical: Phase 4 gate PASSED (write skew caught,
  the agent repaired it)`.
- `bash demo/scripts/rehearse.sh A ~/pitstop-A` and `… B ~/pitstop-B`: two checkouts with real
  Claude Code sessions, against the hosted server with the administrator's shared `PITSTOP_TOKEN`
  from the repo-root `.env` (`PITSTOP_REPO=teamdb/take-N` for a fresh name), or a local one with
  `PITSTOP_SERVER=…`. Its repository is visible only to the shared token, which the website on a
  sign-in server does not take, so show the agents' screens rather than the website.
- `bash demo/scripts/gate1.sh`: the Phase 1 gate (two replicas stay identical), port 8097.

## Known issues, worth fixing before the day

- ADR and lease refusals reach only the committer; the Live tab shows write skew but not those.
- After `Let it through`, B's Who's here row keeps its old intent until B declares or commits again.
- The import's intent is `import <folder name>`; setup takes no message for it.
