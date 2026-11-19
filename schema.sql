-- Run this in Supabase: Dashboard > SQL Editor > New query > paste > Run.
-- Safe to run again when upgrading an existing Zugzwang database.

create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  rating int not null default 1200,
  rating_deviation double precision not null default 350,
  volatility double precision not null default 0.06,
  games_played int not null default 0,
  created_at timestamptz not null default now()
);

alter table profiles add column if not exists rating_deviation double precision not null default 350;
alter table profiles add column if not exists volatility double precision not null default 0.06;

create table if not exists games (
  id text primary key,
  white uuid references profiles(id) on delete set null,
  black uuid references profiles(id) on delete set null,
  white_name text not null,
  black_name text not null,
  result text not null,
  reason text not null,
  pgn text not null,
  base int not null,
  inc int not null,
  created_at timestamptz not null default now()
);

-- Friend requests and accepted friendships share one row. Requests are private to the server.
create table if not exists friendships (
  id bigint generated always as identity primary key,
  requester_id uuid not null references profiles(id) on delete cascade,
  addressee_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friendships_not_self check (requester_id <> addressee_id),
  constraint friendships_unique_direction unique (requester_id, addressee_id)
);
create index if not exists friendships_addressee_status on friendships(addressee_id, status);
create index if not exists friendships_requester_status on friendships(requester_id, status);

-- Single-elimination brackets; matches link back to the authoritative chess games.
create table if not exists tournaments (
  id text primary key,
  name text not null,
  creator_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'running', 'paused', 'completed')),
  base int not null default 300,
  inc int not null default 0,
  max_players int not null default 8 check (max_players between 2 and 16),
  winner_id uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists tournament_players (
  tournament_id text not null references tournaments(id) on delete cascade,
  player_id uuid not null references profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (tournament_id, player_id)
);
create table if not exists tournament_matches (
  id text primary key,
  tournament_id text not null references tournaments(id) on delete cascade,
  round int not null,
  player_a uuid references profiles(id) on delete set null,
  player_b uuid references profiles(id) on delete set null,
  game_id text,
  winner_id uuid references profiles(id) on delete set null,
  result text,
  status text not null default 'pending' check (status in ('pending', 'playing', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists tournament_matches_round on tournament_matches(tournament_id, round);

-- Reports are reviewed by human moderators. Signals are review queues, never automatic bans.
create table if not exists moderation_reports (
  id bigint generated always as identity primary key,
  reporter_id uuid references profiles(id) on delete set null,
  reported_id uuid references profiles(id) on delete set null,
  game_id text,
  reason text not null,
  status text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  reviewed_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists moderation_reports_status on moderation_reports(status, created_at desc);

create table if not exists moderation_actions (
  id bigint generated always as identity primary key,
  moderator_id uuid references profiles(id) on delete set null,
  target_id uuid not null references profiles(id) on delete cascade,
  action text not null check (action in ('warn', 'mute', 'ban')),
  reason text not null default '',
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists moderation_actions_target on moderation_actions(target_id, action, active);

create table if not exists integrity_flags (
  id bigint generated always as identity primary key,
  game_id text not null,
  player_id uuid references profiles(id) on delete set null,
  signal text not null,
  details jsonb not null default '{}'::jsonb,
  reviewed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists integrity_flags_reviewed on integrity_flags(reviewed, created_at desc);

-- Browser clients may read public profile summaries and games. All writes to social,
-- tournament, and moderation tables go through the Express server's service role.
alter table profiles enable row level security;
alter table games enable row level security;
alter table friendships enable row level security;
alter table tournaments enable row level security;
alter table tournament_players enable row level security;
alter table tournament_matches enable row level security;
alter table moderation_reports enable row level security;
alter table moderation_actions enable row level security;
alter table integrity_flags enable row level security;

drop policy if exists "profiles are public" on profiles;
create policy "profiles are public" on profiles for select using (true);
drop policy if exists "games are public" on games;
create policy "games are public" on games for select using (true);
