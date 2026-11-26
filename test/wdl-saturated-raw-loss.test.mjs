import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpectedPointsLoss,
  classifyMoveQuality,
  explainMoveQuality,
  formatExpectedPointsLoss
} from '../review-scoring.mjs';

test('a four-pawn deterioration is a blunder even when WDL loss rounds to zero', () => {
  // Black is already far behind: WDL is saturated near 0 for Black, but the
  // rook move lets White's evaluation jump from +5 to +9.
  const before = {
    whiteScore:5.0,
    whiteExpectedPoints:0.99995,
    score:{ type:'cp', value:-500 },
    bestMove:'d6e5'
  };
  const after = {
    whiteScore:9.0,
    whiteExpectedPoints:1.0,
    score:{ type:'cp', value:-900 }
  };
  const row = {
    color:'b', uci:'c2d2', san:'Rd2', checkmate:false,
    move:{ piece:'r', from:'c2', to:'d2', captured:null }
  };
  const loss = calculateExpectedPointsLoss(before, after, 'b');
  assert.equal(formatExpectedPointsLoss(loss), '0.0%');

  const label = classifyMoveQuality({ row, before, after, loss });
  assert.equal(label.key, 'blunder');
  assert.equal(label.rawLoss, 4);
  assert.equal(label.gradingBasis, 'raw-evaluation');

  const explanation = explainMoveQuality({
    row, label, loss, rawPawnsLoss:label.rawLoss,
    bestSan:'dxe5', bestLineSan:'dxe5 Qxh8 Qxd4', replySan:'Nxd2', after
  });
  assert.match(explanation, /blunder/i);
  assert.match(explanation, /blunder/i);
  assert.match(explanation, /already very one-sided/i);
  assert.match(explanation, /A stronger choice was dxe5/i);
});

test('winning queen capture keeps the queen-capture safeguard even with a large raw swing', () => {
  const before = { whiteScore:8.5, score:{ type:'cp', value:850 }, bestMove:'e2e4' };
  const after = { whiteScore:5.0, score:{ type:'cp', value:-500 } };
  const row = { color:'w', uci:'d4d5', san:'Rxd5', move:{ piece:'r', from:'d4', to:'d5', captured:'q' } };
  const loss = calculateExpectedPointsLoss(before, after, 'w');
  const label = classifyMoveQuality({ row, before, after, loss });
  assert.equal(label.queenCaptureProtected, true);
  assert.notEqual(label.key, 'blunder');
});
