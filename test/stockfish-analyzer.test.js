 'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { StockfishAnalyzer } = require('../stockfish-analyzer');

test('Stockfish UCI client handshakes and returns best move plus evaluation', async () => {
  const engine = new StockfishAnalyzer({ command: process.execPath, args: [path.join(__dirname, 'fake-stockfish.js')], depth: 12 });
  try {
    const result = await engine.analyze('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    assert.equal(result.engine, 'Stockfish Mock 1');
    assert.equal(result.bestMove, 'e2e4');
    assert.deepEqual(result.score, { type: 'cp', value: 27, depth: 12 });
  } finally {
    await engine.terminate();
  }
});
