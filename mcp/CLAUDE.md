# mcp/ — agent integration

Owner: **teammate**.

## What this folder does
Connects coding agents (Claude Code for the hackathon) to the daemon: MCP tools the agent calls, and the hook that marks safe points. Design reference: the technical design doc (written when the project was called Agent Git), sections 8.3, 10 and 13.

## Planned pieces
- MCP tools: `declare_intent`, `commit`, `why`, `callers`, `similar`.
- A Claude Code `PostToolUse` hook that tells the local daemon a safe point was reached, so it can apply pending entries.
- Setup instructions for adding the MCP server and hook to each laptop's Claude Code config.

## Rules
- Tools talk to the local daemon, not directly to the server, so there is one connection per worktree.
- Keep tool outputs short and actionable; they land in the agent's context.
