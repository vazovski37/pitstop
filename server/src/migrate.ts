import { readdir, readFile } from "node:fs/promises";
import type pg from "pg";

/** Any fixed number works; every server instance must use the same one. */
const MIGRATION_LOCK_ID = 7_301_420;

const defaultDir = new URL("../migrations/", import.meta.url);

/**
 * Applies every `migrations/NNN_name.sql` not yet recorded, in file-name order,
 * each in its own transaction.
 *
 * Runs on server start. A Postgres advisory lock makes it safe when several
 * replicas start at once: one migrates, the others wait, then find nothing to do.
 */
export async function migrate(pool: pg.Pool, dir: URL = defaultDir): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(
      `create table if not exists schema_migrations (
         id text primary key,
         applied_at timestamptz not null default now()
       )`,
    );
    const done = new Set(
      (await client.query<{ id: string }>("select id from schema_migrations")).rows.map((r) => r.id),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, dir), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (id) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}
