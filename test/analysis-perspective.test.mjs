import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMoveQuality } from '../review-scoring.mjs';
import { readFile } from 'node:fs/promises';

const analysis = await readFile(new URL('../analysis.html', import.meta.url), 'utf8');
const profile = await readFile(new URL('../profile.html', import.meta.url), 'utf8');
const live = await readFile(new URL('../index.html', import.meta.url), 'utf8');

test('analysis describes Black moves as the opponent when the viewer played White', () => {
  const explanation = explainMoveQuality({
    row:{ color:'b', san:'Nf6', move:{ piece:'n', from:'g8', to:'f6' } },
    label:{ key:'best' }, after:{ whiteScore:1.8 }, viewerColor:'w'
  });
  assert.match(explanation, /Your opponent brings their knight into the game/i);
  assert.match(explanation, /You have a clear advantage/i);
});

test('analysis identifies opponent captures of the viewer own piece', () => {
  const explanation = explainMoveQuality({
    row:{ color:'b', san:'Bxc4', move:{ piece:'b', from:'f7', to:'c4', captured:'n' } },
    label:{ key:'good' }, after:{ whiteScore:0.2 }, viewerColor:'w'
  });
  assert.match(explanation, /Your opponent’s bishop takes your knight on c4/i);
});

test('analysis still describes Black moves as the viewer when the viewer played Black', () => {
  const explanation = explainMoveQuality({
    row:{ color:'b', san:'Nf6', move:{ piece:'n', from:'g8', to:'f6' } },
    label:{ key:'best' }, after:{ whiteScore:-1.8 }, viewerColor:'b'
  });
  assert.match(explanation, /You bring your knight into the game/i);
  assert.match(explanation, /You have a clear advantage/i);
});

test('all saved-game analysis entry points preserve the viewer colour', () => {
  assert.match(profile, /'&color=' \+ mine/);
  assert.match(live, /'&color=' \+ game\.color/);
  assert.match(analysis, /viewerColor = game\.source === 'computer' \? 'w'/);
  assert.match(analysis, /tacticalDetails, viewerColor/);
});

test('piece labels in the analysis detail distinguish the player and opponent', () => {
  assert.match(analysis, /`Your \$\{pieceName\}`/);
  assert.match(analysis, /`Your opponent’s \$\{pieceName\}`/);
});


test('an opponent blunder identifies the opponent piece you can win', () => {
  const explanation = explainMoveQuality({
    row:{ color:'b', san:'Qd7', move:{ piece:'q', from:'d8', to:'d7' } },
    label:{ key:'blunder' }, loss:0.45, bestSan:'Qe7', replySan:'Rxd7',
    after:{ whiteScore:5.2 }, viewerColor:'w',
    tacticalDetails:{
      netMaterialLoss:9, wonValue:0,
      firstMajorLoss:{ piece:'q', square:'d7', san:'Rxd7' }
    }
  });
  assert.match(explanation, /leaves your opponent’s queen on d7 vulnerable/i);
  assert.match(explanation, /You can win it with Rxd7/i);
  assert.match(explanation, /Your opponent does not win any material back/i);
});
