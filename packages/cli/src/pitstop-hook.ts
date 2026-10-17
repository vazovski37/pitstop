/** The `pitstop-hook` bin: Claude Code's PostToolUse hook (mcp/src/hook.ts), a safe point after every tool call. */
import { runHook } from "../../../mcp/src/hook.js";
import { asksForHelp, VERSION } from "./version.js";

if (asksForHelp(process.argv.slice(2))) {
  console.log(`pitstop-hook ${VERSION}: Claude Code's PostToolUse hook for Pitstop; it reads the hook input on stdin. \`pitstop setup\` wires it in .claude/settings.json.`);
} else {
  runHook();
}
