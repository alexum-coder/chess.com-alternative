'use strict';

function parseUciMove(uci) {
  const value = String(uci || '').trim();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(value)) return null;
  return { from: value.slice(0, 2), to: value.slice(2, 4), ...(value[4] ? { promotion: value[4] } : {}) };
}

function validatePuzzleRecord(row, ChessType = null) {
  if (!row || typeof row.fen !== 'string' || typeof row.moves !== 'string') return false;
  const moves = row.moves.trim().split(/\s+/).filter(Boolean);
  // Lichess stores the opponent's last move first, followed by the player's solution.
  if (moves.length < 2 || moves.some((move) => !parseUciMove(move))) return false;
  try {
    const Engine = ChessType || require('chess.js').Chess;
    const chess = new Engine(row.fen);
    for (const uci of moves) {
      const move = chess.move(parseUciMove(uci));
      if (!move) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function puzzleRatingRange(rating, min = null, max = null) {
  if (min !== null || max !== null) {
    const low = Number(min);
    const high = Number(max);
    if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error('Choose a valid puzzle rating range.');
    const safeMin = Math.max(0, Math.min(3000, Math.round(low)));
    const safeMax = Math.max(safeMin, Math.min(3500, Math.round(high)));
    return { min: safeMin, max: safeMax };
  }
  const center = Number.isFinite(Number(rating)) ? Math.round(Number(rating)) : 1200;
  return { min: Math.max(0, center - 200), max: Math.min(3500, center + 200) };
}

function puzzleCompletionAward({ status = null, cleanAttempt = true, currentRating = 1200 } = {}) {
  if (status === 'solved') return { awarded: false, delta: 0, rating: currentRating, reason: 'already_completed' };
  if (status === 'failed' || !cleanAttempt) return { awarded: false, delta: 0, rating: currentRating, reason: 'attempt_had_mistake' };
  return { awarded: true, delta: 5, rating: currentRating + 5, reason: 'first_try_solved' };
}

module.exports = { parseUciMove, validatePuzzleRecord, puzzleRatingRange, puzzleCompletionAward };
