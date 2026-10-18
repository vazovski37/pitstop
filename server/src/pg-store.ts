import type pg from "pg";
import type {
  Adr,
  AdrRule,
  Author,
  Changeset,
  Checks,
  CommitRequest,
  FileChange,
  Intent,
  IntentRequest,
  Lease,
  Lsn,
  Repair,
  Repo,
  RepoId,
  SymbolId,
} from "@pitstop/protocol";
import { globToRegExpSource } from "./adr-rules.js";
import {
  ADR_TRANSITIONS,
  GAP_LIMIT,
  gapStart,
  holdsLease,
  InvalidCommit,
  movesBrain,
  newIntentId,
  notTheirIntent,
  repoOf,
  sameAuthor,
  SKIPPED_CHECKS,
  unknownRepo,
  newTokenId,
  newTokenSecret,
  newParkedId,
  newUserId,
  tokenHash,
  type AdrChange,
  type AdrProposal,
  type AdrVerdict,
  type LeaseGrant,
  type LeaseRequest,
  type LoggedEntry,
  type LogQuery,
  type SymbolState,
  type Decide,
  type Invite,
  type Member,
  type ParkDecision,
  type Parked,
  type ParkInput,
  type ParkStatus,
  type Mirror,
  type MirrorConfig,
  type MirrorPatch,
  type MirrorStatus,
  type Role,
  type Store,
  type Token,
  type Tree,
  type User,
  type UserInput,
  type Visibility,
} from "./store.js";

interface UserRow {
  id: string;
  github_id: string | number;
  login: string;
  name: string | null;
  avatar_url: string | null;
  created_at: Date;
}
const PARKED_COLUMNS =
  "id, repo, user_id, request, skew, conflicts_with, head_lsn, status, note, decided_by, landed_lsn, created_at, decided_at";
interface ParkedRow {
  id: string;
  repo: RepoId;
  user_id: string | null;
  request: CommitRequest;
  skew: string;
  conflicts_with: number[];
  head_lsn: number;
  status: ParkStatus;
  note: string | null;
  decided_by: string | null;
  landed_lsn: number | null;
  created_at: Date;
  decided_at: Date | null;
}
const parkedOf = (row: ParkedRow): Parked => ({
  id: row.id,
  repo: row.repo,
  ...(row.user_id === null ? {} : { userId: row.user_id }),
  request: row.request,
  author: row.request.author,
  skew: row.skew,
  conflictsWith: row.conflicts_with,
  headLsn: row.head_lsn,
  status: row.status,
  ...(row.note === null ? {} : { note: row.note }),
  ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
  ...(row.landed_lsn === null ? {} : { landedLsn: row.landed_lsn }),
  createdAt: row.created_at.toISOString(),
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
});

const USER_COLUMNS = "id, github_id, login, name, avatar_url, created_at";
const userOf = (row: UserRow): User => ({
  id: row.id,
  githubId: Number(row.github_id),
  login: row.login,
  ...(row.name === null ? {} : { name: row.name }),
  ...(row.avatar_url === null ? {} : { avatarUrl: row.avatar_url }),
  createdAt: row.created_at.toISOString(),
});

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}
const TOKEN_COLUMNS = "id, user_id, name, created_at, last_used_at, revoked_at";
const tokenOf = (row: TokenRow): Token => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
  ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at.toISOString() }),
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
});

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

const ADR_COLUMNS = "repo, number, title, status, decision, reason, consequences, rules, version, created_by, created_at, decided_by, decided_at";
interface AdrRow {
  repo: RepoId;
  number: number;
  title: string;
  status: Adr["status"];
  decision: string;
  reason: string;
  consequences: string;
  rules: AdrRule[];
  version: number;
  created_by: string;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
}
const adrOf = (row: AdrRow): Adr => ({
  repo: row.repo,
  number: row.number,
  title: row.title,
  status: row.status,
  decision: row.decision,
  reason: row.reason,
  consequences: row.consequences,
  rules: row.rules,
  version: row.version,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }),
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
});

