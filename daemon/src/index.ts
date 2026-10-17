#!/usr/bin/env node
/**
 * Local daemon: one per worktree. Phase 1 starts here.
 *
 * Responsibilities (design doc sections 6.3 and 8):
 * - connect to the server's /stream WebSocket and subscribe from the worktree's applied LSN
 * - apply incoming entries at safe points, rebasing the agent's unfinished work with jj
 * - compute read and write sets with the TypeScript compiler API
 * - send commits to POST /commit
 */
import type { ServerMessage } from "@pitstop/protocol";

export function describe(message: ServerMessage): string {
  switch (message.type) {
    case "hello":
      return `connected to server ${message.serverVersion}, head #${message.headLsn}`;
    case "entry":
      return `#${message.changeset.lsn} ${message.changeset.intent}`;
    case "intent":
      return `${message.intent.author.agent} started: ${message.intent.text}`;
    case "warning":
      return `warning for ${message.agent}: ${message.message}`;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("pitstop daemon: not implemented yet (Phase 1).");
}
