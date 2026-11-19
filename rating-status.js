'use strict';

const RATING_PLACEMENT_GAMES = 5;

function publicPlayer(user) {
  const games = Number(user?.games) || 0;
  const ratingReady = !!user?.authed && games >= RATING_PLACEMENT_GAMES;
  return {
    rating: ratingReady ? Math.round(user.rating) : null,
    rd: ratingReady ? user.rd : null,
    games, ratingReady,
    placementGamesRemaining: user?.authed ? Math.max(0, RATING_PLACEMENT_GAMES - games) : null
  };
}

module.exports = { RATING_PLACEMENT_GAMES, publicPlayer };
