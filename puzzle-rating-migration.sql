-- Run once in Supabase SQL Editor when deploying private puzzle ratings.
-- Safe to run repeatedly. Requires the public.puzzles table from schema.sql.

alter table public.profiles
  add column if not exists puzzle_rating integer not null default 1200;

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
grant usage on schema public to service_role;

create or replace function public.record_puzzle_miss(p_player_id uuid, p_puzzle_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.profiles where id = p_player_id for update;
  if not found then raise exception 'Puzzle player profile not found'; end if;

  insert into public.puzzle_progress as saved_progress (player_id, puzzle_id, status, attempts)
  values (p_player_id, p_puzzle_id, 'failed', 1)
  on conflict (player_id, puzzle_id) do update
    set status = case when saved_progress.status = 'solved' then 'solved' else 'failed' end,
        attempts = case when saved_progress.status = 'solved'
          then saved_progress.attempts else saved_progress.attempts + 1 end,
        updated_at = now();

  return jsonb_build_object('saved', true);
end;
$$;

create or replace function public.complete_puzzle(
  p_player_id uuid,
  p_puzzle_id text,
  p_clean_attempt boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rating integer;
  v_status text;
  v_delta integer := 5;
begin
  -- Serialize completions/misses for this account so a duplicate submission cannot award twice.
  select puzzle_rating into v_rating
    from public.profiles where id = p_player_id for update;
  if not found then raise exception 'Puzzle player profile not found'; end if;
  perform 1 from public.puzzles where puzzle_id = p_puzzle_id;
  if not found then raise exception 'Puzzle not found'; end if;

  select status into v_status
    from public.puzzle_progress
    where player_id = p_player_id and puzzle_id = p_puzzle_id
    for update;

  if v_status = 'solved' then
    return jsonb_build_object('awarded', false, 'delta', 0, 'rating', v_rating, 'reason', 'already_completed');
  end if;

  if v_status = 'failed' or not p_clean_attempt then
    insert into public.puzzle_progress as saved_progress (player_id, puzzle_id, status, attempts, rating_change, completed_at)
    values (p_player_id, p_puzzle_id, 'solved', 1, 0, now())
    on conflict (player_id, puzzle_id) do update
      set status = 'solved', attempts = saved_progress.attempts + 1,
          rating_change = 0, completed_at = now(), updated_at = now();
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

create index if not exists puzzles_rating_id_idx on public.puzzles(rating, puzzle_id);
create index if not exists puzzles_id_rating_idx on public.puzzles(puzzle_id, rating);
