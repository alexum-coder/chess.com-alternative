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
  assert.match(explanation, /blunder/i);
  assert.match(explanation, /Qh5\+/);
  assert.doesNotMatch(explanation, /undefined/);
});


test('move explanations use plain language instead of engine jargon', () => {
  const openingMove = explainMoveQuality({
    row:{ san:'e4', color:'w', move:{piece:'p',from:'e2',to:'e4'} },
    label:{key:'best'}, after:{whiteScore:0.2}
  });
  assert.match(openingMove, /push your e-pawn into the centre/i);
  assert.match(openingMove, /engine’s top choice/i);
  assert.doesNotMatch(openingMove, /expected-score|centipawn|WDL|Stockfish preferred|minor piece/i);

  const capture = explainMoveQuality({
    row:{san:'Rxe8+', color:'w', move:{piece:'r',from:'e1',to:'e8',captured:'q'}},
    label:{key:'excellent'}, loss:0.01, after:{whiteScore:3.2}
  });
  assert.match(capture, /your rook takes the opponent’s queen on e8/i);
  assert.match(capture, /puts the opponent’s king in check/i);
  assert.doesNotMatch(capture, /expected-score points|pawns/i);

  const miss = explainMoveQuality({
    row:{san:'a3', color:'w', move:{piece:'p',from:'a2',to:'a3'}, missedOpportunity:{type:'piece',piece:'r',square:'e8',bestSan:'Rxe8+'}},
    label:{key:'miss'}, loss:0.05
  });
  assert.match(miss, /missed chance/i);
  assert.match(miss, /could have won your opponent’s rook/i);
});


test('casual explanations describe the move and its impact in everyday language', () => {
  const examples = [
    explainMoveQuality({
      row:{san:'Nf3',color:'w',move:{piece:'n',from:'g1',to:'f3'}},
      label:{key:'excellent'},loss:0.01,after:{whiteScore:0.7}
    }),
    explainMoveQuality({
      row:{san:'a3',color:'w',move:{piece:'p',from:'a2',to:'a3'}},
      label:{key:'inaccuracy'},loss:0.08,bestSan:'d4',after:{whiteScore:-0.4}
    }),
    explainMoveQuality({
      row:{san:'Qh5',color:'w',move:{piece:'q',from:'d1',to:'h5'}},
      label:{key:'mistake'},loss:0.2,bestSan:'Nf3',replySan:'g6',after:{whiteScore:-1.5}
    })
  ];
  for (const text of examples) {
    assert.doesNotMatch(text, /expected-score|centipawn|WDL|Stockfish preferred|raw evaluation|minor piece|counterplay/i);
  }
  assert.match(examples[0], /bring your knight into the game/i);
  assert.match(examples[1], /A stronger choice was d4/i);
  assert.match(examples[2], /real chance to take control/i);
});

test('book and checkmate explanations are understandable without engine terminology', () => {
  const book = explainMoveQuality({
    row:{san:'Nf3',bookOpenings:['Ruy López','Italian Game']},
    label:{key:'book'}
  });
  const mate = explainMoveQuality({
    row:{san:'Qh8#'},
    label:{key:'checkmate'}
  });
  assert.match(book, /well-known openings/i);
  assert.match(book, /studied for many years/i);
  assert.match(mate, /checkmate your opponent/i);
  assert.doesNotMatch(`${book} ${mate}`, /WDL|engine evaluation|expected-score/i);
});


test('blunder explanation names the queen, square, and engine capture that wins it', () => {
  const row = {
    san:'Qd7', color:'b',
    move:{piece:'q',from:'d8',to:'d7',captured:null}
  };
  const explanation = explainMoveQuality({
    row, label:{key:'blunder'}, loss:0.45, bestSan:'Qe7', replySan:'Re1+',
    after:{whiteScore:5.2},
    tacticalDetails:{
      netMaterialLoss:9, lostValue:9, wonValue:0,
      firstMajorLoss:{piece:'q',square:'d7',san:'Rxd7'},
      opponentCaptures:[{piece:'q',square:'d7',san:'Rxd7'}], playerCaptures:[]
    }
  });
  assert.match(explanation, /blunder because it leaves your queen on d7 vulnerable/i);
  assert.match(explanation, /win it with Rxd7/i);
  assert.match(explanation, /do not win any material back/i);
  assert.match(explanation, /stronger choice was Qe7/i);
});

test('mistake explanation describes a piece loss and the small amount won back', () => {
  const row = {
    san:'h3', color:'w',
    move:{piece:'p',from:'h2',to:'h3',captured:null}
  };
  const explanation = explainMoveQuality({
    row, label:{key:'mistake'}, loss:0.22, bestSan:'Nf3', replySan:'Nxa8',
    after:{whiteScore:-1.7},
    tacticalDetails:{
      netMaterialLoss:2, lostValue:3, wonValue:1,
      firstMajorLoss:{piece:'n',square:'a8',san:'Nxa8'},
      opponentCaptures:[{piece:'n',square:'a8',san:'Nxa8'}],
      playerCaptures:[{piece:'p',square:'b7',san:'cxb7'}]
    }
  });
  assert.match(explanation, /mistake because it leaves your knight on a8 vulnerable/i);
  assert.match(explanation, /win it with Nxa8/i);
  assert.match(explanation, /win a little material back/i);
});

test('blunder without a proven material tactic still explains the engine reply and safer move', () => {
  const explanation = explainMoveQuality({
    row:{san:'Rf1',color:'w',move:{piece:'r',from:'a1',to:'f1'}},
    label:{key:'blunder'},loss:0.4,bestSan:'Qh5+',replySan:'Qh5+',
    after:{whiteScore:-2.1}
  });
  assert.match(explanation, /blunder/i);
  assert.match(explanation, /strongest reply is Qh5\+/i);
  assert.match(explanation, /stronger choice was Qh5\+/i);
});
