-- Run this once in Supabase: Dashboard > SQL Editor > New query > paste > Run.
create table if not exists profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  rating int not null default 1200,
  games_played int not null default 0,
  created_at timestamptz not null default now()
);

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

-- Anyone can read; only the server (service key) can write.
alter table profiles enable row level security;
alter table games enable row level security;
create policy "profiles are public" on profiles for select using (true);
create policy "games are public" on games for select using (true);
