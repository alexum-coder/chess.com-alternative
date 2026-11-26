import test from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import {
  scoreToWhitePawns,
  parseUciInfoLine,
  calculateMoveLoss,
  calculateExpectedPointsLoss,
  expectedScoreFromPawns,
  classifyMoveQuality,
  detectMissedOpportunity,
  explainMoveQuality,
  isKnownBookPrefix,
  getBookOpenings,
  getBookOptions
} from '../review-scoring.mjs';

test('converts UCI centipawn scores from side-to-move to White perspective', () => {
  assert.equal(scoreToWhitePawns({ type:'cp', value:125 }, 'w'), 1.25);
  assert.equal(scoreToWhitePawns({ type:'cp', value:125 }, 'b'), -1.25);
});

test('converts mate scores with the correct side-to-move sign', () => {
  assert.ok(scoreToWhitePawns({ type:'mate', value:3 }, 'w') > 0);
  assert.ok(scoreToWhitePawns({ type:'mate', value:3 }, 'b') < 0);
  assert.ok(scoreToWhitePawns({ type:'mate', value:-3 }, 'b') > 0);
});

test('ignores Stockfish bound scores and non-primary MultiPV lines', () => {
  assert.equal(parseUciInfoLine('info depth 18 score cp 400 lowerbound pv e2e4', 'w'), null);
  assert.equal(parseUciInfoLine('info depth 18 multipv 2 score cp 400 pv e2e4', 'w'), null);
  assert.equal(parseUciInfoLine('info depth 18 score cp 400 pv e2e4 e7e5', 'w').whiteScore, 4);
});


test('parses Stockfish WDL as expected points from White perspective', () => {
  const whiteToMove = parseUciInfoLine('info depth 18 score cp 35 wdl 700 200 100 pv e2e4 e7e5', 'w');
  const blackToMove = parseUciInfoLine('info depth 18 score cp 35 wdl 700 200 100 pv e7e5 e2e4', 'b');
  assert.equal(whiteToMove.whiteExpectedPoints, 0.8);
  assert.equal(blackToMove.whiteExpectedPoints, 0.2);
});

test('expected-score loss prefers Stockfish WDL when present', () => {
  const before = { whiteScore:0.1, whiteExpectedPoints:0.96 };
  const after = { whiteScore:0.4, whiteExpectedPoints:0.68 };
  assert.ok(Math.abs(calculateExpectedPointsLoss(before, after, 'w') - 0.28) < 1e-9);
  assert.ok(Math.abs(calculateExpectedPointsLoss(before, after, 'b')) < 1e-9);
});

test('expected-score curve compresses large advantages', () => {
  assert.equal(expectedScoreFromPawns(0), 0.5);
  assert.ok(expectedScoreFromPawns(5) > 0.99);
  assert.ok(expectedScoreFromPawns(2) > expectedScoreFromPawns(1));
  const before = { whiteScore:8.5 };
  const after = { whiteScore:5 };
  assert.equal(calculateMoveLoss(before, after, 'w'), 3.5);
  assert.ok(calculateExpectedPointsLoss(before, after, 'w') < 0.02);
});

test('a large raw swing in an already-won position is not a blunder', () => {
  const before = { whiteScore:8.5, bestMove:'e4', score:{ type:'cp', value:850 } };
  const after = { whiteScore:5, score:{ type:'cp', value:-500 } };
  const row = { color:'w', uci:'d4d5', move:{ captured:'q' }, san:'Rxd5', checkmate:false };
  const loss = calculateExpectedPointsLoss(before, after, 'w');
  const label = classifyMoveQuality({ row, before, after, loss });
  assert.notEqual(label.key, 'blunder');
  assert.equal(label.queenCaptureProtected, true);
  assert.equal(label.key, 'excellent');
  assert.match(explainMoveQuality({ row, label, loss, after }), /opponent’s queen/i);
});

test('queen capture cannot be labelled a blunder while the resulting position is still clearly favourable', () => {
  const before = { whiteScore:4.5, bestMove:'e4', score:{ type:'cp', value:450 } };
  const after = { whiteScore:1.0, score:{ type:'cp', value:-100 } };
  const row = { color:'w', uci:'d4d5', move:{ captured:'q' }, san:'Rxd5', checkmate:false };
  const loss = calculateExpectedPointsLoss(before, after, 'w');
  assert.ok(loss > 0.20, 'test position should be a raw expected-score blunder before the queen safeguard');
  const label = classifyMoveQuality({ row, before, after, loss });
  assert.equal(label.queenCaptureProtected, true);
  assert.equal(label.key, 'inaccuracy');
  assert.ok(label.effectiveLoss <= 0.095);
});


test('queen capture with clear WDL advantage is never a blunder without forced mate', () => {
  const before = { whiteScore:7.0, whiteExpectedPoints:0.995, bestMove:'e4', score:{ type:'cp', value:700 } };
  const after = { whiteScore:0.7, whiteExpectedPoints:0.70, score:{ type:'cp', value:-70 } };
  const row = { color:'w', uci:'d4d5', move:{ captured:'q' }, san:'Rxd5', checkmate:false };
  const loss = calculateExpectedPointsLoss(before, after, 'w');
  const label = classifyMoveQuality({ row, before, after, loss });
  assert.equal(label.queenCaptureProtected, true);
  assert.notEqual(label.key, 'blunder');
});

