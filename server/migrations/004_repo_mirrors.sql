-- A GitHub mirror per repository (build plan, Phase 3): every accepted entry becomes a commit on a
-- branch of a GitHub repository. An export of the log, never the truth; CI and deploys read it.
create table repo_mirrors (
  repo         text primary key references repos (id),
  github_repo  text not null,                -- owner/name on github.com
  branch       text not null,
  base_commit  text not null,                -- the commit the first mirrored entry builds on
  last_lsn     bigint not null default 0,    -- the last entry pushed
  last_commit  text not null,                -- its commit (base_commit until something is pushed)
  status       text not null default 'enabled' check (status in ('enabled', 'diverged', 'error')),
  error        text,
  updated_at   timestamptz not null default now()
);
