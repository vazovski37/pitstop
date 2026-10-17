import type pg from "pg";
import type {
  Changeset,
  Checks,
  CommitRequest,
  FileChange,
  Intent,
  IntentRequest,
  Lsn,
  Repair,
  Repo,
  RepoId,
} from "@pitstop/protocol";
import {
  GAP_LIMIT,
  gapStart,
  InvalidCommit,
  newIntentId,
  repoOf,
  SKIPPED_CHECKS,
  unknownRepo,
  type Decide,
  type Mirror,
  type MirrorConfig,
  type MirrorPatch,
  type MirrorStatus,
  type Store,
  type Tree,
} from "./store.js";

interface MirrorRow {
  repo: string;
  github_repo: string;
  branch: string;
  base_commit: string;
  last_lsn: number;
  last_commit: string;
  status: MirrorStatus;
  error: string | null;
  updated_at: Date;
}

const MIRROR_COLUMNS = "repo, github_repo, branch, base_commit, last_lsn::int as last_lsn, last_commit, status, error, updated_at";

const mirrorOf = (row: MirrorRow): Mirror => ({
  repo: row.repo,
  githubRepo: row.github_repo,
  branch: row.branch,
  baseCommit: row.base_commit,
  lastLsn: row.last_lsn,
  lastCommit: row.last_commit,
  status: row.status,
  ...(row.error === null ? {} : { error: row.error }),
  updatedAt: row.updated_at.toISOString(),
});

/** A pool or a client inside a transaction; both answer `query`. */
interface Queryable {
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

interface ChangesetRow {
  repo: string;
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

interface RepoRow {
  id: string;
  head: number;
  created_at: Date;
}

/**
 * The log in Postgres. Tables: server/migrations. LSNs are bigint in SQL and cast to int on the
 * way out; they count per repository, and each repository's appends are serialised by their own
 * transaction-scoped advisory lock, so two commits never share or skip an LSN.
 */
export class PgStore implements Store {
  constructor(private readonly pool: pg.Pool) {}

  async append(req: CommitRequest, decide?: Decide): Promise<Changeset> {
    const repo = repoOf(req);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [repo]);

      const seen = await client.query<{ repo: string; lsn: number }>(
        "select repo, lsn::int as lsn from changesets where idempotency_key = $1",
        [req.idempotencyKey],
      );
      const seenRow = seen.rows[0];
      if (seenRow !== undefined) {
        const [existing] = await this.read(client, seenRow.repo, seenRow.lsn - 1, 1);
        await client.query("commit");
        if (!existing) throw new Error(`changeset ${seenRow.repo}#${seenRow.lsn} vanished`);
        return existing;
      }

      const known = await client.query("select 1 from repos where id = $1", [repo]);
      if ((known.rowCount ?? 0) === 0) throw unknownRepo(repo);
      const lsn = (await this.head(client, repo)) + 1;
      if (req.baseLsn >= lsn) throw new InvalidCommit(`baseLsn ${req.baseLsn} is not below the next LSN ${lsn}`);
      if (req.intentId !== undefined) {
        const intent = await client.query("select 1 from intents where id = $1", [req.intentId]);
        if ((intent.rowCount ?? 0) === 0) throw new InvalidCommit(`unknown intent ${req.intentId}`);
      }
      const brain = await client.query<{ version: number | null }>("select max(version) as version from brain_versions");

      // The validator runs here, under the lock, so nothing lands between its look at the gap and this append.
      const gap = decide ? await this.read(client, repo, gapStart(req), GAP_LIMIT + 1) : [];
      const decision = decide ? await decide(gap, lsn - 1) : {};