const LEASE_COLUMNS = "repo, symbol, developer, agent, intent_id, reason, status, expires_at, created_at";
interface LeaseRow {
  repo: RepoId;
  symbol: string;
  developer: string;
  agent: string;
  intent_id: string | null;
  reason: string;
  status: Lease["status"];
  expires_at: Date;
  created_at: Date;
}
const leaseOf = (row: LeaseRow): Lease => ({
  repo: row.repo,
  symbol: row.symbol,
  holder: { developer: row.developer, agent: row.agent },
  ...(row.intent_id === null ? {} : { intentId: row.intent_id }),
  reason: row.reason,
  status: row.status,
  expiresAt: row.expires_at.toISOString(),
  createdAt: row.created_at.toISOString(),
});

const INTENT_COLUMNS = "id, repo, developer, agent, base_lsn::int as base_lsn, text, declared_symbols, status, heartbeat_at";
interface IntentRow {
  id: string;
  repo: RepoId;
  developer: string;
  agent: string;
  base_lsn: number;
  text: string;
  declared_symbols: string[];
  status: Intent["status"];
  heartbeat_at: Date;
}
const intentOf = (row: IntentRow): Intent => ({
  id: row.id,
  repo: row.repo,
  author: { developer: row.developer, agent: row.agent },
  baseLsn: row.base_lsn,
  text: row.text,
  declaredSymbols: row.declared_symbols,
  status: row.status,
  heartbeatAt: row.heartbeat_at.toISOString(),
});

/**
 * `latest`: the last change per path of repository $1 up to LSN $2, for the paths `where` keeps
 * (a condition on `path`); a rename also ends its old path there. Callers keep `op <> 'delete'`.
 */
