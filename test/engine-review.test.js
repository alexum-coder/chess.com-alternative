'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewGameMoves, toCentipawns } = require('../engine-review');

test('converts centipawn and mate scores from UCI', () => {
  assert.equal(toCentipawns({ type: 'cp', value: 34 }), 34);
  assert.equal(toCentipawns({ type: 'mate', value: 2 }), 29800);
  assert.equal(toCentipawns({ type: 'mate', value: -3 }), -29700);
  assert.equal(toCentipawns(null), null);
});

test('emits a review flag only after enough engine-concordant moves', async () => {
  const engine = {
    depth: 11, name: 'Stockfish test engine',
    async analyze() { return { bestMove: 'g1f3', score: { type: 'cp', value: 20, depth: 11 } }; }
  };
  // Use repeatable legal knight moves while the mock engine returns a plausible UCI line.
  const moves = ['g1f3','g8f6','f3g1','f6g8','g1f3','g8f6','f3g1','f6g8','g1f3','g8f6','f3g1','f6g8','g1f3','g8f6'];
  const result = await reviewGameMoves(moves, engine, { minPly: 1, minSamples: 4, maxPlies: 14 });
  assert.equal(result.players.w.analyzedMoves, 7);
  assert.equal(result.players.w.flagForReview, false); // alternating black/white means the mock best move is not always chosen
  assert.equal(result.players.b.analyzedMoves, 7);
});


test('flags a player only when the configured sample and concordance thresholds are met', async () => {
  const { Chess } = require('chess.js');
  const chess = new Chess();
  const uciMoves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6'];
  const bestByFen = new Map();
  for (const uci of uciMoves) {
    bestByFen.set(chess.fen(), uci);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
  }
  const engine = {
    depth: 12, name: 'Stockfish mock',
    async analyze(fen) {
      const turn = fen.split(' ')[1];
      return { bestMove: bestByFen.get(fen) || '0000', score: { type: 'cp', value: turn === 'w' ? 20 : -20, depth: 12 } };
    }
  };
  const result = await reviewGameMoves(uciMoves, engine, {
    minPly: 1, maxPlies: 20, minSamples: 3, concordanceThreshold: 0.9, avgLossThreshold: 18
  });
  assert.equal(result.players.w.flagForReview, true);
  assert.equal(result.players.b.flagForReview, true);
  assert.equal(result.players.w.averageCentipawnLoss, 0);
  assert.equal(result.players.b.averageCentipawnLoss, 0);
});
