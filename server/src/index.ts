import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { buildApp } from "./app.js";
import { createPool, ping } from "./db.js";
import { migrate } from "./migrate.js";
import { PgStore } from "./pg-store.js";
import { GitHubOAuth } from "./auth.js";
import { GitHubApi } from "./github.js";
import { GroqClient } from "./groq.js";
import { modelRepairer, parseRepairMode, type Repairer } from "./repair.js";
import { MemoryStore, type Store } from "./store.js";
import { parseValidationMode } from "./validate.js";

const port = Number(process.env.PORT ?? 8080);
// GIT_SHA is baked into the image by CI; the smoke test checks /healthz reports it.
const version = process.env.GIT_SHA ?? "dev";

let store: Store;
let pingDb: () => Promise<boolean>;
let pool: pg.Pool | undefined;

if (process.env.PITSTOP_STORE === "memory") {
  // No Postgres: handy for daemon work on a laptop. Nothing survives a restart.
  console.log("pitstop server: in-memory store, nothing is persisted");
  store = new MemoryStore();
  pingDb = async () => true;
} else {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (or set PITSTOP_STORE=memory)");
    process.exit(1);
  }
  const db = createPool(databaseUrl);
  pool = db;
  const applied = await migrate(db);
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
  store = new PgStore(db);
  pingDb = () => ping(db);
}

// Empty means open: fine on a laptop, not on Azure (SETUP.md, "Server token").
const token = process.env.PITSTOP_TOKEN || undefined;
if (token === undefined) console.log("pitstop server: PITSTOP_TOKEN is not set, every route is open");

const validation = parseValidationMode(process.env.PITSTOP_VALIDATE);
const check = process.env.PITSTOP_CHECK === "always" ? "always" : "off";
const repair = parseRepairMode(process.env.PITSTOP_REPAIR);
let repairer: Repairer | undefined;
if (repair === "groq") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("PITSTOP_REPAIR=groq needs GROQ_API_KEY (SETUP.md, \"AI repair\")");
    process.exit(1);
  }
  const client = new GroqClient({ apiKey, model: process.env.GROQ_MODEL || undefined });
  repairer = modelRepairer(client);
  console.log(`pitstop server: AI repair through Groq, model ${client.model}`);
}
console.log(
  `pitstop server: validation ${validation} (PITSTOP_VALIDATE), type-check gate ${check} (PITSTOP_CHECK), repair ${repair} (PITSTOP_REPAIR)`,
);

// Phase 3: the git mirror pushes accepted entries to GitHub with this token (SETUP.md, "Git mirror").
const mirrorToken = process.env.MIRROR_GITHUB_TOKEN || undefined;
const github = mirrorToken === undefined ? undefined : new GitHubApi({ token: mirrorToken });
console.log(`pitstop server: git mirror ${github === undefined ? "off (no MIRROR_GITHUB_TOKEN)" : "on"}`);

// Phase 5: accounts. Sign in with GitHub needs an OAuth App and a cookie secret (SETUP.md, "Accounts").
const clientId = process.env.GITHUB_OAUTH_CLIENT_ID || undefined;
const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET || undefined;
const sessionSecret = process.env.SESSION_SECRET || undefined;
const oauth = clientId !== undefined && clientSecret !== undefined ? new GitHubOAuth({ clientId, clientSecret }) : undefined;
if (oauth !== undefined && sessionSecret === undefined) {
  console.error("GITHUB_OAUTH_CLIENT_ID is set but SESSION_SECRET is not; accounts need both");
  process.exit(1);
}
console.log(`pitstop server: accounts ${oauth === undefined ? "off (no GITHUB_OAUTH_CLIENT_ID)" : "on"}`);
// In production the shared token is required: without it a server with no accounts is open to
// anyone with the URL, and a server with accounts has no administrator to add owners to member-less
// repositories or to configure mirrors. A Provision run without it must fail loudly.
// PITSTOP_ALLOW_OPEN=1 is for the image on a laptop (docker compose), never for Azure.
if (process.env.NODE_ENV === "production" && token === undefined && process.env.PITSTOP_ALLOW_OPEN !== "1") {
  console.error("refusing to start in production without PITSTOP_TOKEN, the administrator's token (PITSTOP_ALLOW_OPEN=1 on a laptop)");
  process.exit(1);
}

// Phase 5: the live view (web/, built to web/dist) served at /. Nothing there means no page.
const webDir = process.env.PITSTOP_WEB_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
const web = existsSync(join(webDir, "index.html")) ? webDir : undefined;
console.log(`pitstop server: live view ${web === undefined ? `off (no index.html in ${webDir})` : `from ${web}`}`);

const app = await buildApp({
  version,
  pingDb,
  store,
  token,
  oauth,
  sessionSecret,
  webUrl: process.env.PITSTOP_WEB_URL || undefined,
  publicUrl: process.env.PITSTOP_PUBLIC_URL || undefined,
  secureCookies: process.env.NODE_ENV === "production",
  validation,
  check,
  repair,
  repairer,
  github,
  webDir: web,
  logger: true,
});

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port });
