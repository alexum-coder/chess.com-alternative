-- Run once in Supabase SQL Editor to repair an EXISTING Zugzwang database.
-- Safe to run repeatedly. This fixes missing Postgres grants; it does not weaken RLS.

grant usage on schema public to service_role;

grant select, insert, update, delete
on all tables in schema public
to service_role;

grant usage, select, update
on all sequences in schema public
to service_role;

-- Apply to future public tables/sequences created by the role running this script.
alter default privileges in schema public
grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
grant usage, select, update on sequences to service_role;

-- Only these tables have public-read RLS policies in schema.sql.
grant select on table public.puzzles to anon, authenticated;
grant select on table public.games to anon, authenticated;

-- The atomic game-finalization RPC is intentionally backend-only.
grant execute on function public.finalize_chess_game(
  text, uuid, uuid, text, text, text, text, text, int, int, int,
  double precision, double precision, int, int, double precision, double precision, int
) to service_role;

-- Verify the permissions that the affected endpoints/importer need.
select
  table_name,
  has_table_privilege('service_role', format('public.%I', table_name), 'select') as service_can_select,
  has_table_privilege('service_role', format('public.%I', table_name), 'insert') as service_can_insert,
  has_table_privilege('service_role', format('public.%I', table_name), 'update') as service_can_update,
  has_table_privilege('service_role', format('public.%I', table_name), 'delete') as service_can_delete
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'profiles', 'games', 'friendships', 'tournaments', 'tournament_players',
    'tournament_matches', 'moderation_reports', 'moderation_actions',
    'integrity_flags', 'puzzles', 'puzzle_progress'
  )
order by table_name;

