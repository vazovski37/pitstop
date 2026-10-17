-- One server, many repositories (build plan, "Beyond the demo"). LSNs count per repository, so
-- every log table is keyed by (repo, lsn). Rows from before belong to local/default.
create table repos (
  id          text primary key,   -- owner/name, lowercase: RepoId in @pitstop/protocol
  created_at  timestamptz not null default now()
);
insert into repos (id) values ('local/default');

alter table changesets add column repo text not null default 'local/default' references repos (id);
alter table changeset_files add column repo text not null default 'local/default';
alter table changeset_symbols add column repo text not null default 'local/default';
alter table intents add column repo text not null default 'local/default' references repos (id);
alter table symbols add column repo text not null default 'local/default';
alter table symbol_edges add column repo text not null default 'local/default';
alter table symbol_embeddings add column repo text not null default 'local/default';

-- Re-key: everything that pointed at changesets (lsn) now points at changesets (repo, lsn).
alter table changeset_files drop constraint changeset_files_lsn_fkey;
alter table changeset_symbols drop constraint changeset_symbols_lsn_fkey;
alter table symbols drop constraint symbols_last_write_lsn_fkey;
alter table changesets drop constraint changesets_pkey;
alter table changesets add primary key (repo, lsn);

alter table changeset_files drop constraint changeset_files_pkey;
alter table changeset_files add primary key (repo, lsn, path);
alter table changeset_files add foreign key (repo, lsn) references changesets (repo, lsn);

alter table changeset_symbols drop constraint changeset_symbols_pkey;
alter table changeset_symbols add primary key (repo, lsn, symbol_id, kind);
alter table changeset_symbols add foreign key (repo, lsn) references changesets (repo, lsn);
-- The validator's question, per repository: "which entries after LSN n wrote symbol X?"
drop index changeset_symbols_by_symbol;
create index changeset_symbols_by_symbol on changeset_symbols (repo, symbol_id, lsn) where kind <> 'read';

alter table symbols drop constraint symbols_pkey;
alter table symbols add primary key (repo, symbol_id);
alter table symbols add foreign key (repo, last_write_lsn) references changesets (repo, lsn);

alter table symbol_edges drop constraint symbol_edges_pkey;
alter table symbol_edges add primary key (repo, from_symbol, to_symbol);

alter table symbol_embeddings drop constraint symbol_embeddings_pkey;
alter table symbol_embeddings add primary key (repo, symbol_id);

-- The defaults carried the existing rows over; new log rows must say which repository.
alter table changesets alter column repo drop default;
alter table changeset_files alter column repo drop default;
alter table changeset_symbols alter column repo drop default;
alter table intents alter column repo drop default;