test('does not protect a queen capture that allows forced mate for the opponent', () => {
  const before = { whiteScore:0.1, bestMove:'e2e4', score:{ type:'cp', value:10 } };
  // Black is to move and has a forced mate: positive mate score for Black.
  const after = { whiteScore:-99.97, score:{ type:'mate', value:3 } };
  const row = { color:'w', uci:'d4d5', move:{ captured:'q' }, san:'Rxd5', checkmate:false };
  const loss = calculateExpectedPointsLoss(before, after, 'w');
  const label = classifyMoveQuality({ row, before, after, loss });
  assert.equal(label.key, 'blunder');
  assert.equal(label.queenCaptureProtected, false);
  assert.match(explainMoveQuality({ row, label, loss, after, replySan:'Qh1#' }), /forced mating sequence/i);
});

test('calculates Black move loss without flipping evaluation twice', () => {
  const before = { whiteScore:-3.0 };
  const after = { whiteScore:-0.5 };
  assert.equal(calculateMoveLoss(before, after, 'b'), 2.5);
  assert.ok(calculateExpectedPointsLoss(before, after, 'b') > 0.2);
});

test('recognises a move as Book only while its full opening prefix is known', () => {
  assert.equal(isKnownBookPrefix(['e2e4']), true);
  assert.equal(isKnownBookPrefix(['e2e4','e7e5','g1f3','b8c6','b1c3','g8f6']), true);
  assert.equal(isKnownBookPrefix(['e2e4','e7e5','g1f3','b8c6','b1c3','g8f6','f1b5']), false);
});

test('opening book lists playable candidate moves from the current prefix', () => {
  const firstMoves = getBookOptions([]).map(option => option.uci);
  assert.ok(firstMoves.includes('e2e4'));
  assert.ok(firstMoves.includes('d2d4'));
  assert.ok(firstMoves.includes('c2c4'));
  assert.ok(firstMoves.includes('g1f3'));

  const replies = getBookOptions(['e2e4']).map(option => option.uci);
  for (const move of ['e7e5','c7c5','e7e6','c7c6','d7d6']) assert.ok(replies.includes(move));
});

test('opening book options group transpositions by move and provide named continuations', () => {
  const options = getBookOptions(['e2e4','e7e5','g1f3','b8c6']);
  const moves = new Map(options.map(option => [option.uci, option]));
  assert.deepEqual([...moves.keys()].sort(), ['b1c3','d2d4','f1b5','f1c4']);
  assert.ok(moves.get('f1b5').openings.includes('Ruy López'));
  assert.ok(moves.get('f1c4').continuations[0].length > 1);
  assert.deepEqual(getBookOpenings(['e2e4','e7e5','g1f3']).sort(), [
    'Four Knights Game','Italian Game','Ruy López','Scotch Game'
  ].sort());
});

test('book explanations identify the opening variation instead of a generic grade', () => {
  const row = { san:'Nf3', bookOpenings:['Ruy López','Italian Game'] };
  const label = { key:'book' };
  const text = explainMoveQuality({ row, label });
  assert.match(text, /Ruy López, Italian Game/);
  assert.match(text, /well-known openings/i);
});

test('a top engine move is Best, not automatically Brilliant', () => {
  const before = { whiteScore:0.1, bestMove:'e2e4' };
  const after = { whiteScore:0.1 };
  const row = { color:'w', uci:'e2e4', move:{ piece:'p' }, san:'e4' };
  const label = classifyMoveQuality({ row, before, after, loss:0 });
  assert.equal(label.key, 'best');
});

test('validates the previously supplied game line and identifies Qxc7 correctly', () => {
  const game = new Chess();
  const line = [
    'e4','e5','Nf3','Nc6','Nc3','Nf6','d4','exd4','Nxd4','Bb4','a3','Bxc3+',
    'bxc3','Nxe4','Nxc6','bxc6','Bd3','Nxc3','Qd2','Qe7+','Be2','Ba6','O-O',
    'Nxe2+','Kh1','Nxc1','Qxc1','Bxf1','Qxf1','O-O','Qa6','h6','Qb7','Qe5','Qxc7','Qxa1#'
  ];
  let qxc7 = null;
  for (const san of line) {
    const move = game.move(san);
    assert.ok(move, `expected legal move ${san}`);
    if (san === 'Qxc7') qxc7 = move;
  }
  assert.equal(qxc7?.captured, 'p', 'Qxc7 captures the c7 pawn, not the queen');
  assert.equal(game.isCheckmate(), true, 'Qxa1# is checkmate');
});


