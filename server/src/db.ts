import pg from "pg";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    // Azure Database for PostgreSQL requires TLS; the URL carries sslmode=require there.
    // Locally (docker compose) the URL has no sslmode and TLS stays off.
  });
}

export async function ping(pool: pg.Pool): Promise<boolean> {
  const res = await pool.query<{ ok: number }>("select 1 as ok");
  return res.rows[0]?.ok === 1;
}

export async function headLsn(pool: pg.Pool): Promise<number> {
  const res = await pool.query<{ head: string | null }>("select max(lsn)::text as head from changesets");
  return Number(res.rows[0]?.head ?? 0);
}
