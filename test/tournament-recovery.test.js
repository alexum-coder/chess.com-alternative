'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Chess } = require('chess.js');
const { serializeTournamentGame, restoreChess, hydrateTournamentState } = require('../tournament-recovery');

test('tournament checkpoint preserves moves, FEN and time remaining', () => {
  const chess = new Chess();
  chess.move('e4'); chess.move('e5'); chess.move('Nf3');
  const game = {
    chess, white: { pid: 'white' }, black: { pid: 'black' }, base: 300, inc: 2,
    clock: { w: 29000, b: 28000 }, turnStart: 1000, started: true,
    recoveryPaused: false, draw: null, drawLock: { w: 2, b: 2 }, drawCount: { w: 0, b: 0 },
    pendingResult: { result: '1-0', reason: 'resignation' }
  };
  const saved = serializeTournamentGame(game, 6000);
  assert.equal(saved.clock.b, 23000);
  assert.equal(saved.clock.w, 29000);
  assert.deepEqual(saved.pendingResult, { result: '1-0', reason: 'resignation' });
  const restored = restoreChess(saved);
  assert.equal(restored.fen(), chess.fen());
  assert.deepEqual(restored.history(), chess.history());
});

test('tournament hydration reconstructs the active round and byes', () => {
  const tournament = { id: 'cup', status: 'running', base: 300, inc: 0 };
  const rows = [
    { round: 1, id: 'a', player_a: 'p1', player_b: 'p2', winner_id: 'p1', status: 'done' },
    { round: 1, id: 'b', player_a: 'p3', player_b: null, winner_id: 'p3', status: 'done', result: 'bye' },
    { round: 2, id: 'c', player_a: 'p1', player_b: 'p3', winner_id: null, status: 'playing', game_id: 'g1' }
  ];
  const state = hydrateTournamentState(tournament, ['p1', 'p2', 'p3'], rows);
  assert.equal(state.round, 2);
  assert.deepEqual(state.byes, []);
  assert.deepEqual(state.matches, [{ id: 'c', a: 'p1', b: 'p3', winner: null, status: 'playing', gameId: 'g1', result: null }]);
});


test('hydration preserves pending pairings so a round can start after players reconnect', () => {
  const tournament = { id: 'pending-cup', status: 'running', base: 300, inc: 0 };
  const rows = [
    { round: 1, id: 'pending-1', player_a: 'p1', player_b: 'p2', winner_id: null, status: 'pending', game_id: null }
  ];
  const state = hydrateTournamentState(tournament, ['p1', 'p2'], rows);
  assert.deepEqual(state.matches, [{
    id: 'pending-1', a: 'p1', b: 'p2', winner: null, status: 'pending', gameId: null, result: null
  }]);
});
