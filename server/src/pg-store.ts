import type pg from "pg";
import {
  DEFAULT_REPO,
  type Changeset,
  type Checks,
  type CommitRequest,
  type FileChange,
  type Intent,
  type IntentRequest,
  type Lsn,
  type Repair,
} from "@pitstop/protocol";
import {
  GAP_LIMIT,
  gapStart,
  InvalidCommit,
  newIntentId,
  SKIPPED_CHECKS,
  type Decide,
  type Store,
  type Tree,
} from "./store.js";

/** Every append takes this transaction-scoped advisory lock, so two commits never share or skip an LSN. */
const APPEND_LOCK_ID = 7_301_421;

/** A pool or a client inside a transaction; both answer `query`. */
interface Queryable {
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

interface ChangesetRow {
  lsn: number;
  base_lsn: number;
  developer: string;
  agent: string;
  intent: string;
  repairs: Repair[];
  checks: Checks;
  brain_version: number;
  created_at: Date;
}

interface FileRow {
  lsn: number;
  path: string;
  op: FileChange["op"];
  blob_hash: string | null;
  from_path: string | null;
  content: string | null;
}

interface SymbolRow {
  lsn: number;
  symbol_id: string;
  kind: "read" | "write" | "sig_write";
}

/** The log in Postgres. Tables: server/migrations. LSNs are bigint in SQL and cast to int on the way out. */
export class PgStore implements Store {
  constructor(private readonly pool: pg.Pool) {}

  async append(req: CommitRequest, decide?: Decide): Promise<Changeset> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [APPEND_LOCK_ID]);

      const seen = await client.query<{ lsn: number }>(
        "select lsn::int as lsn from changesets where idempotency_key = $1",
        [req.idempotencyKey],
      );
      const seenLsn = seen.rows[0]?.lsn;
      if (seenLsn !== undefined) {
        const [existing] = await this.read(client, seenLsn - 1, 1);
        await client.query("commit");
        if (!existing) throw new Error(`changeset ${seenLsn} vanished`);
        return existing;
      }

      const lsn = (await this.head(client)) + 1;
      if (req.baseLsn >= lsn) throw new InvalidCommit(`baseLsn ${req.baseLsn} is not below the next LSN ${lsn}`);
      if (req.intentId !== undefined) {
        const known = await client.query("select 1 from intents where id = $1", [req.intentId]);
        if ((known.rowCount ?? 0) === 0) throw new InvalidCommit(`unknown intent ${req.intentId}`);
      }
      const brain = await client.query<{ version: number | null }>("select max(version) as version from brain_versions");

      // The validator runs here, under the lock, so nothing lands between its look at the gap and this append.
      const gap = decide ? await this.read(client, gapStart(req), GAP_LIMIT + 1) : [];
      const decision = decide ? await decide(gap, lsn - 1) : {};

