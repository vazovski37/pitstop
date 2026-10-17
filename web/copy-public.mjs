// The second half of `npm run build`: tsc has written dist/app.js; the page and its stylesheet go next to it.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
cpSync(join(here, "public"), join(here, "dist"), { recursive: true });
