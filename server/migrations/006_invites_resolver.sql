-- The hosted MVP (18 October 2026): inviting people who have not signed in yet, and the
-- repository member who decides on conflicts.

-- An owner invites a GitHub login with a role; the invite turns into membership the first time
-- that login signs in (or at once, when the user exists already).
create table repo_invites (
  repo        text not null references repos (id),
  login       text not null,                 -- the GitHub login, lowercased
  role        text not null check (role in ('owner', 'writer', 'reader')),
  invited_by  text references users (id),
  created_at  timestamptz not null default now(),
  primary key (repo, login)
);
create index repo_invites_by_login on repo_invites (login);

-- Members the repository's conflicts go to (the resolver). None set: its owners decide.
alter table repo_members add column resolver boolean not null default false;
