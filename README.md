# Pitstop

Version control for teams where agents write the code. The codebase is treated as a database: one server keeps an ordered log of every change, every worktree is a live replica, every agent task is a transaction, and AI repairs the conflicts git cannot see, when one agent changes something another agent depends on.

- Design: the technical design doc (written when the project was called Agent Git), a shared doc
- Setup and deployment: [SETUP.md](SETUP.md)
- Rules for Claude and folder ownership: [CLAUDE.md](CLAUDE.md)

## Layout

| Folder | What | Owner |
| --- | --- | --- |
| `packages/protocol` | Shared message schemas and fixtures: the contract | Both |
| `server/` | Log, commit API, stream, validator, AI repair | Vazovski |
| `infra/`, `.github/` | Azure (Bicep), bootstrap, CI/CD | Vazovski |
| `daemon/` | Local replica: stream, jj, read/write sets | Teammate |
| `mcp/` | Agent tools and safe-point hook | Teammate |
| `web/` | Live view | Teammate |

## Quick start
```bash
npm install
npm run db:up
npm run dev:server     # http://localhost:8080/healthz
npm test
```

Deploys happen only through GitHub Actions when `main` changes.
