import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../puzzles.html', import.meta.url), 'utf8');
const board = fs.readFileSync(new URL('../board.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../board.css', import.meta.url), 'utf8');
const schema = fs.readFileSync(new URL('../puzzle-rating-migration.sql', import.meta.url), 'utf8');

test('puzzle page exposes a private rating, hint, solution arrow and retry control', () => {
  for (const text of ['Your puzzle rating', 'Private', 'id="hint"', 'id="solution"', 'id="retry"', 'Retry puzzle']) {
    assert.ok(page.includes(text), `missing ${text}`);
  }
  assert.match(page, /failedAttempt\s*=\s*true/);
  assert.match(page, /cleanAttempt:\s*!failedAttempt/);
});

test('hints highlight the source square and solution draws an arrow using board orientation', () => {
  assert.match(page, /hintSquare\s*=\s*expected\.slice\(0,\s*2\)/);
  assert.match(page, /solutionArrow\s*=\s*\{\s*from:/);
  assert.match(board, /puzzle-hint-square/);
  assert.match(board, /#appendSolutionArrow/);
  assert.match(css, /\.zz-solution-arrow/);
});

test('puzzle progress schema keeps private progress inaccessible to browser roles', () => {
  assert.match(schema, /puzzle_rating integer not null default 1200/i);
  assert.match(schema, /alter table public\.puzzle_progress enable row level security/i);
  assert.match(schema, /revoke all on table public\.puzzle_progress from public, anon, authenticated/i);
  assert.match(schema, /grant execute on function public\.complete_puzzle\(uuid, text, boolean\) to service_role/i);
});

test('wrong moves are persisted before retry is enabled and never earn puzzle rating', () => {
  const failed = page.indexOf("phase = 'failed-saving'");
  const save = page.indexOf('await saveMiss();', failed);
  const retryEnabled = page.indexOf("phase = 'failed';", save);
  assert.ok(failed >= 0 && save > failed && retryEnabled > save);
  assert.match(page, /cleanAttempt:\s*!failedAttempt/);
});

test('the private puzzle rating is served only by an authenticated no-store endpoint', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/puzzles\/stats',[\s\S]*?requireAccount\(req, res\)/);
  assert.match(server, /Cache-Control', 'private, no-store'/);
  assert.match(server, /app\.post\('\/api\/puzzles\/complete'/);
  assert.match(server, /app\.post\('\/api\/puzzles\/miss'/);
});

test('puzzle sampling validates candidates and does not use a full-table random OFFSET', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /validatePuzzleRecord\(candidate\)/);
  assert.match(server, /randomPuzzleCursor\(\)/);
  const route = server.slice(server.indexOf("app.get('/api/puzzles/random'"), server.indexOf("app.get('/', (req, res)"));
  assert.doesNotMatch(route, /count:\s*'exact'|\.range\(offset/);
});

test('SQL completion is per-player, idempotent and withholds points after a wrong attempt', () => {
  assert.match(schema, /select puzzle_rating into v_rating[\s\S]*?for update/i);
  assert.match(schema, /v_delta integer := 5/i);
  assert.match(schema, /if v_status = 'solved' then[\s\S]*?already_completed/i);
  assert.match(schema, /if v_status = 'failed' or not p_clean_attempt then[\s\S]*?rating_change = 0[\s\S]*?attempt_had_mistake/i);
  assert.match(schema, /update public\.profiles set puzzle_rating = puzzle_rating \+ v_delta/i);
});


test('solution arrow is slightly smaller and keeps its move direction clear', () => {
  assert.match(board, /stroke-width', '15'/);
  assert.match(board, /markerWidth', '6'/);
  assert.match(board, /markerHeight', '6'/);
});

test('successful puzzle rating rolls upward before the next puzzle loads automatically', () => {
  assert.match(page, /rating-digit-strip/);
  assert.match(page, /renderPuzzleRating\(data\.rating,[\s\S]*?animate:\s*Boolean\(data\.awarded/);
  assert.match(page, /function scheduleNextPuzzle\(delay = 1900\)/);
  assert.match(page, /scheduleNextPuzzle\(advanceDelay\)/);
  assert.match(page, /autoAdvanceTimer = setTimeout\([\s\S]*?void loadPuzzle\(\)/);
  assert.match(page, /\$\('range'\)\.disabled = phase === 'loading' \|\| savingResult/);
  assert.match(page, /aria-label',? `\$\{rating\.toLocaleString\(\)\} puzzle rating`/);
  assert.match(page, /Next puzzle · \$\{seconds\}s/);
});
