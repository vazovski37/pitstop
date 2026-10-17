import type pg from "pg";
import { buildApp } from "./app.js";
import { createPool, ping } from "./db.js";
import { migrate } from "./migrate.js";
import { PgStore } from "./pg-store.js";
import { MemoryStore, type Store } from "./store.js";

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

const app = await buildApp({ version, pingDb, store, logger: true });

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await pool?.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port });
