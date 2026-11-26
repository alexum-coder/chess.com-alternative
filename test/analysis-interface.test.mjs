import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../analysis.html', import.meta.url), 'utf8');

test('game review renders exactly one move annotation panel', () => {
  assert.equal((html.match(/id="moveDetail"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="engineInsight"/);
});

test('review depth toolbar and completion status strip are removed', () => {
  for (const removedId of ['engineState', 'runReview', 'depth']) {
    assert.doesNotMatch(html, new RegExp(`id="${removedId}"`));
  }
  assert.doesNotMatch(html, /class="engine-row"/);
  assert.doesNotMatch(html, /class="engine-state"/);
});

test('review displays a skeleton while automatic Stockfish analysis is pending', () => {
  assert.match(html, /class="analysis-skeleton"/);
  assert.match(html, /function showAnalysisSkeleton\(/);
  assert.match(html, /const ANALYSIS_DEPTH = 14/);
  assert.match(html, /autoStartPending = true/);
  assert.match(html, /void runAnalysis\(\)/);
});

test('review uses distinct SVG icons for the move classifications', () => {
  for (const key of ['book','brilliant','best','great','excellent','good','inaccuracy','mistake','blunder','missed-win','checkmate']) {
    assert.ok(html.includes(`${key}:`) || html.includes(`'${key}':`), `expected SVG icon for ${key}`);
  }
  assert.match(html, /function renderReviewIcon\(/);
});
