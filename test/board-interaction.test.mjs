import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const board = await readFile(new URL('../board.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../board.css', import.meta.url), 'utf8');
const live = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const computer = await readFile(new URL('../computer.html', import.meta.url), 'utf8');
const puzzles = await readFile(new URL('../puzzles.html', import.meta.url), 'utf8');

test('shared board supports pointer drag for mouse, pen and touch', () => {
  for (const handler of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    assert.ok(board.includes(`'${handler}'`), `expected ${handler} handling`);
  }
  assert.match(board, /setPointerCapture/);
  assert.match(board, /elementFromPoint/);
  assert.match(board, /#updateDragLayer/);
  assert.match(css, /touch-action: none/);
  assert.match(css, /\.zz-drag-piece/);
});

test('drag selection remains compatible with click and keyboard interaction', () => {
  assert.match(board, /this\.onSquare\(drag\.from\)/);
  assert.match(board, /this\.onSquare\(destination\.dataset\.sq\)/);
  assert.match(board, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(board, /suppressPointerClick/);
});

test('all moveable board types use the shared drag-capable board renderer', () => {
  assert.match(live, /new ZugzwangBoard\(\$\('#board'\), onSquare\)/);
  assert.match(computer, /new ZugzwangBoard\(\$\('board'\), click\)/);
  assert.match(puzzles, /new ZugzwangBoard\(\$\('board'\), onSquareClick\)/);
});

test('online games can queue multiple speculative premoves and show their projected position', () => {
  assert.match(live, /preMoves:\s*\[\]/);
  assert.match(live, /function getPremovePlanningChess\(/);
  assert.match(live, /game\.preMoves\.push\(/);
  assert.match(live, /game\.preMoves\.length >= 8/);
  assert.match(live, /premovePosition:/);
  assert.match(live, /dragPosition:/);
  assert.match(live, /queue\.map\(\(pre, index\)/);
});

test('queued premoves are revalidated against the live position before sending', () => {
  const run = live.slice(live.indexOf('function runPremove()'), live.indexOf('function paintPremove()'));
  assert.match(run, /game\.chess\.turn\(\) !== game\.color/);
  assert.match(run, /game\.preMoves\.shift\(\)/);
  assert.match(run, /game\.chess\.moves\(\{ square: pre\.from, verbose: true \}\)/);
  assert.match(run, /sendMove\(pre\.from, pre\.to, pre\.promotion \|\| 'q', pre\)/);
  assert.match(live, /if \(queuedPremove\) game\.preMoves\.unshift\(queuedPremove\)/);
});

test('premove queue can be cancelled with the button, Escape or right-click', () => {
  assert.match(live, /function cancelPremove\(\)[\s\S]*?game\.preMoves = \[\]/);
  assert.match(live, /else cancelPremove\(\)/);
  assert.match(live, /contextmenu[\s\S]*?game\.preMoves = \[\]/);
  assert.match(live, /preCancel/);
});
