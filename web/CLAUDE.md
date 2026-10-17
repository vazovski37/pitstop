# web/ — live view

Owner: **Vazovski** (moved from the teammate in the build plan, Phase 5). Teammate's Claude does not edit this folder.

## What it shows (the screen judges look at during the demo)
- The log, newest first: LSN, agent, intent, files, checks; repairs highlighted, with the repair's summary under the entry.
- Open intents: agent, text, declared symbols, base LSN, last heartbeat.
- "As it happens": entries landing, repairs, write skew the validator reported, warnings between agents, intents opening and closing.
- Click an entry for its files, read/write/signature sets, repairs and check details.

## How it is built
No framework and no bundler: `public/index.html` + `public/style.css`, and `src/app.ts` compiled by `tsc` to one ES module (`npm run build` → `dist/`). It imports only *types* from `@pitstop/protocol`, so nothing from `node_modules` reaches the browser. The server serves `dist/` at `/` (`server/src/app.ts`, `webDir`; `server/src/index.ts` finds it at `web/dist` or `PITSTOP_WEB_DIR`), so the page is same-origin with the API: the session cookie from sign in with GitHub just works, and a shared-token server takes the token from the page's field (kept in `localStorage`, sent as `Authorization: Bearer` and as `?token=` on the stream).

Data: `GET /version`, `GET /me`, `GET /repos`, then one WebSocket to `/stream` subscribed from LSN 0, which replays the whole log and then stays live (`head`, `entry`, `intent`, `warning`). Switching repositories reconnects; a dropped socket reconnects from the last LSN seen. The Dockerfile builds this workspace into the server image.

## Rules
- Read-only client of the server's `/stream` and query API. It never writes.
- Message shapes come from `@pitstop/protocol` (type imports only).
- Deployed by CI like the server; never from a laptop.
- `npm run typecheck` covers it (the root script builds the protocol first).

## Not yet
Each worktree's applied LSN against head: daemons heartbeat it on the stream, but the server does not expose it to a query yet.
