'use strict';
// Streams Lichess's CC0 puzzle CSV; requires `zstd` CLI and SUPABASE_URL/SUPABASE_SERVICE_KEY.
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
function parseCsv(line) {
  const out = []; let value = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { out.push(value); value = ''; }
    else value += c;
  }
  out.push(value); return out;
}
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run import:puzzles -- /path/to/lichess_db_puzzle.csv.zst');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY.');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let header = null, batch = [], count = 0;
  for await (const line of rl) {
    if (!header) { header = parseCsv(line); continue; }
    const c = parseCsv(line); const row = Object.fromEntries(header.map((h, i) => [h, c[i] ?? '']));
    batch.push({ puzzle_id: row.PuzzleId, fen: row.FEN, moves: row.Moves, rating: Number(row.Rating) || 1500,
      themes: (row.Themes || '').split(' ').filter(Boolean), game_url: row.GameUrl || null });
    if (batch.length >= 500) {
      const { error } = await db.from('puzzles').upsert(batch, { onConflict: 'puzzle_id' });
      if (error) throw error; count += batch.length; batch = [];
      if (count % 10000 === 0) process.stdout.write(`Imported ${count.toLocaleString()} puzzles\r`);
    }
  }
  if (batch.length) { const { error } = await db.from('puzzles').upsert(batch, { onConflict: 'puzzle_id' }); if (error) throw error; count += batch.length; }
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) throw new Error(`zstd exited with code ${code}`);
  console.log(`Imported ${count.toLocaleString()} CC0 puzzles.`);
}
main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
