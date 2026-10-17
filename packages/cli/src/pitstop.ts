/** The `pitstop` bin: the daemon's CLI (daemon/src/index.ts), run whatever node was started with. */
import { runCli } from "../../../daemon/src/index.js";

runCli(process.argv.slice(2));
