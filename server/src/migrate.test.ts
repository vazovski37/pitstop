import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

// Runs only when a database is available: in CI (Postgres service container)
// or locally after `npm run db:up` with DATABASE_URL set.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("migrations against a real Postgres", () => {
  const pool = createPool(url ?? "");
  afterAll(() => pool.end());

  it("applies cleanly and is idempotent", async () => {
    await migrate(pool);
    const second = await migrate(pool);
    expect(second).toEqual([]);
  });

  it("creates the log, catalog and pgvector", async () => {
    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = tables.rows.map((r) => r.table_name);
    for (const t of ["changesets", "changeset_symbols", "symbols", "intents", "leases", "adrs", "symbol_embeddings"]) {
      expect(names).toContain(t);
    }
    const ext = await pool.query("select 1 from pg_extension where extname = 'vector'");
    expect(ext.rowCount).toBe(1);
  });

  it("concurrent migrations do not conflict", async () => {
    const results = await Promise.all([migrate(pool), migrate(pool), migrate(pool)]);
    expect(results.flat()).toEqual([]);
  });
});