      await client.query(
        `insert into changesets
           (repo, lsn, base_lsn, idempotency_key, developer, agent, intent, intent_id, repairs, checks, brain_version)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          repo,
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
          "insert into changeset_files (repo, lsn, path, op, blob_hash, from_path) values ($1, $2, $3, $4, $5, $6)",
          [repo, lsn, f.path, f.op, f.blob ?? null, f.fromPath ?? null],
        );
      }
      const symbols: [string, SymbolRow["kind"]][] = [
        ...req.readSet.map((s): [string, SymbolRow["kind"]] => [s, "read"]),
        ...req.writeSet.map((s): [string, SymbolRow["kind"]] => [s, "write"]),
        ...req.sigWriteSet.map((s): [string, SymbolRow["kind"]] => [s, "sig_write"]),
      ];
      for (const [symbolId, kind] of symbols) {
        await client.query(
          "insert into changeset_symbols (repo, lsn, symbol_id, kind) values ($1, $2, $3, $4) on conflict do nothing",
          [repo, lsn, symbolId, kind],
        );
      }
      if (req.intentId !== undefined) {
        await client.query("update intents set status = 'committed' where id = $1 and status = 'open'", [req.intentId]);
      }

      const [changeset] = await this.read(client, repo, lsn - 1, 1);
      await client.query("commit");
      if (!changeset) throw new Error(`changeset ${repo}#${lsn} not readable after insert`);
      return changeset;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  entriesAfter(repo: RepoId, fromLsn: Lsn, limit: number): Promise<Changeset[]> {
    return this.read(this.pool, repo, fromLsn, limit);
  }

  headLsn(repo: RepoId): Promise<Lsn> {
    return this.head(this.pool, repo);
  }

  async treeAt(repo: RepoId, lsn: Lsn): Promise<Tree> {
    // The latest change per path up to `lsn`; a rename also ends its old path there.
    const rows = await this.pool.query<{ path: string; content: string }>(
      `with changes as (
         select path, lsn, op, blob_hash from changeset_files where repo = $1 and lsn <= $2
         union all
         select from_path as path, lsn, 'delete' as op, null as blob_hash
         from changeset_files where repo = $1 and lsn <= $2 and from_path is not null
       ),
       latest as (select distinct on (path) path, op, blob_hash from changes order by path, lsn desc)
       select l.path, convert_from(b.bytes, 'UTF8') as content
       from latest l join blobs b on b.hash = l.blob_hash
       where l.op <> 'delete' order by l.path`,
      [repo, lsn],
    );
    return new Map(rows.rows.map((r) => [r.path, r.content]));
  }

  async createRepo(id: RepoId): Promise<{ repo: Repo; created: boolean }> {
    const inserted = await this.pool.query<{ created_at: Date }>(
      "insert into repos (id) values ($1) on conflict (id) do nothing returning created_at",
      [id],
    );
    const row = inserted.rows[0];
    if (row !== undefined) return { repo: { id, headLsn: 0, createdAt: row.created_at.toISOString() }, created: true };
    const existing = await this.getRepo(id);
    if (existing === undefined) throw new Error(`repo ${id} vanished`);
    return { repo: existing, created: false };
  }

  async getRepo(id: RepoId): Promise<Repo | undefined> {
    const res = await this.pool.query<RepoRow>(
      `select r.id, r.created_at, coalesce(max(c.lsn), 0)::int as head
       from repos r left join changesets c on c.repo = r.id where r.id = $1 group by r.id`,
      [id],
    );
    const row = res.rows[0];
    return row === undefined ? undefined : { id: row.id, headLsn: row.head, createdAt: row.created_at.toISOString() };
  }

  async listRepos(): Promise<Repo[]> {
    const res = await this.pool.query<RepoRow>(
      `select r.id, r.created_at, coalesce(max(c.lsn), 0)::int as head
       from repos r left join changesets c on c.repo = r.id group by r.id order by r.id`,
    );
    return res.rows.map((row) => ({ id: row.id, headLsn: row.head, createdAt: row.created_at.toISOString() }));
  }

  async openIntent(req: IntentRequest): Promise<Intent> {
    const repo = repoOf(req);
    const known = await this.pool.query("select 1 from repos where id = $1", [repo]);
    if ((known.rowCount ?? 0) === 0) throw unknownRepo(repo);
    const id = newIntentId();
    const res = await this.pool.query<{ heartbeat_at: Date }>(
      `insert into intents (id, repo, developer, agent, base_lsn, text, declared_symbols, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'open') returning heartbeat_at`,
      [id, repo, req.author.developer, req.author.agent, req.baseLsn, req.text, req.declaredSymbols],
    );
    return {
      id,
      repo,
      author: req.author,
      baseLsn: req.baseLsn,
      text: req.text,
      declaredSymbols: req.declaredSymbols,
      status: "open",
      heartbeatAt: (res.rows[0]?.heartbeat_at ?? new Date()).toISOString(),
    };
  }

  async openIntents(repo: RepoId): Promise<Intent[]> {
    const res = await this.pool.query<{
      id: string;
      developer: string;
      agent: string;
      base_lsn: number;
      text: string;
      declared_symbols: string[];
      heartbeat_at: Date;
    }>(
      `select id, developer, agent, base_lsn::int as base_lsn, text, declared_symbols, heartbeat_at
       from intents where repo = $1 and status = 'open' order by created_at`,
      [repo],
    );
    return res.rows.map((row) => ({
      id: row.id,
      repo,
      author: { developer: row.developer, agent: row.agent },
      baseLsn: row.base_lsn,
      text: row.text,
      declaredSymbols: row.declared_symbols,
      status: "open",
      heartbeatAt: row.heartbeat_at.toISOString(),
    }));
  }

  async heartbeat(intentId: string): Promise<void> {
    await this.pool.query("update intents set heartbeat_at = now() where id = $1 and status = 'open'", [intentId]);
  }

  async getMirror(repo: RepoId): Promise<Mirror | undefined> {
    const res = await this.pool.query<MirrorRow>(`select ${MIRROR_COLUMNS} from repo_mirrors where repo = $1`, [repo]);
    const row = res.rows[0];
    return row === undefined ? undefined : mirrorOf(row);
  }

  async setMirror(repo: RepoId, config: MirrorConfig): Promise<Mirror> {
    const known = await this.pool.query("select 1 from repos where id = $1", [repo]);
    if ((known.rowCount ?? 0) === 0) throw unknownRepo(repo);
    const res = await this.pool.query<MirrorRow>(
      `insert into repo_mirrors (repo, github_repo, branch, base_commit, last_lsn, last_commit, status, error, updated_at)
       values ($1, $2, $3, $4, 0, $4, 'enabled', null, now())
       on conflict (repo) do update set github_repo = excluded.github_repo, branch = excluded.branch,
         base_commit = excluded.base_commit, last_lsn = 0, last_commit = excluded.base_commit,
         status = 'enabled', error = null, updated_at = now()
       returning ${MIRROR_COLUMNS}`,
      [repo, config.githubRepo, config.branch, config.baseCommit],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error(`mirror of ${repo} not readable after insert`);
    return mirrorOf(row);
  }

  async deleteMirror(repo: RepoId): Promise<void> {
    await this.pool.query("delete from repo_mirrors where repo = $1", [repo]);
  }

  async updateMirror(repo: RepoId, patch: MirrorPatch): Promise<void> {
    await this.pool.query(
      `update repo_mirrors set
         last_lsn = coalesce($2, last_lsn),
         last_commit = coalesce($3, last_commit),
         status = coalesce($4, status),
         error = case when $5::boolean then null else coalesce($6, error) end,
         updated_at = now()
       where repo = $1`,
      [repo, patch.lastLsn ?? null, patch.lastCommit ?? null, patch.status ?? null, patch.error === null, patch.error ?? null],
    );
  }

  async listMirrors(): Promise<Mirror[]> {
    const res = await this.pool.query<MirrorRow>(`select ${MIRROR_COLUMNS} from repo_mirrors order by repo`);
    return res.rows.map(mirrorOf);
  }

  private async head(db: Queryable, repo: RepoId): Promise<Lsn> {
    const res = await db.query<{ head: number }>("select coalesce(max(lsn), 0)::int as head from changesets where repo = $1", [repo]);
    return res.rows[0]?.head ?? 0;
  }

  private async read(db: Queryable, repo: RepoId, fromLsn: Lsn, limit: number): Promise<Changeset[]> {
    const heads = await db.query<ChangesetRow>(
      `select repo, lsn::int as lsn, base_lsn::int as base_lsn, developer, agent, intent, repairs, checks,
              brain_version, created_at
       from changesets where repo = $1 and lsn > $2 order by lsn limit $3`,
      [repo, fromLsn, limit],
    );
    if (heads.rows.length === 0) return [];
    const lsns = heads.rows.map((r) => r.lsn);
    const files = await db.query<FileRow>(
      `select f.lsn::int as lsn, f.path, f.op, f.blob_hash, f.from_path, convert_from(b.bytes, 'UTF8') as content
       from changeset_files f left join blobs b on b.hash = f.blob_hash
       where f.repo = $1 and f.lsn = any($2::bigint[]) order by f.lsn, f.path`,
      [repo, lsns],
    );
    const symbols = await db.query<SymbolRow>(
      `select lsn::int as lsn, symbol_id, kind from changeset_symbols
       where repo = $1 and lsn = any($2::bigint[]) order by lsn, symbol_id`,
      [repo, lsns],
    );
    return heads.rows.map((row) => {
      const own = <T extends { lsn: number }>(rows: T[]): T[] => rows.filter((r) => r.lsn === row.lsn);
      const syms = own(symbols.rows);
      return {
        repo: row.repo,
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