      await client.query(
        `insert into changesets
           (lsn, base_lsn, idempotency_key, developer, agent, intent, intent_id, repairs, checks, brain_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          lsn,
          req.baseLsn,
          req.idempotencyKey,
          req.author.developer,
          req.author.agent,
          req.intent,
          req.intentId ?? null,
          JSON.stringify(decision.repairs ?? []),
          JSON.stringify(decision.checks ?? SKIPPED_CHECKS),
          brain.rows[0]?.version ?? 0,
        ],
      );
      const files = decision.files ?? req.files;
      for (const f of files) {
        if (f.content !== undefined && f.blob !== undefined) {
          await client.query("insert into blobs (hash, bytes) values ($1, $2) on conflict (hash) do nothing", [
            f.blob,
            Buffer.from(f.content, "utf8"),
          ]);
        }
        await client.query(
          "insert into changeset_files (lsn, path, op, blob_hash, from_path) values ($1, $2, $3, $4, $5)",
          [lsn, f.path, f.op, f.blob ?? null, f.fromPath ?? null],
        );
      }
      const symbols: [string, SymbolRow["kind"]][] = [
        ...req.readSet.map((s): [string, SymbolRow["kind"]] => [s, "read"]),
        ...req.writeSet.map((s): [string, SymbolRow["kind"]] => [s, "write"]),
        ...req.sigWriteSet.map((s): [string, SymbolRow["kind"]] => [s, "sig_write"]),
      ];
      for (const [symbolId, kind] of symbols) {
        await client.query(
          "insert into changeset_symbols (lsn, symbol_id, kind) values ($1, $2, $3) on conflict do nothing",
          [lsn, symbolId, kind],
        );
      }
      if (req.intentId !== undefined) {
        await client.query("update intents set status = 'committed' where id = $1 and status = 'open'", [req.intentId]);
      }

      const [changeset] = await this.read(client, lsn - 1, 1);
      await client.query("commit");
      if (!changeset) throw new Error(`changeset ${lsn} not readable after insert`);
      return changeset;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  entriesAfter(fromLsn: Lsn, limit: number): Promise<Changeset[]> {
    return this.read(this.pool, fromLsn, limit);
  }

  headLsn(): Promise<Lsn> {
    return this.head(this.pool);
  }

  async treeAt(lsn: Lsn): Promise<Tree> {
    // The latest change per path up to `lsn`; a rename also ends its old path there.
    const rows = await this.pool.query<{ path: string; content: string }>(
      `with changes as (
         select path, lsn, op, blob_hash from changeset_files where lsn <= $1
         union all
         select from_path as path, lsn, 'delete' as op, null as blob_hash
         from changeset_files where lsn <= $1 and from_path is not null
       ),
       latest as (select distinct on (path) path, op, blob_hash from changes order by path, lsn desc)
       select l.path, convert_from(b.bytes, 'UTF8') as content
       from latest l join blobs b on b.hash = l.blob_hash
       where l.op <> 'delete' order by l.path`,
      [lsn],
    );
    return new Map(rows.rows.map((r) => [r.path, r.content]));
  }

  async openIntent(req: IntentRequest): Promise<Intent> {
    const id = newIntentId();
    const res = await this.pool.query<{ heartbeat_at: Date }>(
      `insert into intents (id, developer, agent, base_lsn, text, declared_symbols, status)
       values ($1, $2, $3, $4, $5, $6, 'open') returning heartbeat_at`,
      [id, req.author.developer, req.author.agent, req.baseLsn, req.text, req.declaredSymbols],
    );
    return {
      id,
      repo: DEFAULT_REPO, // until migration 003 stores repositories
      author: req.author,
      baseLsn: req.baseLsn,
      text: req.text,
      declaredSymbols: req.declaredSymbols,
      status: "open",
      heartbeatAt: (res.rows[0]?.heartbeat_at ?? new Date()).toISOString(),
    };
  }

  async heartbeat(intentId: string): Promise<void> {
    await this.pool.query("update intents set heartbeat_at = now() where id = $1 and status = 'open'", [intentId]);
  }

  private async head(db: Queryable): Promise<Lsn> {
    const res = await db.query<{ head: number }>("select coalesce(max(lsn), 0)::int as head from changesets");
    return res.rows[0]?.head ?? 0;
  }

  private async read(db: Queryable, fromLsn: Lsn, limit: number): Promise<Changeset[]> {
    const heads = await db.query<ChangesetRow>(
      `select lsn::int as lsn, base_lsn::int as base_lsn, developer, agent, intent, repairs, checks,
              brain_version, created_at
       from changesets where lsn > $1 order by lsn limit $2`,
      [fromLsn, limit],
    );
    if (heads.rows.length === 0) return [];
    const lsns = heads.rows.map((r) => r.lsn);
    const files = await db.query<FileRow>(
      `select f.lsn::int as lsn, f.path, f.op, f.blob_hash, f.from_path, convert_from(b.bytes, 'UTF8') as content
       from changeset_files f left join blobs b on b.hash = f.blob_hash
       where f.lsn = any($1::bigint[]) order by f.lsn, f.path`,
      [lsns],
    );
    const symbols = await db.query<SymbolRow>(
      "select lsn::int as lsn, symbol_id, kind from changeset_symbols where lsn = any($1::bigint[]) order by lsn, symbol_id",
      [lsns],
    );
    return heads.rows.map((row) => {
      const own = <T extends { lsn: number }>(rows: T[]): T[] => rows.filter((r) => r.lsn === row.lsn);
      const syms = own(symbols.rows);
      return {
        repo: DEFAULT_REPO, // until migration 003 stores repositories
        lsn: row.lsn,
        baseLsn: row.base_lsn,
        author: { developer: row.developer, agent: row.agent },
        intent: row.intent,
        files: own(files.rows).map((f) => ({
          path: f.path,
          op: f.op,
          ...(f.blob_hash === null ? {} : { blob: f.blob_hash }),
          ...(f.content === null ? {} : { content: f.content }),
          ...(f.from_path === null ? {} : { fromPath: f.from_path }),
        })),
        writeSet: syms.filter((s) => s.kind === "write").map((s) => s.symbol_id),
        sigWriteSet: syms.filter((s) => s.kind === "sig_write").map((s) => s.symbol_id),
        readSet: syms.filter((s) => s.kind === "read").map((s) => s.symbol_id),
        repairs: row.repairs,
        checks: row.checks,
        brainVersion: row.brain_version,
        createdAt: row.created_at.toISOString(),
      };
    });
  }
}
