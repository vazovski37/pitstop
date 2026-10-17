/** The `pitstop-mcp` bin: the MCP server over stdio (mcp/src/index.ts), which Claude Code starts from .mcp.json. */
import { startServer } from "../../../mcp/src/index.js";
import { asksForHelp, VERSION } from "./version.js";

if (asksForHelp(process.argv.slice(2))) {
  console.log(`pitstop-mcp ${VERSION}: the Pitstop MCP server for Claude Code, over stdio. Claude Code starts it from the .mcp.json \`pitstop setup\` writes.`);
} else {
  startServer();
}
