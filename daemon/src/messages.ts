import type { ServerMessage } from "@pitstop/protocol";

/** One line per server message, for the daemon's log. */
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
