# Pitstop

Version control where the codebase is treated as a database: one server keeps an ordered log of every change, each developer's worktree is a live replica, each agent task is a transaction, and AI repairs semantic conflicts (write skew) before they land.

Full design: the technical design doc (written when the project was called Agent Git), a Claude doc. Sections are referenced by number in the folder `CLAUDE.md` files.

## Who owns what
| Folder | Owner |
| --- | --- |
| `packages/protocol` | Both, changed only together |
| `server/`, `infra/`, `.github/` | Vazovski |
| `daemon/`, `mcp/`, `web/`, `server/semantic/` | Teammate |
| `demo/` | Both |

**Rule for Claude:** edit only files in folders your developer owns. If a change is needed elsewhere, stop and describe it instead. Read the `CLAUDE.md` in a folder before editing it.

## Rules
- Every message between server and daemon is defined in `@pitstop/protocol`. Never redefine a shape locally.
- Before finishing any change: `npm run typecheck` and `npm test` pass.
- Plan first: for anything bigger than a small fix, write a short plan and wait for your developer to approve it.
- Never deploy from a laptop and never run `az` commands that change Azure resources. Deploys happen when `main` changes, through GitHub Actions.
- Never commit secrets. `.env` is git-ignored; use `.env.example` for new variables.

## Commands
- `npm install`: install all workspaces.
- `npm run db:up`: local Postgres with pgvector (Docker).
- `npm run dev:server`: server on http://localhost:8080 (`/healthz`, `/stream`).
- `npm test`: all tests. Migration tests run when `DATABASE_URL` is set.
- `npm run typecheck`, `npm run build`.

## Stack
Node.js 22 + TypeScript (ESM), Fastify, Postgres 16 + pgvector, zod, Vitest. Local version control: Jujutsu colocated with git. Hosting: Azure Container Apps + Azure Database for PostgreSQL, deployed by GitHub Actions with OIDC (no stored Azure passwords).
