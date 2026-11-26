import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../analysis.html', import.meta.url), 'utf8');
const boardSource = await readFile(new URL('../board.js', import.meta.url), 'utf8');
const boardCss = await readFile(new URL('../board.css', import.meta.url), 'utf8');

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

test('review uses classic text marks plus vector Best, Excellent and Checkmate icons', () => {
  for (const [key, glyph] of Object.entries({ brilliant:'!!', great:'!', good:'✓', inaccuracy:'?', mistake:'?!', blunder:'??' })) {
    assert.ok(html.includes(`${key}:'${glyph}'`), `expected ${glyph} marker for ${key}`);
  }
  assert.doesNotMatch(html, /best:'👍'|excellent:'★'/, 'Best and Excellent must use vector icons, not emoji/text substitutes');
  assert.match(html, /function makeReviewVector\(/);
  assert.match(html, /key === 'best'/);
  assert.match(html, /key === 'excellent'/);
  assert.match(html, /key === 'checkmate'/);
  assert.match(html, /node\.append\(vector\)/);
  assert.match(html, /M8 3L6 21M18 3l-2 18M3 9h18M2 15h18/, 'checkmate vector must render a hash sign');
});

test('selected move annotates origin and destination squares with grade colours', () => {
  assert.match(html, /moveAnnotation:annotation/);
  assert.match(html, /from:move\.move\.from, to:move\.move\.to/);
  assert.match(html, /REVIEW_COLORS =/);
  for (const color of ['#8be0f2', '#3289ef', '#b7ed4d', '#35c96a', '#f0d343', '#f3973e', '#ed4d4d']) {
    assert.ok(html.includes(color), `expected board colour ${color}`);
  }
  assert.match(html, /row\.move\.from/);
  assert.match(html, /row\.move\.to/);
  assert.match(html, /pieceNames\[row\.move\.piece\]/);
});

test('shared board overlays Best thumb, Excellent star and Checkmate hash vectors on the moved piece', () => {
  assert.match(boardSource, /key === 'best'/);
  assert.match(boardSource, /key === 'excellent'/);
  assert.match(boardSource, /key === 'checkmate'/);
  assert.match(boardSource, /M8 3L6 21M18 3l-2 18M3 9h18M2 15h18/);
});

test('shared board overlays the annotation on the moved piece and highlights both squares', () => {
  assert.match(boardSource, /moveAnnotation = null/);
  assert.match(boardSource, /review-move-from/);
  assert.match(boardSource, /review-move-to/);
  assert.match(boardSource, /#reviewBadge\(moveAnnotation\)/);
  assert.match(boardCss, /\.zz-board \.sq\.review-move-from/);
  assert.match(boardCss, /\.zz-board \.sq\.review-move-to/);
  assert.match(boardCss, /\.zz-board \.zz-review-badge/);
});
