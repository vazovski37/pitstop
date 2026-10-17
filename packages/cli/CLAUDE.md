# packages/cli — the client, as one installable tarball

Owner: **Vazovski**. No source of its own beyond three entry files: it bundles `daemon/` and `mcp/` so a laptop with Node 22, git and jj installs everything with one line, from our server, while the GitHub repository stays private.

## What it is
- `pitstop-cli` (not published to npm; packed). Bins: `pitstop` (`src/pitstop.ts` runs `runCli` from `daemon/src/index.ts`), `pitstop-mcp` (`startServer` from `mcp/src/index.ts`), `pitstop-hook` (`runHook` from `mcp/src/hook.ts`). Each answers `--help`.
- `build.mjs` (`npm run build -w pitstop-cli`): esbuild, ESM, platform node, target node22, one self-contained file per bin in `dist/`, with a `#!/usr/bin/env node` and `createRequire` banner for the CommonJS it bundles (ws, ajv). `@pitstop/protocol` comes from `packages/protocol/src`, so its build is not needed. External: `typescript` (the daemon's `symbols.ts` runs the compiler API; it is the package's only dependency) and ws's optional `bufferutil`/`utf-8-validate`.
- `define`s `__PITSTOP_BUNDLE__` and `__PITSTOP_VERSION__` (read by `daemon/src/build-info.ts` and `mcp/src/build-info.ts`). Inside the bundle every module's `import.meta.url` is the bundle's, so the modules' own "am I the script node started?" checks are switched off there and the entry files start things instead. That also covers a global install on macOS/Linux, where `argv[1]` is the bin symlink and would never match.
- `pack.mjs` (`npm run pack:cli` at the root): builds, `npm pack`s, and writes `web/dist/pitstop-cli.tgz`. `server/Dockerfile` runs it, so the image serves the tarball at `/pitstop-cli.tgz` with the live view's static files. Users: `npm install -g https://<server>/pitstop-cli.tgz`, then `pitstop setup <server> <owner/name> --token …` (daemon/README.md).

## Rules
- Never import from `server/` or `web/`. Keep the entries thin: behaviour lives in `daemon/` and `mcp/`, where it is tested.
- How the daemon finds itself to start in the background: `pitstop.js` (the bundle file) for `pitstop setup`/`start` (`daemon/src/processes.ts`), and `pitstop.js` next to `pitstop-mcp.js` for the agent side (`mcp/src/autostart.ts`). Keep the bin file names.
- Bump `version` when the tarball's behaviour changes; `pitstop version` prints it, so a user's report says which client they run.
- `src/build.test.ts` builds the bundle and runs each bin with node, including an MCP handshake over stdio.
