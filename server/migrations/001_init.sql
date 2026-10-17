-- Pitstop initial schema. Design reference: section 5.4 (server tables) and section 10 (semantic index).
-- Applied once by src/migrate.ts; never edit an applied migration, add 002_*.sql instead.

-- pgvector: on Azure the extension must be allowlisted (infra/main.bicep sets azure.extensions = VECTOR).
create extension if not exists vector;

-- The write-ahead log. Append-only: rows are never updated or deleted.
create table changesets (
  lsn            bigint primary key,
  base_lsn       bigint not null check (base_lsn < lsn),
  idempotency_key text not null unique,
  developer      text not null,
  agent          text not null,
  intent         text not null,
  repairs        jsonb not null default '[]',
  checks         jsonb not null,
  brain_version  integer not null,
  created_at     timestamptz not null default now()
);

create table changeset_files (
  lsn        bigint not null references changesets (lsn),
  path       text not null,
  op         text not null check (op in ('add', 'modify', 'delete', 'rename')),
  blob_hash  text,
  from_path  text,
  primary key (lsn, path)
);

-- Read and write sets, one row per symbol per changeset.
create table changeset_symbols (
  lsn        bigint not null references changesets (lsn),
  symbol_id  text not null,
  kind       text not null check (kind in ('read', 'write', 'sig_write')),
  primary key (lsn, symbol_id, kind)
);
-- The validator's main question: "which entries after LSN n wrote symbol X?"
create index changeset_symbols_by_symbol on changeset_symbols (symbol_id, lsn) where kind <> 'read';

-- File contents, addressed by hash. Large repos can move bytes to blob storage later.
create table blobs (
  hash   text primary key,
  bytes  bytea not null
);

-- Current state of every symbol at trunk (derived data, rebuildable from the log).
create table symbols (
  symbol_id       text primary key,
  path            text not null,
  sig_hash        text not null,
  body_hash       text not null,
  last_write_lsn  bigint not null references changesets (lsn)
);
create index symbols_by_path on symbols (path);

-- Call and import graph at trunk (derived data).
create table symbol_edges (
  from_symbol  text not null,
  to_symbol    text not null,
  primary key (from_symbol, to_symbol)
);
create index symbol_edges_by_target on symbol_edges (to_symbol);

-- Open transactions: the catalog's live view (section 9.3).
create table intents (
  id                text primary key,
  developer         text not null,
  agent             text not null,
  base_lsn          bigint not null,
  text              text not null,
  declared_symbols  text[] not null default '{}',
  status            text not null check (status in ('open', 'committed', 'abandoned', 'stale')),
  heartbeat_at      timestamptz not null default now(),
  created_at        timestamptz not null default now()
);
create index intents_open on intents (status) where status = 'open';

-- Optional short locks on hot symbols (section 9.4). The primary key guarantees one holder.
create table leases (
  symbol_id      text primary key,
  holder_intent  text not null references intents (id),
  expires_at     timestamptz not null
);

-- Architecture decisions and their checkable rules (section 9.1).
create table adrs (
  id       text not null,
  version  integer not null,
  status   text not null check (status in ('proposed', 'accepted', 'superseded')),
  title    text not null,
  text     text not null,
  rules    jsonb not null default '[]',
  primary key (id, version)
);

-- Brain version: increases with every accepted ADR change.
create table brain_versions (
  version     integer primary key,
  changed_at  timestamptz not null default now(),
  note        text
);
insert into brain_versions (version, note) values (0, 'initial');

-- Semantic index (section 10). 1536 dimensions matches Azure OpenAI text-embedding-3-small;
-- change the dimension in a new migration if you pick another model.
create table symbol_embeddings (
  symbol_id   text primary key,
  summary     text not null,
  embedding   vector(1536) not null,
  updated_lsn bigint not null
);
create index symbol_embeddings_hnsw on symbol_embeddings using hnsw (embedding vector_cosine_ops);
