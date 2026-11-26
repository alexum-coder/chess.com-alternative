import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const live = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('online move updates retain a selected premove piece when the opponent hands over the turn', () => {
  assert.match(live, /function refreshSelectionAfterTurnChange\(preferredSquare = null\)/);
  const handler = live.slice(live.indexOf("socket.on('state'"), live.indexOf("socket.on('gameResumed'"));
  assert.match(handler, /const wasWaitingForOpponent = game\.chess\.turn\(\) !== game\.color/);
  assert.match(handler, /if \(wasWaitingForOpponent && game\.chess\.turn\(\) === game\.color\) refreshSelectionAfterTurnChange\(selectedBeforeHandoff\)/);
});

test('online selection handoff recalculates legal destinations without reselecting', () => {
  const handoff = live.slice(live.indexOf('function refreshSelectionAfterTurnChange'), live.indexOf("socket.on('state'"));
  assert.match(handoff, /game\.chess\.moves\(\{ square:selected, verbose:true \}\)\.map/);
  assert.match(handoff, /board\.getActiveDragSource\(\)/);
  assert.match(handoff, /board\.pulseTurnHandoff\(\)/);
  assert.match(handoff, /premoveTargets\(selected, position\)/);
  assert.doesNotMatch(handoff, /selected = null; targets = \[\];\s*render/);
});


test('an invalidated online premove restores its source piece and clears dependent moves', () => {
  const run = live.slice(live.indexOf('function runPremove()'), live.indexOf('function paintPremove()'));
  assert.match(run, /const piece = game\.chess\.get\(pre\.from\)/);
  assert.match(run, /selected = pre\.from/);
  assert.match(run, /game\.preMoves = \[\]/);
  assert.match(run, /board\.pulseTurnHandoff\(\)/);
});
