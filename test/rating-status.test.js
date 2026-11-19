'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { publicPlayer, RATING_PLACEMENT_GAMES } = require('../rating-status');

test('new accounts keep numeric rating hidden through their first four matches', () => {
  for (let games = 0; games < RATING_PLACEMENT_GAMES; games++) {
    const player = publicPlayer({ authed: true, games, rating: 1375, rd: 120 });
    assert.equal(player.rating, null);
    assert.equal(player.ratingReady, false);
    assert.equal(player.placementGamesRemaining, 5 - games);
  }
});

test('rating becomes public after the fifth completed match', () => {
  assert.deepEqual(publicPlayer({ authed: true, games: 5, rating: 1375.6, rd: 120 }), {
    rating: 1376, rd: 120, games: 5, ratingReady: true, placementGamesRemaining: 0
  });
});

test('guest ratings are not shown', () => {
  const player = publicPlayer({ authed: false, games: 40, rating: 1800, rd: 40 });
  assert.equal(player.rating, null);
  assert.equal(player.ratingReady, false);
});
