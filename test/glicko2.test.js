'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { updateGlicko2 } = require('../glicko2');

test('Glicko-2 known example: wins against a stronger opponent', () => {
  const result = updateGlicko2(
    { rating: 1500, rd: 200, volatility: 0.06 },
    [{ rating: 1400, rd: 30, score: 1 }]
  );
  assert.equal(result.rating, 1564);
  assert.ok(result.rd > 0 && result.rd < 200);
  assert.ok(result.volatility > 0 && result.volatility < 0.2);
});

test('Glicko-2 published three-opponent example', () => {
  const result = updateGlicko2(
    { rating: 1500, rd: 200, volatility: 0.06 },
    [
      { rating: 1400, rd: 30, score: 1 },
      { rating: 1550, rd: 100, score: 0 },
      { rating: 1700, rd: 300, score: 0 }
    ]
  );
  assert.equal(result.rating, 1464);
  assert.ok(Math.abs(result.rd - 151.5165) < 0.01);
});

test('rating movement is symmetric for a decisive game', () => {
  const white = updateGlicko2({ rating: 1500, rd: 100, volatility: 0.06 }, [
    { rating: 1500, rd: 100, score: 1 }
  ]);
  const black = updateGlicko2({ rating: 1500, rd: 100, volatility: 0.06 }, [
    { rating: 1500, rd: 100, score: 0 }
  ]);
  assert.equal(white.rating - 1500, 1500 - black.rating);
});

test('draws do not move equal players materially and no-result periods increase RD', () => {
  const draw = updateGlicko2({ rating: 1500, rd: 80, volatility: 0.06 }, [
    { rating: 1500, rd: 80, score: 0.5 }
  ]);
  const inactive = updateGlicko2({ rating: 1500, rd: 80, volatility: 0.06 }, []);
  assert.equal(draw.rating, 1500);
  assert.ok(inactive.rd > 80);
});
