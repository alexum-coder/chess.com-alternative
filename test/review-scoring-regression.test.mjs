import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMoveQuality } from '../review-scoring.mjs';

test('blunder explanation does not throw on missing optional tactical detail', () => {
  const row = {
    san: 'Rf1', color: 'w',
    move: { piece:'r', from:'a1', to:'f1', captured:null }
  };
  const label = { key:'blunder', name:'Blunder' };
  const explanation = explainMoveQuality({
    row, label, loss:0.4, rawPawnsLoss:2.1,
    bestSan:'Qh5+', bestLineSan:'Qh5+ Kh7 Qf7', replySan:'Qh5+',
    after:{ whiteScore:-2.1 }
  });
  assert.match(explanation, /serious error/i);
  assert.match(explanation, /Qh5\+/);
  assert.doesNotMatch(explanation, /undefined/);
});
