import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateExpectedPointsLoss,
  classifyMoveQuality,
  detectMissedOpportunity,
  explainMoveQuality
} from '../review-scoring.mjs';

test('ordinary 1-pawn inaccuracies do not become Blunders', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{piece:'p',from:'a2',to:'a3'} };
  const before = { whiteScore:0.2, score:{type:'cp',value:20}, bestMove:'e2e4' };
  const after = { whiteScore:-0.8, score:{type:'cp',value:-80} };
  const loss = calculateExpectedPointsLoss(before,after,'w');
  assert.equal(classifyMoveQuality({row,before,after,loss}).key,'mistake');
});

test('a raw four-pawn drop while already lost remains a Blunder despite WDL saturation', () => {
  const row = { color:'b', uci:'c2d2', san:'Rd2', move:{piece:'r',from:'c2',to:'d2'} };
  const before = { whiteScore:5, whiteExpectedPoints:.99995, score:{type:'cp',value:-500}, bestMove:'d6e5' };
  const after = { whiteScore:9, whiteExpectedPoints:1, score:{type:'cp',value:-900} };
  const loss = calculateExpectedPointsLoss(before,after,'b');
  assert.equal(classifyMoveQuality({row,before,after,loss}).key,'blunder');
});

test('a similar raw swing while still comfortably winning is downgraded', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{piece:'p',from:'a2',to:'a3'} };
  const before = { whiteScore:8, score:{type:'cp',value:800}, bestMove:'e2e4' };
  const after = { whiteScore:4, score:{type:'cp',value:400} };
  const label = classifyMoveQuality({row,before,after,loss:.001});
  assert.equal(label.key,'inaccuracy');
});

test('a missed major-piece capture becomes a light-red Miss grade', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{piece:'p',from:'a2',to:'a3'} };
  const opportunity = detectMissedOpportunity({
    row, before:{turn:'w'}, after:{turn:'b',score:{type:'cp',value:0}},
    bestMoveDetails:{uci:'e2e4',to:'e8',captured:'r',san:'Rxe8+'}
  });
  assert.equal(opportunity.type,'piece');
  row.missedOpportunity = opportunity;
  const label = classifyMoveQuality({row,before:{whiteScore:0},after:{whiteScore:0},loss:.05});
  assert.equal(label.key,'miss');
  assert.match(explainMoveQuality({row,label,loss:.05,after:{whiteScore:0}}),/Miss:/);
});

test('a missed forced mate becomes Miss, unless the played move keeps the mate', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{piece:'p',from:'a2',to:'a3'} };
  const before = { turn:'w', score:{type:'mate',value:2} };
  const bestMoveDetails = {uci:'e2e4',san:'Qh8#'};
  const missed = detectMissedOpportunity({row,before,after:{score:{type:'cp',value:300}},bestMoveDetails});
  assert.equal(missed.type,'mate');
  const kept = detectMissedOpportunity({row,before,after:{score:{type:'mate',value:-3}},bestMoveDetails});
  assert.equal(kept,null);
});
