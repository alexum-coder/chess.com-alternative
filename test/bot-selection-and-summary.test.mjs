import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const computer = await readFile(new URL('../computer.html', import.meta.url), 'utf8');
const analysis = await readFile(new URL('../analysis.html', import.meta.url), 'utf8');
const nav = await readFile(new URL('../nav.js', import.meta.url), 'utf8');

test('computer page opens on an Elo-sorted named bot-selection screen', () => {
  assert.match(computer, /id="bot-lobby"/);
  assert.match(computer, /id="bot-grid"/);
  assert.match(computer, /id="random-bot"/);
  assert.match(computer, /function sortedBots\(\)/);
  assert.doesNotMatch(computer, /shuffledBots\(/);
  assert.match(computer, /for \(const bot of sortedBots\(\)\)/);
  assert.match(computer, /function renderBotLobby\(\)/);
  assert.match(computer, /function selectBot\(bot\)/);
  assert.match(computer, /<main id="computer-game" hidden>/);
});

test('bot roster spans 250 through 2000 Elo and gives each opponent a playful name', () => {
  const roster = computer.match(/const BOT_ROSTER = \[([\s\S]*?)\n    \];/);
  assert.ok(roster, 'bot roster exists');
  const entries = [...roster[1].matchAll(/name:'([^']+)',elo:(\d+)/g)].map((m) => ({ name:m[1], elo:Number(m[2]) }));
  assert.ok(entries.length >= 10);
  assert.equal(Math.min(...entries.map((bot) => bot.elo)), 250);
  assert.equal(Math.max(...entries.map((bot) => bot.elo)), 2000);
  assert.ok(entries.every((bot) => bot.name.trim().length >= 4));
});

test('bot strength configures Stockfish skill or Elo limit for each selected bot', () => {
  assert.match(computer, /setoption name Skill Level value/);
  assert.match(computer, /setoption name UCI_LimitStrength value true/);
  assert.match(computer, /setoption name UCI_Elo value/);
  assert.match(computer, /setoption name UCI_AnalyseMode value true/);
  assert.match(computer, /activeBot\?\.depth/);
});

test('every bot move waits at least two seconds after its engine search begins', () => {
  assert.match(computer, /const MIN_BOT_THINK_MS = 2000/);
  assert.match(computer, /botSearchStartedAt = performance\.now\(\)/);
  assert.match(computer, /MIN_BOT_THINK_MS - \(performance\.now\(\) - botSearchStartedAt\)/);
  assert.match(computer, /expectedEpoch !== gameEpoch/);
  assert.match(computer, /chess\.fen\(\) !== expectedFen/);
  assert.match(computer, /const moveToPlay = bestMove/);
});

test('the analysis move summary does not count checkmate as a summary category', () => {
  const order = analysis.match(/const order = \[([^;]+)\];/);
  assert.ok(order);
  assert.doesNotMatch(order[1], /checkmate/);
  const computerOrder = computer.match(/const order = \[([\s\S]*?)\];/);
  assert.ok(computerOrder);
  assert.doesNotMatch(computerOrder[1], /Checkmate|checkmate/);
});

test('stopping one game ignores its stale engine bestmove before the next bot game', () => {
  assert.match(computer, /ignoreNextBestMove = true; worker\.postMessage\('stop'\)/);
  assert.match(computer, /if \(ignoreNextBestMove\) \{ ignoreNextBestMove = false; return; \}/);
});

test('computer game analysis uses the chosen bot name', () => {
  assert.match(computer, /black_name:activeBot\?\.name \|\| 'Chess bot'/);
});

test('navigation calls the computer section Bots', () => {
  assert.match(nav, /\['Bots', '\/computer\.html'/);
  assert.doesNotMatch(nav, /\['Computer', '\/computer\.html'/);
});
