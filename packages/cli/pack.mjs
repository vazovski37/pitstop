// `npm run pack:cli` (repository root): builds the bundle and packs it as web/dist/pitstop-cli.tgz.
// The server serves web/dist at /, so a laptop installs the client with
//   npm install -g https://<server>/pitstop-cli.tgz
import { execSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./build.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Absolute before npm runs from this folder: a relative destination means the caller's cwd.
const dest = resolve(process.argv[2] ?? join(here, "..", "..", "web", "dist"));

await bundle();
mkdirSync(dest, { recursive: true });
const packed = JSON.parse(execSync(`npm pack --json --pack-destination "${dest}"`, { cwd: here, encoding: "utf8" }));
const target = join(dest, "pitstop-cli.tgz");
rmSync(target, { force: true });
renameSync(join(dest, packed[0].filename), target);
console.log(`${target} (${packed[0].entryCount} files, ${Math.round(packed[0].size / 1024)} KiB)`);
