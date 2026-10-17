import { buildApp } from "./app.js";
import { createPool, headLsn, ping } from "./db.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
// GIT_SHA is baked into the image by CI; the smoke test checks /healthz reports it.
const version = process.env.GIT_SHA ?? "dev";

const pool = createPool(databaseUrl);
const applied = await migrate(pool);
if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);

const app = await buildApp({
  version,
  pingDb: () => ping(pool),
  headLsn: () => headLsn(pool),
  logger: true,
});

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port });
