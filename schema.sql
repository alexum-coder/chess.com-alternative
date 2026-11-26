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
alter table tournament_matches add column if not exists game_state jsonb;
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

-- Profile data (especially provisional ratings) is served through Express APIs only.
drop policy if exists "profiles are public" on profiles;
drop policy if exists "games are public" on games;
create policy "games are public" on games for select using (true);


-- Finalizing a game and updating both ratings must be one transaction. The unique
-- games.id is the idempotency key used by tournament recovery after a process crash.
create or replace function public.finalize_chess_game(
  p_game_id text,
  p_white_id uuid,
  p_black_id uuid,
  p_white_name text,
  p_black_name text,
  p_result text,
  p_reason text,
  p_pgn text,
  p_base int,
  p_inc int,
  p_white_rating int,
  p_white_deviation double precision,
  p_white_volatility double precision,
  p_white_games int,
  p_black_rating int,
  p_black_deviation double precision,
  p_black_volatility double precision,
  p_black_games int
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted_game_id text;
begin
  insert into games (id, white, black, white_name, black_name, result, reason, pgn, base, inc)
  values (p_game_id, p_white_id, p_black_id, p_white_name, p_black_name, p_result, p_reason, p_pgn, p_base, p_inc)
  on conflict (id) do nothing
  returning id into inserted_game_id;

  if inserted_game_id is null then
    return false;
  end if;

  if p_white_id is not null then
    update profiles set rating = p_white_rating, rating_deviation = p_white_deviation,
      volatility = p_white_volatility, games_played = p_white_games where id = p_white_id;
  end if;
  if p_black_id is not null then
    update profiles set rating = p_black_rating, rating_deviation = p_black_deviation,
      volatility = p_black_volatility, games_played = p_black_games where id = p_black_id;
  end if;

  return true;
end;
$$;

revoke all on function public.finalize_chess_game(text, uuid, uuid, text, text, text, text, text, int, int, int, double precision, double precision, int, int, double precision, double precision, int) from public;
revoke all on function public.finalize_chess_game(text, uuid, uuid, text, text, text, text, text, int, int, int, double precision, double precision, int, int, double precision, double precision, int) from anon, authenticated;
grant execute on function public.finalize_chess_game(text, uuid, uuid, text, text, text, text, text, int, int, int, double precision, double precision, int, int, double precision, double precision, int) to service_role;

-- Lichess open puzzle database (CC0). Import with: npm run import:puzzles -- /path/to/lichess_db_puzzle.csv.zst
create table if not exists public.puzzles (
  puzzle_id text primary key,
  fen text not null,
  moves text not null,
  rating integer not null default 1500,
  themes text[] not null default '{}',
  game_url text,
  created_at timestamptz not null default now()
);
create index if not exists puzzles_rating_idx on public.puzzles(rating);
alter table public.puzzles enable row level security;
drop policy if exists "Puzzles are publicly readable" on public.puzzles;
create policy "Puzzles are publicly readable" on public.puzzles for select using (true);

-- Private per-account puzzle rating and progress. Browser access is intentionally denied;
-- the authenticated Express backend reads and writes these with the Supabase service role.
alter table public.profiles add column if not exists puzzle_rating integer not null default 1200;
create table if not exists public.puzzle_progress (
  player_id uuid not null references public.profiles(id) on delete cascade,
  puzzle_id text not null references public.puzzles(puzzle_id) on delete cascade,
  status text not null default 'failed' check (status in ('failed', 'solved')),
  attempts integer not null default 1 check (attempts >= 1),
  rating_change integer not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (player_id, puzzle_id)
);
alter table public.puzzle_progress enable row level security;
revoke all on table public.puzzle_progress from public, anon, authenticated;
grant select, insert, update, delete on table public.puzzle_progress to service_role;
create index if not exists puzzles_rating_id_idx on public.puzzles(rating, puzzle_id);
create index if not exists puzzles_id_rating_idx on public.puzzles(puzzle_id, rating);

create or replace function public.record_puzzle_miss(p_player_id uuid, p_puzzle_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.profiles where id = p_player_id for update;
  if not found then raise exception 'Puzzle player profile not found'; end if;
  insert into public.puzzle_progress as saved_progress (player_id, puzzle_id, status, attempts)
  values (p_player_id, p_puzzle_id, 'failed', 1)
  on conflict (player_id, puzzle_id) do update
    set status = case when saved_progress.status = 'solved' then 'solved' else 'failed' end,
        attempts = case when saved_progress.status = 'solved' then saved_progress.attempts else saved_progress.attempts + 1 end,
        updated_at = now();
  return jsonb_build_object('saved', true);
end;
$$;

create or replace function public.complete_puzzle(p_player_id uuid, p_puzzle_id text, p_clean_attempt boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_rating integer; v_status text; v_delta integer := 5;
begin
  select puzzle_rating into v_rating from public.profiles where id = p_player_id for update;
  if not found then raise exception 'Puzzle player profile not found'; end if;
  perform 1 from public.puzzles where puzzle_id = p_puzzle_id;
  if not found then raise exception 'Puzzle not found'; end if;
  select status into v_status from public.puzzle_progress where player_id = p_player_id and puzzle_id = p_puzzle_id for update;
  if v_status = 'solved' then
    return jsonb_build_object('awarded', false, 'delta', 0, 'rating', v_rating, 'reason', 'already_completed');
  end if;
  if v_status = 'failed' or not p_clean_attempt then
    insert into public.puzzle_progress as saved_progress (player_id, puzzle_id, status, attempts, rating_change, completed_at)
    values (p_player_id, p_puzzle_id, 'solved', 1, 0, now())
    on conflict (player_id, puzzle_id) do update set status = 'solved', attempts = saved_progress.attempts + 1, rating_change = 0, completed_at = now(), updated_at = now();
    return jsonb_build_object('awarded', false, 'delta', 0, 'rating', v_rating, 'reason', 'attempt_had_mistake');
  end if;
  insert into public.puzzle_progress as saved_progress (player_id, puzzle_id, status, attempts, rating_change, completed_at)
  values (p_player_id, p_puzzle_id, 'solved', 1, v_delta, now());
  update public.profiles set puzzle_rating = puzzle_rating + v_delta where id = p_player_id returning puzzle_rating into v_rating;
  return jsonb_build_object('awarded', true, 'delta', v_delta, 'rating', v_rating, 'reason', 'first_try_solved');
end;
$$;
revoke all on function public.record_puzzle_miss(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_puzzle(uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.record_puzzle_miss(uuid, text) to service_role;
grant execute on function public.complete_puzzle(uuid, text, boolean) to service_role;

-- Explicit API privileges. New Supabase projects may not automatically grant access
-- to newly-created public tables. RLS policies do not replace PostgreSQL GRANTs.
-- The Express backend uses SUPABASE_SERVICE_KEY, so grant it DML access to the
-- application tables and sequences. Keep moderation/social/tournament writes server-only.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;
-- Future tables created by the role running this script inherit backend access too.
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select, update on sequences to service_role;

-- These two datasets are explicitly public-read through their existing RLS policies.
grant select on table public.puzzles to anon, authenticated;
grant select on table public.games to anon, authenticated;
