# Pitstop

Version control for teams where agents write the code. The codebase is treated as a database: one server keeps an ordered log of every change, every worktree is a live replica, every agent task is a transaction, and AI repairs the conflicts git cannot see, when one agent changes something another agent depends on.

- Design: the technical design doc (written when the project was called Agent Git), a shared doc
- Setup and deployment: [SETUP.md](SETUP.md)
- Rules for Claude and folder ownership: [CLAUDE.md](CLAUDE.md)

## Layout

| Folder | What |
| --- | --- |
| `packages/protocol` | Shared message schemas and fixtures: the contract |
| `server/` | Log, commit API, stream, validator, AI repair |
| `infra/`, `.github/` | Azure (Bicep), bootstrap, CI/CD |
| `daemon/` | Local replica: stream, jj, read/write sets, the `pitstop` CLI ([guide for other teams](daemon/README.md)) |
| `mcp/` | Agent tools and safe-point hook |
| `packages/cli` | The client as one tarball (`pitstop`, `pitstop-mcp`, `pitstop-hook`), served by the server at `/pitstop-cli.tgz` |
| `web/` | Live view, served by the server at `/` |
| `demo/` | The demo slice, the scenario, the gates and the rehearsal |

Built by two developers until 18 October 2026 (see [CLAUDE.md](CLAUDE.md)); maintained by Vazovski since.

## Quick start
```bash
npm install
npm run db:up
npm run dev:server     # http://localhost:8080/healthz
npm test
```

Deploys happen only through GitHub Actions when `main` changes.
