-- The brain (design doc section 9), per repository: architecture decisions with checkable rules,
-- the brain version they move, and short leases on hot symbols. 001's adrs, leases and
-- brain_versions were global and never used; they stay (an applied migration is never edited) and
-- nothing reads them.

-- ADR-<number> of a repository (9.1). `rules` holds AdrRule objects from @pitstop/protocol.
create table repo_adrs (
  repo          text not null references repos (id),
  number        integer not null check (number > 0),
  title         text not null,
  status        text not null check (status in ('proposed', 'accepted', 'superseded', 'rejected')),
  decision      text not null,
  reason        text not null default '',
  consequences  text not null default '',
  rules         jsonb not null default '[]',
  version       integer not null default 0,     -- the brain version its last status change produced
  created_by    text not null,
  created_at    timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz,
  primary key (repo, number)
);

-- The brain version of a repository (9.2): one row per move, made by accepting or superseding an
-- ADR. The current version is the highest; the rules in force at version v are the ADRs whose last
-- row at or below v says accepted. Changesets record the version they were validated against.
create table repo_brain_versions (
  repo        text not null references repos (id),
  version     integer not null check (version > 0),
  adr_number  integer not null,
  status      text not null check (status in ('accepted', 'superseded')),
  changed_by  text not null,
  changed_at  timestamptz not null default now(),
  primary key (repo, version),
  foreign key (repo, adr_number) references repo_adrs (repo, number)
);
create index repo_brain_versions_by_adr on repo_brain_versions (repo, adr_number, version);

-- Leases (9.4): a short, expiring lock on one symbol. Rows stay after release or expiry, as history.
create table repo_leases (
  id           bigint generated always as identity primary key,
  repo         text not null references repos (id),
  symbol       text not null,                  -- path#qualified.name
  developer    text not null,
  agent        text not null,
  intent_id    text references intents (id),   -- committing or abandoning it releases the lease
  reason       text not null default '',
  ttl_seconds  integer not null check (ttl_seconds > 0),
  status       text not null check (status in ('held', 'released', 'expired')),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  ended_at     timestamptz
);
-- Exactly one holder: the database, not the server process, refuses a second held lease.
create unique index repo_leases_one_holder on repo_leases (repo, symbol) where status = 'held';
create index repo_leases_by_intent on repo_leases (intent_id) where status = 'held';
create index repo_leases_held_expiry on repo_leases (expires_at) where status = 'held';

-- The stale-intent sweep (9.3) looks for open intents by heartbeat.
create index intents_open_heartbeat on intents (heartbeat_at) where status = 'open';

-- The query API (section 10): "which entries read this symbol" (callers) and "which touched this path" (why).
create index changeset_symbols_reads on changeset_symbols (repo, symbol_id, lsn) where kind = 'read';
create index changeset_files_by_path on changeset_files (repo, path, lsn);
