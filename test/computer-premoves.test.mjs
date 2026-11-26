import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../computer.html', import.meta.url), 'utf8');

test('computer games expose a premove queue and cancellation control', () => {
  assert.match(html, /id="computer-premove-bar"/);
  assert.match(html, /id="computer-premove-text"/);
  assert.match(html, /id="computer-premove-cancel"/);
  assert.match(html, /function cancelComputerPremoves\(\)/);
  assert.match(html, /computer-premove-cancel'\)\.addEventListener\('click', cancelComputerPremoves\)/);
});

test("premoves can be queued while Stockfish is calculating Black's move", () => {
  assert.match(html, /function isComputerPremoveWindow\(\)[\s\S]*?chess\.turn\(\) === 'b'[\s\S]*?pendingBotMove/);
  assert.match(html, /function click\(square\)[\s\S]*?const canPremove = isComputerPremoveWindow\(\)/);
  assert.match(html, /setComputerPremove\(from, square, 'q'\)/);
});

test('computer premoves support a chain of up to eight projected White moves', () => {
  assert.match(html, /computerPreMoves\.length >= 8/);
  assert.match(html, /function getComputerPremovePlanningChess\(\)/);
  assert.match(html, /for \(const pre of computerPreMoves\)/);
  assert.match(html, /premovePosition:planning \? planning\.board\(\) : null/);
  assert.match(html, /dragPosition:planning \? planning\.board\(\) : null/);
});

test('the queue is replayed after each Stockfish reply and every move is revalidated live', () => {
  const botMove = html.slice(html.indexOf('function makeBotMove'), html.indexOf('function uciToSan'));
  assert.match(botMove, /runComputerPremove\(\)/);
  const run = html.slice(html.indexOf('function runComputerPremove'), html.indexOf('    function render()'));
  assert.match(run, /chess\.turn\(\) !== 'w'/);
  assert.match(run, /chess\.moves\(\{ square:pre\.from, verbose:true \}\)/);
  assert.match(run, /chess\.move\(\{ from:pre\.from, to:pre\.to/);
  assert.match(run, /askEngine\(chess\.fen\(\), \(activeBot\?\.depth \?\? 6\), true\)/);
});

test('an invalidated first premove clears the dependent speculative sequence', () => {
  const run = html.slice(html.indexOf('function runComputerPremove'), html.indexOf('    function render()'));
  assert.match(run, /computerPreMoves = \[\]/);
  assert.match(run, /later queued move/);
});

test('new games and undo clear computer premove state', () => {
  assert.match(html, /computerPreMoves = \[\]; computerPremoveMessage = '';/);
});


test('a selected premove piece stays selected and receives live legal targets when the bot moves', () => {
  assert.match(html, /function refreshComputerSelectionForLiveTurn\(preferredSquare = null\)/);
  const handoff = html.slice(html.indexOf('function makeBotMove'), html.indexOf('function uciToSan'));
  assert.match(handoff, /refreshComputerSelectionForLiveTurn\(\)/);
  assert.doesNotMatch(handoff, /selected = null; targets = \[\];\s*invalidateReview/);
  assert.match(html, /const liveTargets = chess\.moves\(\{ square:selected, verbose:true \}\)/);
  assert.match(html, /board\.getActiveDragSource\(\)/);
  assert.match(html, /board\.pulseTurnHandoff\(\)/);
});


test('an invalidated computer premove restores its source piece as a live selection', () => {
  const run = html.slice(html.indexOf('function runComputerPremove'), html.indexOf('    function render()'));
  assert.match(run, /restoreFrom = pre\.from/);
  assert.match(run, /refreshComputerSelectionForLiveTurn\(restoreFrom\)/);
  assert.match(html, /const source = \[selected, preferredSquare, board\.getActiveDragSource\(\)\]/);
});
