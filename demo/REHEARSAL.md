# The rehearsal

The run sheet for the demo: two laptops, two coding agents, one Pitstop server on Azure, and the
write skew from `scenario.md` caught live. `scripts/gate4.sh` is the same story automated on one
laptop; this file is the story with people at the keyboards. Everything quoted below (terminal
lines, the agent's tool results, the page) is what the daemons, the hook and the live view printed
when the sheet was run on 2026-10-18 against a local in-memory server, so it is what to expect.

Who is who:

| | Laptop A | Laptop B |
| --- | --- | --- |
| Person | Vazovski | the teammate |
| Agent name in the log | `agent-a` | `agent-b` |
| Task | fix the expired-session bug (issue #58) | show last-seen on the profile page (issue #61) |
| Work dir | `~/pitstop-A` | `~/pitstop-B` |

The server: `https://bravebay-485f06a6.swedencentral.azurecontainerapps.io`. Its live view is the
root URL; its log is `GET /log?repo=teamdb/demo` with the shared token. Below, `$S` stands for the
server URL and `$T` for the token.

## Before the day, once per laptop

1. The pitstop repo at `main`, built: `git pull && npm install && npm run build`.
2. `jj` installed (`winget install jj-vcs.jj`; the script finds it even when it is not on PATH),
   `git`, `node` 22+, `curl`, and Claude Code (`claude`) on PATH. Git Bash on Windows.
3. The repo-root `.env` holds `PITSTOP_TOKEN=<the shared token>` (SETUP.md, "Server token").
   Never commit it, never paste it in a prompt. `rehearse.sh` reads it from there.
4. The browser: open `$S/`, paste the token in the "server token" field at the top right, press
   "use". The page keeps it in localStorage, so this is once. Pick `teamdb/demo` in the
   "repository" dropdown; the URL becomes `$S/#teamdb%2Fdemo`. Laptop A's browser is the one on the
   projector; laptop B's is a safety copy.
5. Three windows per laptop: a terminal for the reset script and the daemon log, a terminal for
   Claude Code, the browser with the live view.
6. Run the whole sheet once end to end with the two laptops a day before. A used repository name
   cannot be reset (the log is append-only), so each take gets its own: `teamdb/demo` for the real
   thing, `teamdb/take-1`, `teamdb/take-2` for the rehearsals, the same name on both laptops.

## Reset: both laptops, about a minute

Laptop A, then laptop B:

```bash
bash demo/scripts/rehearse.sh A ~/pitstop-A
```

```bash
bash demo/scripts/rehearse.sh B ~/pitstop-B
```

What it does, in order: checks `$S/healthz` and that the token is accepted; checks that the
repository is at the start state (A: not there or empty; B: the import alone), and refuses with
the fresh-name hint otherwise; builds the protocol, the daemon and the agent side; stops the daemon
from the previous take and replaces the work dir with a fresh copy of the slice (`reset.sh`: git +
jj, dependencies, typecheck and tests green); `pitstop init $S --repo teamdb/demo` (A imports the
slice as entry #1; B passes `--no-import` and only joins); writes `.mcp.json`,
`.claude/settings.json` (the pitstop MCP tools and the safe-point hook), `CLAUDE.md` (house rules
for the agent: declare an intent first, commit with the tool, obey a rejection) and `.env`
(`PITSTOP_AGENT`, `PITSTOP_DEVELOPER`, server and repository, not the token) into the work dir,
all of them excluded from jj so the agent's commit never carries them; starts the daemon in the
background with its log at `.pitstop/daemon.log`, and waits for it to be watching (B: to have
applied #1).

The last lines on A:

```
ready: laptop A is agent-a (vazovski) in /c/Users/you/pitstop-A at #1, on https://… (teamdb/demo)
  daemon: pid 11320, log /c/Users/you/pitstop-A/.pitstop/daemon.log
  stop it: node -e "process.kill(require(process.argv[1]).pid)" /c/Users/you/pitstop-A/.pitstop/daemon.json
  next: cd /c/Users/you/pitstop-A && claude      (the pitstop tools and the safe-point hook are configured there)
  live view: https://…/#teamdb%2Fdemo
```

Timing: A took 44 s on the first run of the day and 27 s after that (npm's cache is warm); B the
same. The first take needs no name; every later take on the same server:

```bash
PITSTOP_REPO=teamdb/take-2 bash demo/scripts/rehearse.sh A ~/pitstop-A
```

A different server: `PITSTOP_SERVER=http://127.0.0.1:8097 bash demo/scripts/rehearse.sh A ~/pitstop-A`
(see "If the server is down"). `--foreground` keeps the daemon in the terminal instead
(ctrl-c stops it), handy when its log should be on screen.

After the reset:

| Where | What it shows |
| --- | --- |
| Daemon log, A | `watching C:\…\pitstop-A from #1 on https://… (teamdb/demo); local API on 127.0.0.1:<port>` |
| Daemon log, B | `watching C:\…\pitstop-B from #0 …` then `applied #1 import pitstop-A` |
| `GET /log?repo=teamdb/demo` | one entry: `#1 "import pitstop-A"` by `agent-a`, base #0, 14 files, empty symbol sets |
| Live view | `head #1`, pill `live`, Log "1 entry" (`#1 import pitstop-A agent-a 14 files base #0`), Open intents "None open.", As it happens `replayed 1 entry up to #1` |

Keep a second pair of work dirs ready (`~/pitstop-A2`, `~/pitstop-B2` on `teamdb/take-9`, reset
in the morning) so a failed take costs the time to switch terminals, not a minute of silence.

## The ten-minute version

Times are from the first prompt. Agent time is the uncertain part: Claude Code took two to four
minutes per task in rehearsal, so the clock below assumes three.

### 0:00 Open the agents (both laptops)

Type, on each laptop, in the second terminal:

```bash
cd ~/pitstop-A && claude
```

(`~/pitstop-B` on B.) Claude Code asks whether to trust the folder and whether to use the project's
MCP server from `.mcp.json`: yes to both. `/mcp` lists `pitstop` with five tools (`declare_intent`,
`commit`, `why`, `callers`, `status`). Then, on A, type:

> Call the pitstop status tool.

- **A's screen:** `C:\Users\you\pitstop-A is at #1 (head #1), nothing pending; no open intent of yours.`
- **Live view:** unchanged. **Log:** unchanged.
- **If it fails:** no `pitstop` under `/mcp`: start Claude Code with the config named,
  `claude --mcp-config .mcp.json`. "no daemon" in the tool result: the daemon is not running in
  this work dir; see "If a daemon died".

### 0:30 Laptop A gets its task

Type on A, the prompt from `scenario.md`:

> Fix the expired-session bug in auth (issue #58): getCurrentUser must not return a user whose
> session has expired. Return null in that case instead of throwing, and make the callers handle
> it. Turn the todo test into a real one.

The house rules in the work dir's `CLAUDE.md` make the agent declare its intent first.

- **A's screen:** the `declare_intent` call, answered
  `Intent int_… is open at #1: "Fix the expired-session bug in auth". Declared: src/auth/session.ts#getCurrentUser. Use the commit tool when the work is done.`
  Then it reads `src/auth/session.ts`, `src/router.ts`, the tests, and starts editing.
- **Daemon log, both laptops:** `agent-a started: Fix the expired-session bug in auth`.
- **Live view:** Open intents 1: `agent-a Fix the expired-session bug in auth`, its symbol, `from #1`.
  As it happens: `agent-a intends: "Fix the expired-session bug in auth"`.
- **Log:** unchanged (intents are not entries).
- **Timing:** the intent is open within 10 s of the prompt.
- **If it fails:** the agent edits without declaring: type
  `Declare your intent with the pitstop declare_intent tool first, symbols src/auth/session.ts#getCurrentUser.`

### 0:45 Laptop B gets its task

Type on B, the prompt from `scenario.md` plus one sentence that keeps the commit in your hands:

> Show when the user was last seen on the profile page (issue #61), like 'Last seen 3 hours ago'.
> Keep the router as it is; the page can ask the session layer for the current user. When tsc and
> vitest pass, stop and tell me; do not commit until I say so.

- **B's screen:** `Intent int_… is open at #1: "Show last-seen on the profile page". Declared: src/pages/ProfilePage.ts#renderProfile, src/auth/session.ts#getCurrentUser. …`
  After its next tool call, the hook delivers the early warning as context:
  `Pitstop:` / `warning: agent-a is already working on src/auth/session.ts#getCurrentUser (intent: Fix the expired-session bug in auth); expect a conflict unless you coordinate`.
  The agent usually mentions it and carries on.
- **A's screen,** at A's next tool call: `warning: agent-b just started on src/auth/session.ts#getCurrentUser (intent: Show last-seen on the profile page)`.
- **Daemon logs:** `agent-b started: …`, then the two `warning for …` lines.
- **Live view:** Open intents 2. As it happens, newest first:
  `for agent-a: agent-b just started on src/auth/session.ts#getCurrentUser (…)`,
  `for agent-b: agent-a is already working on src/auth/session.ts#getCurrentUser (…); expect a conflict unless you coordinate`
  (both orange), `agent-b intends: "Show last-seen on the profile page"`.
- **Say:** "Pitstop saw the overlap before either agent wrote a line."
- **If it fails:** B's agent stops to ask whether to go on: `Go ahead; A's change is small, you will be told what it did.`
  No warning on B: the declared symbols must include `src/auth/session.ts#getCurrentUser`; tell the
  agent to declare again with it.

### 1:00 to 4:00 Both agents work

Nothing to type. A edits `src/auth/session.ts` (`getCurrentUser` returns `SessionUser | null`),
`src/router.ts` (redirect to `/login`), `src/pages/HomePage.ts`, the two test files, and runs
`npx tsc -p tsconfig.json --noEmit` and `npx vitest run`. B edits `src/pages/ProfilePage.ts` to call
`getCurrentUser()` and `timeAgo`, runs the same checks, and stops: "tests pass, ready to commit".

- **Live view:** nothing new; the two intents' "ago" ticks (the daemons heartbeat them).
- **Say:** what the log is (every change with its intent, its read set and its write set) and what
  the daemon is (a replica that applies entries only between the agent's tool calls).
- **If it fails:** B finishes long before A: fine, it waits. A finishes first and commits on its
  own: fine too, that is the next step. B commits on its own before A: see "B lands first" below.

### 4:00 Laptop A commits

A's house rules say to commit once the checks pass; when it asks instead, type on A:

> Commit it with the pitstop commit tool.

- **A's screen:** `Committed as #2 "Fix the expired-session bug in auth" (5 files); main moved to it.`
- **Daemon log, A:** `symbols: 3 written (1 signatures), 10 read`, `accepted as #2; main moved to it`.
- **Daemon log, B:** nothing yet. B's agent is attached, so #2 waits for B's next safe point.
- **Log:** `#2` by `agent-a`, base #1, 5 files (`src/auth/session.ts`, `src/auth/session.test.ts`,
  `src/router.ts`, `src/router.test.ts`, `src/pages/HomePage.ts`); `sigWriteSet` is
  `["src/auth/session.ts#getCurrentUser"]`; `writeSet` adds `src/router.ts#handle` and
  `src/pages/HomePage.ts#renderHome`; `readSet` has 10 symbols.
- **Live view:** `head #2`; the `#2` row slides in at the top with the orange badge `1 signature`;
  As it happens: `#2 landed: "Fix the expired-session bug in auth" by agent-a, 5 files`. Click the
  row: "signatures: src/auth/session.ts#getCurrentUser".
- **Say:** "That badge is the point: a public signature changed. B read that symbol ten seconds
  ago and does not know."
- **Timing:** the commit tool answers in about 2 s (the daemon computes the symbol sets).
- **If it fails:** `Commit rejected (constraint_failed)`: someone else changed the same files;
  only possible if B landed first (below). `nothing to commit`: the agent did not save its edits;
  tell it to check `git status` and try again.

### 4:30 Laptop B commits, and is refused

Type on B:

> Commit now with the pitstop commit tool.

The commit tool runs before B's hook has applied #2, so B's files are still at #1: the server sees
that B read `getCurrentUser` and that #2 changed its signature in between.

- **B's screen,** the tool result:
  `Commit rejected (escalated): write skew: #2 changed src/auth/session.ts#getCurrentUser (signature). Changed by: #2 "Fix the expired-session bug in auth" (src/auth/session.test.ts, src/auth/session.ts, src/pages/HomePage.ts, src/router.test.ts, src/router.ts). Re-read those files at head #2, adapt your change to them, and commit again with baseLsn 2. Conflicts with #2. Re-read what changed, adapt your change to it, and commit again.`
  Right after it, the hook (B's next safe point) applies #2 and adds:
  `Pitstop applied #2 to this worktree.` / `#2 "Fix the expired-session bug in auth" changed src/auth/session.ts#getCurrentUser (signature), which your change reads`.
- **Daemon log, B:** `symbols: 1 written (0 signatures), 5 read`,
  `reads are checked from #2 from now on: the server named what to re-read`, then
  `applied #2 Fix the expired-session bug in auth`. The rejection text itself goes to the agent,
  not to the log.
- **Log:** unchanged, still two entries. A refused commit is not an entry.
- **Live view:** unchanged. In `PITSTOP_REPAIR=agent` mode (what Azure runs) the refusal goes to
  the agent only; nothing crosses the stream. Narrate it from B's screen, or show B's terminal.
- **Say:** "Git would have merged this: different files. The app would have crashed on the profile
  page. Pitstop refused it, named the symbol, and told the agent what to re-read."
- **Timing:** immediate.
- **If it fails:** the commit is accepted as `#3` without a refusal: the server is not running
  with a resolver (`PITSTOP_REPAIR=agent`) but with `PITSTOP_VALIDATE=warn`; then the live view
  shows a `write skew` badge on #3 and the event `#3 write skew, not repaired (…)`, and the story
  becomes "flagged, not blocked". With `PITSTOP_REPAIR=groq` the server repairs it itself: #3 lands
  with the `repaired` badge and `repaired against #2 (semantic): …` under the row, and B is told
  `The server repaired it: …`. Both are fine stories; say which one you got.

### 5:00 Laptop B adapts and lands

Most of the time the agent reads the rejection and the note, runs `tsc` (it now fails with
`src/pages/ProfilePage.ts(10,79): error TS18047: 'me' is possibly 'null'.`), adds the guard,
re-runs the checks and commits without being asked. If it waits, type on B:

> Do what the rejection says, then commit again.

- **B's screen:** `Committed as #3 "Show last-seen on the profile page" (1 file); main moved to it.`
- **Daemon log, B:** `symbols: 1 written (0 signatures), 5 read`, `accepted as #3; main moved to it`.
- **Log:** `#3` by `agent-b`, base #2, 1 file; `writeSet` `src/pages/ProfilePage.ts#renderProfile`;
  `readSet` includes `src/auth/session.ts#getCurrentUser`, `src/auth/session.ts#SessionUser` and
  `src/utils/timeAgo.ts#timeAgo`; no repairs (the agent was the repairer).
- **Live view:** `head #3`, the `#3` row on top, `#3 landed: "Show last-seen on the profile page" by agent-b, 1 file`.
  Click it: "reads" lists `getCurrentUser` and `timeAgo`.
- **Say:** "Second attempt, checked from #2, lands. The log shows it read the new signature."
- **Timing:** one to two minutes of agent time.
- **If it fails:** rejected again with the same message: the daemon did not move the read base
  (`.pitstop/state.json` should say `"readBaseLsn": 2`); tell the agent to call `status`, then
  commit again. Type errors it cannot fix: paste the guard,
  `const seen = me ? \`\n<p>Last seen ${timeAgo(me.lastSeenAt)}</p>\` : "";`.

### 6:30 Laptop A receives it

A's daemon holds #3 until A's agent's next tool call (that is the safe-point rule). Type on A:

> Run npx vitest run.

- **A's screen:** the tests pass, with B's profile line included; the hook prints nothing (nothing
  touched A's work).
- **Daemon log, A:** `applied #3 Show last-seen on the profile page`.
- **Say:** "Both laptops now hold the same tree, through the log, never through a merge."

### 7:00 Close

On B, in a third terminal:

```bash
cd ~/pitstop-B && npx vitest run
```

Green, with `sends an expired session to the login page` among them: the profile page for an
expired session redirects instead of crashing. Then the log as data:

```bash
curl -s -H "authorization: Bearer $T" "$S/log?repo=teamdb/demo" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s))console.log(`#${e.lsn} ${e.intent} by ${e.author.agent} (base #${e.baseLsn}; ${e.files.length} files; signatures ${e.sigWriteSet.join(",")||"-"}; reads ${e.readSet.length}; repairs ${e.repairs.length})`)})'
```

```
#1 import pitstop-A by agent-a (base #0; 14 files; signatures -; reads 0; repairs 0)
#2 Fix the expired-session bug in auth by agent-a (base #1; 5 files; signatures src/auth/session.ts#getCurrentUser; reads 10; repairs 0)
#3 Show last-seen on the profile page by agent-b (base #2; 1 files; signatures -; reads 5; repairs 0)
```

On the live view, reload the page (F5) if the Open intents panel still lists the two intents: the
server closed them at the commits, but the page only learns that on reload.

## The three-minute version

The same story with the agent time taken out: do steps 0:00 to 4:00 before the talk, so both agents
have declared, edited and passed their checks and B is waiting for the word. On stage, with the
live view already on the projector:

| | Laptop | Type | Expect |
| --- | --- | --- | --- |
| 0:00 | A | `Commit it with the pitstop commit tool.` | `Committed as #2 …`; live view `#2`, badge `1 signature` |
| 0:20 | B | `Commit now with the pitstop commit tool.` | `Commit rejected (escalated): write skew: #2 changed src/auth/session.ts#getCurrentUser (signature) …`; then `Pitstop applied #2 …` |
| 0:40 | B | (nothing, or `Do what the rejection says, then commit again.`) | `Committed as #3 …`; live view `#3` on top |
| 2:00 | A | `Run npx vitest run.` | green; daemon log `applied #3` |
| 2:30 | B | the `curl` from "Close" | the three entries |

Point at the live view's As it happens list while B's agent works: the two intents, the two orange
warnings, `#2 landed`, `#3 landed`, newest first, with times.

If the prepared state was lost (a laptop restarted, an agent session gone): the agents' edits are
exactly the files `scripts/gate4.sh` writes in its beat 4 and beat 5 heredocs; paste them into the
work dirs, run `pitstop intent` from `.env` (`set -a; . ./.env; set +a; node <pitstop>/daemon/dist/index.js intent -m "…" -s …`)
and drive the commits with `node <pitstop>/daemon/dist/index.js commit -m "…"` instead of the agents.
The refusal, the notes (`node <pitstop>/mcp/dist/hook.js </dev/null` prints them) and the log are
identical; only the "agent reads and adapts" minute is yours.

Ninety seconds, one laptop, no network: `bash demo/scripts/gate4.sh ~/g4` runs every beat against a
local server on port 8098 and prints each as it passes; open `http://127.0.0.1:8098/#teamdb%2Fdemo`
while it runs (no token there) for the live view.

## If it fails

**The server is down** (`rehearse.sh` says "the server does not answer", or the live view pill stays
`offline`). Check `$S/healthz` once in the browser; the Container App can take 30 s to wake. If it
stays down, run the server on laptop A with the in-memory store and the same token, so nothing else
changes:

```bash
PITSTOP_STORE=memory PITSTOP_REPAIR=agent PITSTOP_TOKEN="$T" PORT=8097 npx tsx server/src/index.ts
```

It serves the live view at `http://127.0.0.1:8097/` when `web/dist` exists (`npm run build` made
it). Laptop B reaches it as `http://<A's address>:8097` (the server listens on every interface;
Windows asks once to allow node through the firewall; `ipconfig` on A for the address). Then on
both laptops `PITSTOP_SERVER=http://<address>:8097 bash demo/scripts/rehearse.sh …`. If the laptops
cannot see each other, run both work dirs on A: `rehearse.sh B ~/pitstop-B` there too, and B's
person types on A's second Claude Code. Nothing is persisted: a restart of that server is a fresh
log, which for a demo is a feature.

**The token is refused** (`the server answered 401 to GET /repos with this token`): `.env`'s
`PITSTOP_TOKEN` is not the GitHub secret the server was provisioned with. Fix `.env`; nothing else
caches it (the work dir's `.pitstop/config.json` is rewritten by the next reset).

**"already has N entries and the log is append-only":** that name was used. `PITSTOP_REPO=teamdb/take-3`
on both laptops; pick `teamdb/take-3` in the live view's dropdown.

**"cannot replace … something still runs in it":** Claude Code, its MCP server or a shell is still
inside the work dir. Close them (`/exit` in Claude Code), run again.

**A daemon died** (`.pitstop/daemon.log` ends with `stopped at #N: …`, or the tools answer "no
daemon"). Restart it in the work dir; the server, token and repository are in
`.pitstop/config.json`, the agent name in `.env`:

```bash
cd ~/pitstop-A && set -a && . ./.env && set +a && node <pitstop>/daemon/dist/index.js daemon
```

It resubscribes from the LSN in `.pitstop/state.json` and applies what it missed. An entry that
failed to apply (jj conflict markers) is reported to the agent at its next safe point: let the agent
resolve, or `jj resolve --list` by hand.

**jj problems:** "The system cannot find the path specified" from `jj git init` is the long-path
bug; the work dir must be short (`~/pitstop-A` is). `jj` not found: the script looks under
WinGet's packages folder; otherwise `export PATH="<folder of jj.exe>:$PATH"` before running it.

**Claude Code does not show the pitstop tools:** `/mcp` in the session. The project server must be
approved on first use; `claude --mcp-config .mcp.json` forces it. The hook is in
`.claude/settings.json`; `/hooks` lists it. Neither needs the token.

**The agent refuses to go on after the warning,** or asks whether to coordinate: `Go ahead; A's
change is small, you will be told what it did.`

**B lands first** (B's agent committed before A, so B is `#2`, clean). The skew then hits A instead:
A's `router.ts` reads `renderProfile`, which #2 changed, so A's commit is refused with the same
kind of message naming `src/pages/ProfilePage.ts#renderProfile`, A's hook applies #2, A adapts
(usually nothing to change: the guard is in the router) and commits again. The story holds, mirrored;
narrate it that way rather than resetting. The "do not commit until I say so" sentence in B's prompt
is there to avoid this.

**The refusal never comes** and B's commit lands as #3 straight away: either the server runs without
a resolver (`write skew` badge on #3, event `#3 write skew, not repaired`), or B's intent was
declared after #2 had been applied on B (then B's reads were checked from #2 and were fine). Say
what the badge says; the type error B would have shipped is the same.

**The live view looks stale:** `offline` pill: it reconnects every 2 s; if the token field
reappears, the server restarted with another token. Open intents still listed after their commits:
reload (F5). Wrong repository: the dropdown, or the URL's `#owner%2Fname`.

**Everything at once:** the gate: `bash demo/scripts/gate4.sh ~/g4` on either laptop. It needs no
server, no token, no agent, and prints the whole story in ninety seconds.

## Seen in rehearsal, worth fixing before the day

- The refusal is invisible on the live view in `agent` mode: the server answers the daemon and
  broadcasts nothing. A `warning` of kind `dependency_changed` on escalation would put
  `for agent-b: write skew: #2 changed … (signature)` in As it happens, which is the moment the
  judges should see. (server/, Vazovski.)
- Intents stay in the Open intents panel after their commit until the page reloads: the store marks
  them `committed`, but no `intent` message with that status crosses the stream. (server/.)
- The import's intent reads `import pitstop-A` (the work dir's name); `pitstop init` has no `-m`.
  Cosmetic. (daemon/, teammate.)
