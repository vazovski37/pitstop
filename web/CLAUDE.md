# web/ — the website

Owner: **Vazovski** (since 18 October 2026, every folder is).

## Pages (hash routes)
- `#/` home: signed out, the pitch and "Sign in with GitHub"; signed in, your repositories (`GET /repos`) and "New repository" under your login (`POST /repos`).
- `#/r/<owner>/<name>` a repository: tabs **Live** (below), **Conflicts** (`/repos/:o/:n/parked`: commits waiting for the resolver, their write skew and files; a resolver lets one through or sends it back with a note), **Members** (`/repos/:o/:n/members`: roles, the resolver flag, invites by GitHub login that turn into membership at first sign-in, remove, leave) and **Set up Claude** (makes a personal token with `POST /tokens` and writes the prompt a developer pastes into Claude Code: install Node, git and jj, `npm install -g <server>/pitstop-cli.tgz`, `pitstop setup <server> <repo> --token …`). The administrator's shared token never goes into a prompt.
- `#/account` personal tokens (make, list, revoke) and sign out.
- On a server without accounts the header takes the shared token instead (kept in `localStorage`).

## The Live tab (the screen judges look at during the demo)
- The log, newest first: LSN, agent, intent, files, checks; repairs highlighted, with the repair's summary under the entry.
- Who's here (presence, design doc 9.5), above the open intents: one line per live worktree, the agent in its own colour (a hash of its name), its developer, working or idle, its intent, its files with unfinished edits as chips (a file two worktrees are both in is highlighted, with who else in its tooltip), its declared symbols, and `applied #N of #head`. Entries fade as they age and are hidden after two minutes without a write (`PRESENCE_TTL_MS`, the server's too) or once departed (a tombstone); redrawn every 2 s. "As it happens" says when an agent arrives or leaves.
- Open intents: agent, text, declared symbols, base LSN, last heartbeat.
- Worktrees: one line per connected daemon, `agent-b · applied #3 of #4`, a green mark at the head and a red one with the lag when behind. The name comes from the worktree's open intent; between tasks it is just "worktree".
- "As it happens": entries landing, repairs, write skew the validator reported, warnings between agents, intents opening and closing.
- Click an entry for its files, read/write/signature sets, repairs and check details.

## How it is built
No framework and no bundler: `public/index.html` + `public/style.css`, and `src/app.ts` compiled by `tsc` to one ES module (`npm run build` → `dist/`). It imports only *types* from `@pitstop/protocol`, so nothing from `node_modules` reaches the browser. The server serves `dist/` at `/` (`server/src/app.ts`, `webDir`; `server/src/index.ts` finds it at `web/dist` or `PITSTOP_WEB_DIR`), so the page is same-origin with the API: the session cookie from sign in with GitHub just works, and a shared-token server takes the token from the page's field (kept in `localStorage`, sent as `Authorization: Bearer` and as `?token=` on the stream).

Data: `GET /version`, `GET /me`, `GET /repos`, then one WebSocket to `/stream` subscribed from LSN 0, which replays the whole log and then stays live (`head`, `entry`, `intent`, `warning`, `presence`). Presence is a CRDT (`packages/protocol/src/presence.ts`): after subscribe the server sends the whole document, then each update, and the page merges them into its own copy with `applyPresence`, which `src/app.ts` repeats in a few lines because the page cannot import runtime code from the protocol (no bundler; a value import would pull zod in). Keep the two the same. Ages count from this browser's clock, or from the newest stamp seen when that is ahead. Switching repositories reconnects; a dropped socket reconnects from the last LSN seen. The worktrees are not on the stream: the page reads `GET /repos/:owner/:name/worktrees` (`WorktreesResponse` in `server/src/app.ts`, a server query rather than a protocol message) on `head`, after every live entry and every 3 s while the socket is up. The Dockerfile builds this workspace into the server image.

## Rules
- It writes only through the API, as the signed-in user (repositories, members, tokens); the session cookie authenticates it, so no token sits in the page except a shared one pasted on a server without accounts.
- Message shapes come from `@pitstop/protocol` (type imports only).
- Deployed by CI like the server; never from a laptop.
- `npm run typecheck` covers it (the root script builds the protocol first).

## Not yet
- A worktree's name while it has no open intent: the heartbeat carries only `appliedLsn` and `intentId`, so naming it needs a field in `@pitstop/protocol` (both owners).
- A daemon that connects already at the head shows up only after its first heartbeat (after an apply, or the 30 s interval in `daemon/src/stream.ts`).
