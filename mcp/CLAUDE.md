# mcp/ — agent integration

Owner: **teammate**.

## What this folder does
Connects coding agents (Claude Code for the hackathon) to the daemon: MCP tools the agent calls, and the hook that marks safe points. Design reference: the technical design doc (written when the project was called Agent Git), sections 8.3, 10 and 13.

## Pieces
- `src/index.ts`: the MCP server over stdio. Tools `declare_intent`, `commit`, `why`, `callers`, `status`; `similar` waits for the server's semantic endpoint. The worktree is `PITSTOP_WORKTREE` or the current directory.
- `src/tools.ts`: each tool as a plain function returning the text the agent sees (tested without the transport). `src/client.ts`: finds the worktree's daemon through `.pitstop/daemon.json` and calls its local API.
- `src/hook.ts`: the Claude Code `PostToolUse` hook. It posts a safe point to the daemon, which applies pending entries then, and returns the daemon's notes (entries that touched the agent's work, conflicts, warnings) as `additionalContext`. Without a daemon it prints nothing and exits 0.
- `src/setup.ts`: `pitstop-agent-setup <worktree>` writes the MCP server into the worktree's `.mcp.json` and the hook into `.claude/settings.json`, keeping whatever else is there.

For a team that is not us: [daemon/README.md](../daemon/README.md) walks through install, `init` or `clone`, the Claude Code wiring and the daily loop.

## Setup, per laptop and worktree
1. From the pitstop repo, once: `npm run build` (the daemon's and this package's `dist/`).
2. In the worktree the agent will edit (for the demo, the slice from `demo/scripts/reset.sh`): `node <pitstop>/mcp/dist/setup.js .` Then check `.mcp.json` and `.claude/settings.json` in that worktree.
3. Start the daemon there: `node <pitstop>/daemon/dist/index.js daemon` with `PITSTOP_SERVER`, `PITSTOP_TOKEN`, `PITSTOP_DEVELOPER` and `PITSTOP_AGENT` set (the demo's `agent-a` / `agent-b`). It prints the local API port and writes `.pitstop/daemon.json`.
4. Open Claude Code in the worktree. The `pitstop` tools appear; after every tool call the hook runs and the agent is told what landed meanwhile.

## Rules
- Tools talk to the local daemon, not directly to the server, so there is one connection per worktree.
- Keep tool outputs short and actionable; they land in the agent's context.
- The hook never fails a tool and never blocks: an unreachable daemon means silence.
