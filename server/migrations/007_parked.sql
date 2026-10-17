-- The hosted MVP (18 October 2026): a commit with write skew waits for a member of the
-- repository (its resolvers, else its owners), who lets it through or sends it back.
create table parked_commits (
  id                text primary key,                -- pk_<8 hex>
  repo              text not null references repos (id),
  user_id           text references users (id),      -- the committer, when a signed-in user
  author_developer  text not null,
  author_agent      text not null,
  request           jsonb not null,                  -- the CommitRequest as sent, file contents included
  skew              text not null,                   -- what the validator found, for people
  conflicts_with    integer[] not null,
  head_lsn          integer not null,                -- the head when it was parked
  status            text not null default 'open' check (status in ('open', 'accepted', 'sent_back')),
  note              text,                            -- the resolver's word to the committer
  decided_by        text,                            -- the resolver's login
  landed_lsn        integer,
  created_at        timestamptz not null default now(),
  decided_at        timestamptz
);
create index parked_by_repo on parked_commits (repo, status);