test('move explanations describe central pawn moves and piece development', () => {
  const centre = explainMoveQuality({
    row:{ san:'e4', color:'w', move:{ piece:'p', from:'e2', to:'e4' } },
    label:{ key:'best' }, after:{ whiteScore:0.2 }
  });
  assert.match(centre, /push your e-pawn into the centre/i);
  assert.doesNotMatch(centre, /expected-score|centipawn|WDL|Stockfish preferred/i);

  const development = explainMoveQuality({
    row:{ san:'Nf3', color:'w', move:{ piece:'n', from:'g1', to:'f3' } },
    label:{ key:'best' }, after:{ whiteScore:0.2 }
  });
  assert.match(development, /bring your knight into the game/i);
  assert.doesNotMatch(development, /minor piece|centralises|expected-score/i);
});

test('move explanations name captures, checks, and castling accurately', () => {
  const capture = explainMoveQuality({
    row:{ san:'Rxe8+', color:'w', move:{ piece:'r', from:'e1', to:'e8', captured:'q' } },
    label:{ key:'excellent' }, loss:0.01, after:{ whiteScore:3.2 }
  });
  assert.match(capture, /takes the opponent’s queen on e8/i);
  assert.match(capture, /puts the opponent’s king in check/i);

  const castle = explainMoveQuality({
    row:{ san:'O-O', color:'w', move:{ piece:'k', from:'e1', to:'g1', flags:'k' } },
    label:{ key:'best' }, after:{ whiteScore:0.3 }
  });
  assert.match(castle, /castle on the king’s side/i);
  assert.doesNotMatch(castle, /move your king from e1 to g1/i);
});


test('calibrated grading avoids promoting ordinary engine swings to Blunders', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{ piece:'p', from:'a2', to:'a3' } };
  const before = { whiteScore:0.2, score:{type:'cp',value:20}, bestMove:'e2e4' };
  const afterMistake = { whiteScore:-0.8, score:{type:'cp',value:-80} };
  const mistakeLoss = calculateExpectedPointsLoss(before, afterMistake, 'w');
  const mistake = classifyMoveQuality({row,before,after:afterMistake,loss:mistakeLoss});
  assert.notEqual(mistake.key, 'blunder');

  const afterLarge = { whiteScore:-1.1, score:{type:'cp',value:-110} };
  const largeLoss = calculateExpectedPointsLoss(before, afterLarge, 'w');
  const large = classifyMoveQuality({row,before,after:afterLarge,loss:largeLoss});
  assert.equal(large.key, 'blunder');
});

test('raw evaluation swings only escalate when the resulting position is truly bad', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{piece:'p',from:'a2',to:'a3'} };
  const before = { whiteScore:8, score:{type:'cp',value:800}, bestMove:'e2e4' };
  const afterStillWinning = { whiteScore:4, score:{type:'cp',value:400} };
  const label = classifyMoveQuality({row,before,after:afterStillWinning,loss:0.001});
  assert.notEqual(label.key, 'blunder');
  assert.equal(label.key, 'inaccuracy');
});

test('detects a missed rook capture and labels it Miss', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{piece:'p',from:'a2',to:'a3',captured:null} };
  const before = { turn:'w', bestMove:'e2e4', score:{type:'cp',value:10} };
  const after = { turn:'b', score:{type:'cp',value:0} };
  const missedOpportunity = detectMissedOpportunity({
    row,before,after,
    bestMoveDetails:{uci:'e2e4',from:'e2',to:'e8',captured:'r',san:'Rxe8+'}
  });
  assert.deepEqual(missedOpportunity,{type:'piece',piece:'r',square:'e8',bestSan:'Rxe8+'});
  row.missedOpportunity = missedOpportunity;
  const label = classifyMoveQuality({row,before,after,loss:0.08});
  assert.equal(label.key,'miss');
  const text = explainMoveQuality({row,label,loss:0.08,after});
  assert.match(text,/Missed chance:/);
  assert.match(text,/could have won your opponent’s rook on e8/i);
});

test('detects a missed forced mate but not when the played move keeps the mating win', () => {
  const row = { color:'w', uci:'a2a3', san:'a3', move:{piece:'p',from:'a2',to:'a3'} };
  const before = { turn:'w', score:{type:'mate',value:2} };
  const afterNoMate = { turn:'b', score:{type:'cp',value:300} };
  const bestMoveDetails = {uci:'e2e4',from:'e2',to:'e8',san:'Qh8#'};
  assert.equal(detectMissedOpportunity({row,before,after:afterNoMate,bestMoveDetails}).type,'mate');
  const afterStillMate = { turn:'b', score:{type:'mate',value:-3} };
  assert.equal(detectMissedOpportunity({row,before,after:afterStillMate,bestMoveDetails}),null);
});

test('does not call a missed piece capture when the played move wins a more valuable piece', () => {
  const row = { color:'w', uci:'a2a3', san:'Rxa8', move:{piece:'r',from:'a2',to:'a8',captured:'q'} };
  const opportunity = detectMissedOpportunity({
    row,before:{turn:'w'},after:{score:{type:'cp',value:0}},
    bestMoveDetails:{uci:'e2e4',from:'e2',to:'e8',captured:'r',san:'Rxe8'}
  });
  assert.equal(opportunity,null);
});
