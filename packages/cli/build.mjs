// `npm run build -w pitstop-cli`: the client as three self-contained bins in dist/, for `npm pack`.
// Everything is bundled except TypeScript (daemon/src/symbols.ts runs its compiler API; it is this
// package's one dependency) and ws's optional native helpers, which ws loads only if present.
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).version;

/** The protocol from source, so no build of packages/protocol is needed first. */
const protocolFromSource = {
  name: "protocol-from-source",
  setup(b) {
    b.onResolve({ filter: /^@pitstop\/protocol$/ }, () => ({ path: join(here, "..", "protocol", "src", "index.ts") }));
  },
};

export async function bundle(outdir = join(here, "dist")) {
  rmSync(outdir, { recursive: true, force: true });
  await build({
    entryPoints: {
      pitstop: join(here, "src", "pitstop.ts"),
      "pitstop-mcp": join(here, "src", "pitstop-mcp.ts"),
      "pitstop-hook": join(here, "src", "pitstop-hook.ts"),
    },
    outdir,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["typescript", "bufferutil", "utf-8-validate"],
    plugins: [protocolFromSource],
    // build-info.ts in daemon/ and mcp/: inside the bundle, the entries start things (not isMain checks).
    define: { __PITSTOP_BUNDLE__: "true", __PITSTOP_VERSION__: JSON.stringify(version) },
    // The shebang for the bins, and a `require` for the CommonJS that gets bundled (ws, ajv).
    banner: {
      js: ['#!/usr/bin/env node', 'import { createRequire as __pitstopCreateRequire } from "node:module";', "const require = __pitstopCreateRequire(import.meta.url);"].join("\n"),
    },
    legalComments: "none",
    logLevel: "warning",
  });
  return outdir;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle();
}
