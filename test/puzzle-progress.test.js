'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUciMove, validatePuzzleRecord, puzzleRatingRange, puzzleCompletionAward } = require('../puzzle-utils');

class TinyLegalChess {
  constructor(fen) {
    if (fen !== 'valid-fen') throw new Error('invalid FEN');
    this.moves = ['e2e4', 'e7e5', 'g1f3'];
    this.index = 0;
  }
  move(move) {
    const value = move.from + move.to + (move.promotion || '');
    if (value !== this.moves[this.index]) return null;
    this.index++;
    return { from: move.from, to: move.to };
  }
}

test('parses UCI moves and promotions', () => {
  assert.deepEqual(parseUciMove('e2e4'), { from: 'e2', to: 'e4' });
  assert.deepEqual(parseUciMove('a7a8n'), { from: 'a7', to: 'a8', promotion: 'n' });
  assert.equal(parseUciMove('e9e4'), null);
});

test('validates complete puzzle lines and rejects malformed data', () => {
  assert.equal(validatePuzzleRecord({ fen: 'valid-fen', moves: 'e2e4 e7e5 g1f3' }, TinyLegalChess), true);
  assert.equal(validatePuzzleRecord({ fen: 'valid-fen', moves: 'e2e4 e7e5 a1a8' }, TinyLegalChess), false);
  assert.equal(validatePuzzleRecord({ fen: 'valid-fen', moves: 'not-a-move' }, TinyLegalChess), false);
  assert.equal(validatePuzzleRecord({ fen: 'broken', moves: 'e2e4 e7e5' }, TinyLegalChess), false);
});

test('recommended puzzles are sampled around the private rating', () => {
  assert.deepEqual(puzzleRatingRange(1500), { min: 1300, max: 1700 });
  assert.deepEqual(puzzleRatingRange(50), { min: 0, max: 250 });
  assert.deepEqual(puzzleRatingRange(3300), { min: 3100, max: 3500 });
});

test('manual rating bands are bounded and validated', () => {
  assert.deepEqual(puzzleRatingRange(1200, '1200', '1600'), { min: 1200, max: 1600 });
  assert.deepEqual(puzzleRatingRange(1200, '-50', '900'), { min: 0, max: 900 });
  assert.throws(() => puzzleRatingRange(1200, 'bad', '900'), /valid puzzle rating range/i);
});

test('a clean first solve awards +5, a miss awards nothing, and duplicates never award twice', () => {
  assert.deepEqual(puzzleCompletionAward({ currentRating: 1200 }), {
    awarded: true, delta: 5, rating: 1205, reason: 'first_try_solved'
  });
  assert.deepEqual(puzzleCompletionAward({ currentRating: 1200, cleanAttempt: false }), {
    awarded: false, delta: 0, rating: 1200, reason: 'attempt_had_mistake'
  });
  assert.deepEqual(puzzleCompletionAward({ currentRating: 1205, status: 'solved' }), {
    awarded: false, delta: 0, rating: 1205, reason: 'already_completed'
  });
});
