'use strict';

const { Chess } = require('chess.js');

function serializeTournamentGame(game, now = Date.now()) {
  const clock = { ...game.clock };
  if (game.started && !game.recoveryPaused && !game.over) {
    const side = game.chess.turn();
    clock[side] = Math.max(0, clock[side] - Math.max(0, now - game.turnStart));
  }
  const moves = game.chess.history({ verbose: true }).map((move) => ({
    from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {})
  }));
  return {
    version: 1,
    whitePid: game.white.pid,
    blackPid: game.black.pid,
    base: game.base,
    inc: game.inc,
    fen: game.chess.fen(),
    moves,
    clock,
    savedAt: now,
    draw: game.draw || null,
    drawLock: game.drawLock || { w: 2, b: 2 },
    drawCount: game.drawCount || { w: 0, b: 0 },
    timing: game.timing || { w: { total: 0, veryFast: 0 }, b: { total: 0, veryFast: 0 } },
    pendingResult: game.pendingResult || null
  };
}

function restoreChess(saved) {
  if (!saved || saved.version !== 1 || !Array.isArray(saved.moves) || !saved.clock) {
    throw new Error('Tournament game checkpoint is missing or has an unsupported version.');
  }
  const chess = new Chess();
  for (const move of saved.moves) {
    const applied = chess.move(move);
    if (!applied) throw new Error('Tournament checkpoint contains an illegal move.');
  }
  if (saved.fen && chess.fen() !== saved.fen) throw new Error('Tournament checkpoint FEN does not match its move list.');
  return chess;
}

function hydrateTournamentState(tournament, entrants, matchRows) {
  const rows = [...matchRows].sort((a, b) => a.round - b.round || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const round = rows.reduce((highest, row) => Math.max(highest, Number(row.round) || 0), 0);
  const current = rows.filter((row) => Number(row.round) === round);
  return {
    ...tournament,
    players: entrants,
    round,
    matches: current.filter((row) => row.player_b).map((row) => ({
      id: row.id, a: row.player_a, b: row.player_b,
      winner: row.winner_id || null, status: row.status, gameId: row.game_id || null, result: row.result || null
    })),
    byes: current.filter((row) => !row.player_b && row.winner_id).map((row) => row.winner_id),
    status: tournament.status,
    winner: tournament.winner_id || null,
    advancingRound: false
  };
}

module.exports = { serializeTournamentGame, restoreChess, hydrateTournamentState };