const LATEST_FILES = (where: string): string =>
  `with changes as (
     select path, lsn, op, blob_hash from changeset_files where repo = $1 and lsn <= $2
     union all
     select from_path as path, lsn, 'delete' as op, null as blob_hash
     from changeset_files where repo = $1 and lsn <= $2 and from_path is not null
   ),
   latest as (select distinct on (path) path, op, blob_hash from changes where ${where} order by path, lsn desc)`;

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
  /** Selected only where an entry's intent is asked for (the query API). */
  intent_id?: string | null;
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
        // A key belongs to one repository: another repository's commit is never answered here.
        if (seenRow.repo !== repo) throw new InvalidCommit("idempotency key already used by another commit");
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
        const intent = await client.query("select 1 from intents where id = $1 and repo = $2", [req.intentId, repo]);
        if ((intent.rowCount ?? 0) === 0) throw new InvalidCommit(`unknown intent ${req.intentId}`);
      }

      // The validator runs here, under the lock, so nothing lands between its look at the gap and this append.
      const gap = decide ? await this.read(client, repo, gapStart(req), GAP_LIMIT + 1) : [];
      // Leases are read here, through this connection, under the lock acquireLease also takes.
      const decision = decide ? await decide(gap, lsn - 1, { leases: (now) => this.leasesIn(client, repo, now) }) : {};
      // The repository's brain version the commit was checked against (9.2): the decision says, else the current one.
      const brainVersion = decision.brainVersion ?? (await this.brainVersionIn(client, repo));

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
          brainVersion,
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
        // A stale intent whose agent came back and committed is closed too; only by its own author.
        await client.query(
          "update intents set status = 'committed' where id = $1 and repo = $2 and status in ('open', 'stale') and developer = $3 and agent = $4",
          [req.intentId, repo, req.author.developer, req.author.agent],
        );
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
    return this.tree(repo, lsn, "true", []);
  }

  async filesAt(repo: RepoId, lsn: Lsn, which: { paths?: string[]; globs?: string[] }): Promise<Tree> {
    const paths = which.paths ?? [];
    const globs = (which.globs ?? []).map(globToRegExpSource);
    if (paths.length === 0 && globs.length === 0) return new Map();
    return this.tree(repo, lsn, "(path = any($3::text[]) or path ~ any($4::text[]))", [paths, globs]);
  }

  async pathsAt(repo: RepoId, lsn: Lsn): Promise<string[]> {
    const rows = await this.pool.query<{ path: string }>(`${LATEST_FILES("true")} select path from latest where op <> 'delete' and blob_hash is not null order by path`, [repo, lsn]);
    return rows.rows.map((r) => r.path);
  }

  /** The tree at `lsn`, only the paths `where` keeps (a condition on `path`, parameters from $3). */
  private async tree(repo: RepoId, lsn: Lsn, where: string, params: unknown[]): Promise<Tree> {
    const rows = await this.pool.query<{ path: string; content: string }>(
      `${LATEST_FILES(where)}
       select l.path, convert_from(b.bytes, 'UTF8') as content
       from latest l join blobs b on b.hash = l.blob_hash
       where l.op <> 'delete' order by l.path`,
      [repo, lsn, ...params],
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
    const res = await this.pool.query<IntentRow>(
      `select ${INTENT_COLUMNS} from intents where repo = $1 and status = 'open' order by created_at, id`,
      [repo],
    );
    return res.rows.map(intentOf);
  }

  async getIntent(repo: RepoId, id: string): Promise<Intent | undefined> {
    const res = await this.pool.query<IntentRow>(`select ${INTENT_COLUMNS} from intents where repo = $1 and id = $2`, [repo, id]);
    const row = res.rows[0];
    return row === undefined ? undefined : intentOf(row);
  }

  async heartbeat(repo: RepoId, intentId: string): Promise<void> {
    // The intent only: leases are renewed by their holder asking again (acquireLease), never by a heartbeat anyone may send.
    await this.pool.query("update intents set heartbeat_at = now() where id = $1 and repo = $2 and status = 'open'", [intentId, repo]);
  }

  async markStaleIntents(before: Date): Promise<Intent[]> {
    const res = await this.pool.query<IntentRow>(
      `update intents set status = 'stale' where status = 'open' and heartbeat_at < $1 returning ${INTENT_COLUMNS}`,
      [before],
    );
    return res.rows.map(intentOf);
  }

  async proposeAdr(p: AdrProposal): Promise<Adr> {
    return this.tx(async (db) => {
      // Numbers count per repository; the brain lock keeps two proposals from taking the same one.
      await db.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`brain:${p.repo}`]);
      const known = await db.query("select 1 from repos where id = $1", [p.repo]);
      if ((known.rowCount ?? 0) === 0) throw unknownRepo(p.repo);
      const res = await db.query<AdrRow>(
        `insert into repo_adrs (repo, number, title, status, decision, reason, consequences, rules, created_by)
         values ($1, (select coalesce(max(number), 0) + 1 from repo_adrs where repo = $1), $2, 'proposed', $3, $4, $5, $6, $7)
         returning ${ADR_COLUMNS}`,
        [p.repo, p.title, p.decision, p.reason ?? "", p.consequences ?? "", JSON.stringify(p.rules ?? []), p.createdBy],
      );
      return adrOf(res.rows[0] as AdrRow);
    });
  }

  async listAdrs(repo: RepoId): Promise<Adr[]> {
    const res = await this.pool.query<AdrRow>(`select ${ADR_COLUMNS} from repo_adrs where repo = $1 order by number`, [repo]);
    return res.rows.map(adrOf);
  }

  async getAdr(repo: RepoId, number: number): Promise<Adr | undefined> {
    const res = await this.pool.query<AdrRow>(`select ${ADR_COLUMNS} from repo_adrs where repo = $1 and number = $2`, [repo, number]);
    const row = res.rows[0];
    return row === undefined ? undefined : adrOf(row);
  }

  async decideAdr(repo: RepoId, number: number, verdict: AdrVerdict, by: string): Promise<AdrChange> {
    return this.tx(async (db): Promise<AdrChange> => {
      // The status change and the version move are one transaction, serialised per repository.
      await db.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [`brain:${repo}`]);
      const found = await db.query<AdrRow>(`select ${ADR_COLUMNS} from repo_adrs where repo = $1 and number = $2 for update`, [repo, number]);
      const row = found.rows[0];
      if (row === undefined) return { ok: false, error: "not_found" };
      const adr = adrOf(row);
      if (adr.status !== ADR_TRANSITIONS[verdict]) return { ok: false, error: "invalid_transition", adr };
      let version = await this.brainVersionIn(db, repo);
      if (movesBrain(verdict)) {
        version += 1;
        await db.query("insert into repo_brain_versions (repo, version, adr_number, status, changed_by) values ($1, $2, $3, $4, $5)", [
          repo,
          version,
          number,
          verdict,
          by,
        ]);
      }
      const updated = await db.query<AdrRow>(
        `update repo_adrs set status = $3, version = case when $4::boolean then $5 else version end, decided_by = $6, decided_at = now()
         where repo = $1 and number = $2 returning ${ADR_COLUMNS}`,
        [repo, number, verdict, movesBrain(verdict), version, by],
      );
      return { ok: true, adr: adrOf(updated.rows[0] as AdrRow), version };
    });
  }

  brainVersion(repo: RepoId): Promise<number> {
    return this.brainVersionIn(this.pool, repo);
  }

  async adrsInForce(repo: RepoId, version: number): Promise<Adr[]> {
    // Each ADR's last move at or below `version`; in force when that move accepted it.
    const res = await this.pool.query<AdrRow>(
      `select ${ADR_COLUMNS.split(", ").map((c) => `a.${c}`).join(", ")}
       from repo_adrs a
       join lateral (
         select b.status from repo_brain_versions b
         where b.repo = a.repo and b.adr_number = a.number and b.version <= $2
         order by b.version desc limit 1
       ) last on true
       where a.repo = $1 and last.status = 'accepted'
       order by a.number`,
      [repo, version],
    );
    return res.rows.map(adrOf);
  }

  async acquireLease(req: LeaseRequest, now = new Date()): Promise<LeaseGrant> {
    return this.tx(async (db): Promise<LeaseGrant> => {
      // The append's own lock: a grant waits for a commit in flight on this repository, whose lease
      // check (under that lock) then saw every lease granted before it, and none granted during it.
      await db.query("select pg_advisory_xact_lock(hashtext($1)::bigint)", [req.repo]);
      const known = await db.query("select 1 from repos where id = $1", [req.repo]);
      if ((known.rowCount ?? 0) === 0) throw unknownRepo(req.repo);
      if (req.intentId !== undefined) {
        const intent = await db.query<{ status: string; developer: string; agent: string }>("select status, developer, agent from intents where id = $1 and repo = $2", [
          req.intentId,
          req.repo,
        ]);
        const row = intent.rows[0];
        if (row === undefined) throw new InvalidCommit(`unknown intent ${req.intentId}`);
        if (row.status !== "open") throw new InvalidCommit(`intent ${req.intentId} is ${row.status}, not open`);
        const owner = { developer: row.developer, agent: row.agent };
        if (!sameAuthor(owner, req.holder)) throw new InvalidCommit(notTheirIntent(req.intentId, owner, req.holder));
      }
      const expired = (
        await db.query<LeaseRow>(
          `update repo_leases set status = 'expired', ended_at = $3
           where repo = $1 and symbol = $2 and status = 'held' and expires_at <= $3 returning ${LEASE_COLUMNS}`,
          [req.repo, req.symbol, now],
        )
      ).rows.map(leaseOf);
      const expiresAt = new Date(now.getTime() + req.ttlSeconds * 1000);
      // The partial unique index decides: of two concurrent inserts, the second waits for the first
      // and then does nothing. A holder that released meanwhile frees the symbol for the second try.
      for (let attempt = 0; attempt < 2; attempt++) {
        const inserted = await db.query<LeaseRow>(
          `insert into repo_leases (repo, symbol, developer, agent, intent_id, reason, ttl_seconds, status, expires_at, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, 'held', $8, $9)
           on conflict (repo, symbol) where status = 'held' do nothing
           returning ${LEASE_COLUMNS}`,
          [req.repo, req.symbol, req.holder.developer, req.holder.agent, req.intentId ?? null, req.reason, req.ttlSeconds, expiresAt, now],
        );
        const row = inserted.rows[0];
        if (row !== undefined) return { granted: true, lease: leaseOf(row), renewed: false, expired };
        const held = await db.query<LeaseRow>(
          `select ${LEASE_COLUMNS} from repo_leases where repo = $1 and symbol = $2 and status = 'held' for update`,
          [req.repo, req.symbol],
        );
        const heldRow = held.rows[0];
        if (heldRow === undefined) continue;
        const lease = leaseOf(heldRow);
        if (!holdsLease(lease, req.holder, req.intentId)) return { granted: false, holder: lease, expired };
        const renewed = await db.query<LeaseRow>(
          `update repo_leases set expires_at = $3, reason = $4, ttl_seconds = $5, intent_id = coalesce($6, intent_id)
           where repo = $1 and symbol = $2 and status = 'held' returning ${LEASE_COLUMNS}`,
          [req.repo, req.symbol, expiresAt, req.reason, req.ttlSeconds, req.intentId ?? null],
        );
        return { granted: true, lease: leaseOf(renewed.rows[0] as LeaseRow), renewed: true, expired };
      }
      throw new Error(`the lease on ${req.symbol} changed hands twice while it was being taken; try again`);
    });
  }

  async releaseLease(repo: RepoId, symbol: SymbolId, now = new Date(), holder?: Author): Promise<Lease | undefined> {
    const res = await this.pool.query<LeaseRow>(
      `update repo_leases set status = 'released', ended_at = $3
       where repo = $1 and symbol = $2 and status = 'held' and ($4::text is null or (developer = $4 and agent = $5)) returning ${LEASE_COLUMNS}`,
      [repo, symbol, now, holder?.developer ?? null, holder?.agent ?? null],
    );
    const row = res.rows[0];
    return row === undefined ? undefined : leaseOf(row);
  }

  async releaseIntentLeases(repo: RepoId, intentId: string, now = new Date()): Promise<Lease[]> {
    const res = await this.pool.query<LeaseRow>(
      `update repo_leases set status = 'released', ended_at = $3 where repo = $1 and intent_id = $2 and status = 'held' returning ${LEASE_COLUMNS}`,
      [repo, intentId, now],
    );
    return res.rows.map(leaseOf);
  }

  async expireLeases(now = new Date()): Promise<Lease[]> {
    const res = await this.pool.query<LeaseRow>(
      `update repo_leases set status = 'expired', ended_at = $1 where status = 'held' and expires_at <= $1 returning ${LEASE_COLUMNS}`,
      [now],
    );
    return res.rows.map(leaseOf);
  }

  liveLeases(repo: RepoId, now = new Date()): Promise<Lease[]> {
    return this.leasesIn(this.pool, repo, now);
  }

  private async leasesIn(db: Queryable, repo: RepoId, now: Date): Promise<Lease[]> {
    const res = await db.query<LeaseRow>(
      `select ${LEASE_COLUMNS} from repo_leases where repo = $1 and status = 'held' and expires_at > $2 order by symbol collate "C"`,
      [repo, now],
    );
    return res.rows.map(leaseOf);
  }

  async findEntries(repo: RepoId, q: LogQuery): Promise<LoggedEntry[]> {
    const params: unknown[] = [repo, q.since ?? 0];
    const where = ["c.repo = $1", "c.lsn > $2"];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    if (q.before !== undefined) where.push(`c.lsn < ${param(q.before)}`);
    if (q.brainBefore !== undefined) where.push(`c.brain_version < ${param(q.brainBefore)}`);
    if (q.writes !== undefined) {
      where.push(`exists (select 1 from changeset_symbols s where s.repo = c.repo and s.lsn = c.lsn and s.symbol_id = ${param(q.writes)} and s.kind <> 'read')`);
    }
    if (q.reads !== undefined) {
      where.push(`exists (select 1 from changeset_symbols s where s.repo = c.repo and s.lsn = c.lsn and s.symbol_id = ${param(q.reads)} and s.kind = 'read')`);
    }
    if (q.touches !== undefined) {
      const re = param(globToRegExpSource(q.touches));
      where.push(`exists (select 1 from changeset_files f where f.repo = c.repo and f.lsn = c.lsn and (f.path ~ ${re} or f.from_path ~ ${re}))`);
    }
    if (q.paths !== undefined) {
      const paths = param(q.paths);
      where.push(`exists (select 1 from changeset_files f where f.repo = c.repo and f.lsn = c.lsn and (f.path = any(${paths}::text[]) or f.from_path = any(${paths}::text[])))`);
    }
    const res = await this.pool.query<{ lsn: number }>(
      `select c.lsn::int as lsn from changesets c where ${where.join(" and ")} order by c.lsn ${q.newestFirst ? "desc" : "asc"} limit ${param(q.limit)}`,
      params,
    );
    return this.load(
      repo,
      res.rows.map((r) => r.lsn),
      q.contents === true,
    );
  }

  async symbolStates(repo: RepoId, prefix: string, limit: number): Promise<SymbolState[]> {
    const res = await this.pool.query<{
      symbol_id: string;
      lsn: number;
      intent: string;
      intent_id: string | null;
      developer: string;
      agent: string;
      created_at: Date;
      signature: boolean;
    }>(
      `with last as (
         select symbol_id, max(lsn) as lsn from changeset_symbols
         where repo = $1 and kind <> 'read' and starts_with(symbol_id, $2)
         group by symbol_id
       )
       select l.symbol_id, l.lsn::int as lsn, c.intent, c.intent_id, c.developer, c.agent, c.created_at,
              exists (select 1 from changeset_symbols x
                      where x.repo = $1 and x.lsn = l.lsn and x.symbol_id = l.symbol_id and x.kind = 'sig_write') as signature
       from last l join changesets c on c.repo = $1 and c.lsn = l.lsn
       order by l.symbol_id collate "C" limit $3`,
      [repo, prefix, limit],
    );
    return res.rows.map((r) => ({
      symbol: r.symbol_id,
      lsn: r.lsn,
      signature: r.signature,
      intent: r.intent,
      ...(r.intent_id === null ? {} : { intentId: r.intent_id }),
      author: { developer: r.developer, agent: r.agent },
      createdAt: r.created_at.toISOString(),
    }));
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

  async upsertUser(input: UserInput): Promise<User> {
    const res = await this.pool.query<UserRow>(
      `insert into users (id, github_id, login, name, avatar_url) values ($1, $2, $3, $4, $5)
       on conflict (github_id) do update set login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url
       returning ${USER_COLUMNS}`,
      [newUserId(), input.githubId, input.login, input.name ?? null, input.avatarUrl ?? null],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error("user not readable after upsert");
    return userOf(row);
  }

  async getUser(id: string): Promise<User | undefined> {
    const res = await this.pool.query<UserRow>(`select ${USER_COLUMNS} from users where id = $1`, [id]);
    const row = res.rows[0];
    return row === undefined ? undefined : userOf(row);
  }

  async getUserByLogin(login: string): Promise<User | undefined> {
    // GitHub logins are case-insensitive.
    const res = await this.pool.query<UserRow>(`select ${USER_COLUMNS} from users where lower(login) = lower($1)`, [login]);
    const row = res.rows[0];
    return row === undefined ? undefined : userOf(row);
  }

  async createToken(userId: string, name: string): Promise<{ token: Token; secret: string }> {
    const secret = newTokenSecret();
    const res = await this.pool.query<TokenRow>(
      `insert into tokens (hash, id, user_id, name) values ($1, $2, $3, $4) returning ${TOKEN_COLUMNS}`,
      [tokenHash(secret), newTokenId(), userId, name],
    );
    const row = res.rows[0];
    if (row === undefined) throw new Error("token not readable after insert");
    return { token: tokenOf(row), secret };
  }

  async userForToken(secret: string): Promise<User | undefined> {
    const res = await this.pool.query<UserRow>(
      `update tokens set last_used_at = now() where hash = $1 and revoked_at is null returning user_id`,
      [tokenHash(secret)],
    );
    const userId = (res.rows[0] as unknown as { user_id?: string } | undefined)?.user_id;
    return userId === undefined ? undefined : this.getUser(userId);
  }

  async listTokens(userId: string): Promise<Token[]> {
    const res = await this.pool.query<TokenRow>(`select ${TOKEN_COLUMNS} from tokens where user_id = $1 order by created_at`, [userId]);
    return res.rows.map(tokenOf);
  }

  async revokeToken(userId: string, tokenId: string): Promise<boolean> {
    const res = await this.pool.query(
      "update tokens set revoked_at = now() where id = $1 and user_id = $2 and revoked_at is null",
      [tokenId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setMember(repo: RepoId, userId: string, role: Role): Promise<void> {
    const known = await this.pool.query("select 1 from repos where id = $1", [repo]);
    if ((known.rowCount ?? 0) === 0) throw unknownRepo(repo);
    await this.pool.query(
      `insert into repo_members (repo, user_id, role) values ($1, $2, $3)
       on conflict (repo, user_id) do update set role = excluded.role`,
      [repo, userId, role],
    );
  }

  async removeMember(repo: RepoId, userId: string): Promise<boolean> {
    const res = await this.pool.query("delete from repo_members where repo = $1 and user_id = $2", [repo, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async listMembers(repo: RepoId): Promise<Member[]> {
    const res = await this.pool.query<{ user_id: string; login: string; role: Role; resolver: boolean }>(
      `select m.user_id, u.login, m.role, m.resolver from repo_members m join users u on u.id = m.user_id
       where m.repo = $1 order by u.login`,
      [repo],
    );
    return res.rows.map((r) => ({ repo, userId: r.user_id, login: r.login, role: r.role, resolver: r.resolver }));
  }

  async roleOf(repo: RepoId, userId: string): Promise<Role | undefined> {
    const res = await this.pool.query<{ role: Role }>("select role from repo_members where repo = $1 and user_id = $2", [repo, userId]);
    return res.rows[0]?.role;
  }

  async setResolver(repo: RepoId, userId: string, resolver: boolean): Promise<boolean> {
    const res = await this.pool.query("update repo_members set resolver = $3 where repo = $1 and user_id = $2", [repo, userId, resolver]);
    return (res.rowCount ?? 0) > 0;
  }

  async setInvite(repo: RepoId, login: string, role: Role, invitedBy?: string): Promise<void> {
    const known = await this.pool.query("select 1 from repos where id = $1", [repo]);
    if ((known.rowCount ?? 0) === 0) throw unknownRepo(repo);
    await this.pool.query(
      `insert into repo_invites (repo, login, role, invited_by) values ($1, lower($2), $3, $4)
       on conflict (repo, login) do update set role = excluded.role`,
      [repo, login, role, invitedBy ?? null],
    );
  }

  async listInvites(repo: RepoId): Promise<Invite[]> {
    const res = await this.pool.query<{ login: string; role: Role; created_at: Date }>(
      "select login, role, created_at from repo_invites where repo = $1 order by login",
      [repo],
    );
    return res.rows.map((r) => ({ repo, login: r.login, role: r.role, createdAt: r.created_at.toISOString() }));
  }

  async deleteInvite(repo: RepoId, login: string): Promise<boolean> {
    const res = await this.pool.query("delete from repo_invites where repo = $1 and login = lower($2)", [repo, login]);
    return (res.rowCount ?? 0) > 0;
  }

  async park(input: ParkInput): Promise<Parked> {
    const known = await this.pool.query("select 1 from repos where id = $1", [input.repo]);
    if ((known.rowCount ?? 0) === 0) throw unknownRepo(input.repo);
    const res = await this.pool.query<ParkedRow>(
      `insert into parked_commits (id, repo, user_id, author_developer, author_agent, request, skew, conflicts_with, head_lsn)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning ${PARKED_COLUMNS}`,
      [
        newParkedId(),
        input.repo,
        input.userId ?? null,
        input.request.author.developer,
        input.request.author.agent,
        JSON.stringify(input.request),
        input.skew,
        input.conflictsWith,
        input.headLsn,
      ],
    );
    return parkedOf(res.rows[0] as ParkedRow);
  }

  async listParked(repo: RepoId): Promise<Parked[]> {
    const res = await this.pool.query<ParkedRow>(`select ${PARKED_COLUMNS} from parked_commits where repo = $1 order by created_at desc, id desc`, [repo]);
    return res.rows.map(parkedOf);
  }

  async getParked(repo: RepoId, id: string): Promise<Parked | undefined> {
    const res = await this.pool.query<ParkedRow>(`select ${PARKED_COLUMNS} from parked_commits where repo = $1 and id = $2`, [repo, id]);
    const row = res.rows[0];
    return row === undefined ? undefined : parkedOf(row);
  }

  async openParkedBy(repo: RepoId, author: Author): Promise<Parked | undefined> {
    const res = await this.pool.query<ParkedRow>(
      `select ${PARKED_COLUMNS} from parked_commits
       where repo = $1 and status = 'open' and author_developer = $2 and author_agent = $3 limit 1`,
      [repo, author.developer, author.agent],
    );
    const row = res.rows[0];
    return row === undefined ? undefined : parkedOf(row);
  }

  async decideParked(repo: RepoId, id: string, decision: ParkDecision): Promise<boolean> {
    const res = await this.pool.query(
      `update parked_commits set status = $3, decided_by = $4, note = $5, landed_lsn = $6, decided_at = now()
       where repo = $1 and id = $2 and status = 'open'`,
      [repo, id, decision.status, decision.decidedBy, decision.note ?? null, decision.landedLsn ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async acceptInvites(user: User): Promise<RepoId[]> {
    const res = await this.pool.query<{ repo: RepoId }>(
      `with moved as (delete from repo_invites where login = lower($2) returning repo, role)
       insert into repo_members (repo, user_id, role) select repo, $1, role from moved
       on conflict (repo, user_id) do nothing
       returning repo`,
      [user.id, user.login],
    );
    return res.rows.map((r) => r.repo);
  }

  async visibility(repo: RepoId): Promise<Visibility | undefined> {
    const res = await this.pool.query<{ visibility: Visibility }>("select visibility from repos where id = $1", [repo]);
    return res.rows[0]?.visibility;
  }

  async setVisibility(repo: RepoId, visibility: Visibility): Promise<void> {
    const res = await this.pool.query("update repos set visibility = $2 where id = $1", [repo, visibility]);
    if ((res.rowCount ?? 0) === 0) throw unknownRepo(repo);
  }

  /** Runs `fn` in one transaction on one connection. */
  private async tx<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async brainVersionIn(db: Queryable, repo: RepoId): Promise<number> {
    const res = await db.query<{ version: number }>("select coalesce(max(version), 0)::int as version from repo_brain_versions where repo = $1", [repo]);
    return res.rows[0]?.version ?? 0;
  }

  private async head(db: Queryable, repo: RepoId): Promise<Lsn> {
    const res = await db.query<{ head: number }>("select coalesce(max(lsn), 0)::int as head from changesets where repo = $1", [repo]);
    return res.rows[0]?.head ?? 0;
  }

  /** The entries at these LSNs, in the order given, with the intent each closed; file contents only when asked for. */
  private async load(repo: RepoId, lsns: Lsn[], contents: boolean): Promise<LoggedEntry[]> {
    if (lsns.length === 0) return [];
    const heads = await this.pool.query<ChangesetRow>(
      `select repo, lsn::int as lsn, base_lsn::int as base_lsn, developer, agent, intent, repairs, checks,
              brain_version, created_at, intent_id
       from changesets where repo = $1 and lsn = any($2::bigint[])`,
      [repo, lsns],
    );
    const byLsn = new Map((await this.hydrate(this.pool, repo, heads.rows, contents)).map((e) => [e.lsn, e]));
    return lsns.flatMap((lsn) => {
      const entry = byLsn.get(lsn);
      return entry === undefined ? [] : [entry];
    });
  }

  private async read(db: Queryable, repo: RepoId, fromLsn: Lsn, limit: number): Promise<Changeset[]> {
    const heads = await db.query<ChangesetRow>(
      `select repo, lsn::int as lsn, base_lsn::int as base_lsn, developer, agent, intent, repairs, checks,
              brain_version, created_at
       from changesets where repo = $1 and lsn > $2 order by lsn limit $3`,
      [repo, fromLsn, limit],
    );
    return this.hydrate(db, repo, heads.rows);
  }

  /** Changesets from their rows: files (with contents, unless `contents` is false) and symbol sets read in two queries. */
  private async hydrate(db: Queryable, repo: RepoId, rows: ChangesetRow[], contents = true): Promise<LoggedEntry[]> {
    if (rows.length === 0) return [];
    const heads = { rows };
    const lsns = heads.rows.map((r) => r.lsn);
    const files = await db.query<FileRow>(
      contents
        ? `select f.lsn::int as lsn, f.path, f.op, f.blob_hash, f.from_path, convert_from(b.bytes, 'UTF8') as content
           from changeset_files f left join blobs b on b.hash = f.blob_hash
           where f.repo = $1 and f.lsn = any($2::bigint[]) order by f.lsn, f.path`
        : `select f.lsn::int as lsn, f.path, f.op, f.blob_hash, f.from_path, null::text as content
           from changeset_files f where f.repo = $1 and f.lsn = any($2::bigint[]) order by f.lsn, f.path`,
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
        ...(row.intent_id === undefined || row.intent_id === null ? {} : { intentId: row.intent_id }),
      };
    });
  }
}
