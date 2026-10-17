/**
 * MCP server exposing Pitstop to coding agents (Phase 4).
 *
 * Planned tools (design doc sections 10 and 13):
 * - declare_intent(text, symbols?)  -> opens a transaction, returns early warnings
 * - commit()                        -> asks the daemon to send the current change
 * - why(path, line)                 -> intent behind a line
 * - callers(symbol)                 -> impact of changing a symbol
 * - similar(description)            -> existing symbols that already do this (semantic reuse)
 *
 * Plus a Claude Code PostToolUse hook that tells the daemon "safe point reached".
 */
export const PLANNED_TOOLS = ["declare_intent", "commit", "why", "callers", "similar"] as const;
