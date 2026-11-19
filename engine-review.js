'use strict';

const { Chess } = require('chess.js');

function toCentipawns(score) {
  if (!score || !Number.isFinite(score.value)) return null;
  if (score.type === 'mate') {
    const sign = Math.sign(score.value) || 1;
    return sign * (30000 - Math.min(299, Math.abs(score.value)) * 100);
  }
  return score.value;
}

const toUci = (move) => move.from + move.to + (move.promotion || '');

/**
 * Reviews a completed game's UCI move list. Engine agreement is a moderation lead,
 * never a standalone cheating verdict. The returned move samples make each signal auditable.
 */
async function reviewGameMoves(moves, engine, options = {}) {
  const minPly = options.minPly ?? 10;
  const maxPlies = options.maxPlies ?? 60;
  const minSamples = options.minSamples ?? 12;
  const concordanceThreshold = options.concordanceThreshold ?? 0.90;
  const avgLossThreshold = options.avgLossThreshold ?? 18;
  const depth = engine.depth ?? options.depth ?? 11;
  const chess = new Chess();
  const byColor = {
    w: { color: 'w', analyzedMoves: 0, bestMoves: 0, centipawnLoss: 0, samples: [] },
    b: { color: 'b', analyzedMoves: 0, bestMoves: 0, centipawnLoss: 0, samples: [] }
  };

  for (let index = 0; index < Math.min(moves.length, maxPlies); index++) {
    const input = moves[index];
    const color = chess.turn();
    const legalCount = chess.moves().length;
    const beforeFen = chess.fen();
    const before = await engine.analyze(beforeFen);
    const moveInput = typeof input === 'string'
      ? { from: input.slice(0, 2), to: input.slice(2, 4), ...(input[4] ? { promotion: input[4] } : {}) }
      : input;
    const played = chess.move(moveInput);
    if (!played) throw new Error(`Cannot analyse invalid move at ply ${index + 1}.`);
    const afterFen = chess.fen();
    const after = await engine.analyze(afterFen);

    if (index + 1 < minPly || legalCount < 2) continue;
    const beforeScore = toCentipawns(before.score);
    const afterScore = toCentipawns(after.score);
    if (beforeScore == null || afterScore == null) continue;

    const bestMove = before.bestMove;
    const playedMove = toUci(played);
    const loss = Math.max(0, beforeScore + afterScore);
    const stat = byColor[color];
    stat.analyzedMoves++;
    if (bestMove === playedMove) stat.bestMoves++;
    stat.centipawnLoss += loss;
    stat.samples.push({
      ply: index + 1, played: playedMove, best: bestMove,
      centipawnLoss: Math.round(loss), depth: before.score?.depth || depth
    });
  }

  for (const stat of Object.values(byColor)) {
    stat.bestMoveRate = stat.analyzedMoves ? stat.bestMoves / stat.analyzedMoves : 0;
    stat.averageCentipawnLoss = stat.analyzedMoves ? stat.centipawnLoss / stat.analyzedMoves : null;
    stat.averageCentipawnLoss = stat.averageCentipawnLoss == null ? null : Math.round(stat.averageCentipawnLoss * 10) / 10;
    stat.flagForReview = stat.analyzedMoves >= minSamples
      && stat.bestMoveRate >= concordanceThreshold
      && stat.averageCentipawnLoss <= avgLossThreshold;
    delete stat.centipawnLoss;
  }

  return {
    engine: engine.name || 'Stockfish (UCI)', depth,
    totalPlies: Math.min(moves.length, maxPlies),
    players: byColor
  };
}

module.exports = { reviewGameMoves, toCentipawns, toUci };
