-- Accounts (build plan, Phase 5, the hosted layer): people sign in with GitHub, hold personal
-- tokens their daemons send, and are members of repositories with a role.
create table users (
  id          text primary key,          -- u_<8 hex>
  github_id   bigint not null unique,
  login       text not null unique,      -- the GitHub login, also author.developer on commits
  name        text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create table tokens (
  hash          text primary key,        -- sha256 of the secret; the secret itself is shown once
  id            text not null unique,    -- t_<8 hex>, for listing and revoking
  user_id       text not null references users (id),
  name          text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
create index tokens_by_user on tokens (user_id);

create table repo_members (
  repo     text not null references repos (id),
  user_id  text not null references users (id),
  role     text not null check (role in ('owner', 'writer', 'reader')),
  primary key (repo, user_id)
);
create index repo_members_by_user on repo_members (user_id);

-- A repository without members is open to any signed identity (local/default, self-hosting).
alter table repos add column visibility text not null default 'private' check (visibility in ('private', 'public'));
