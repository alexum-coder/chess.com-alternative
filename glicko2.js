'use strict';

// Glicko-2 implementation (one rating period per finished game).
// Ratings remain on the familiar chess scale; deviation is expressed in rating points.
const SCALE = 173.7178;
const PI2 = Math.PI * Math.PI;
const DEFAULT_TAU = 0.5;
const EPSILON = 1e-7;

function g(phi) {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / PI2);
}

function expected(mu, opponentMu, opponentPhi) {
  return 1 / (1 + Math.exp(-g(opponentPhi) * (mu - opponentMu)));
}

function volatilityRoot(phi, sigma, delta, variance, tau) {
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const numerator = ex * (delta * delta - phi * phi - variance - ex);
    const denominator = 2 * Math.pow(phi * phi + variance + ex, 2);
    return numerator / denominator - (x - a) / (tau * tau);
  };

  let A = a;
  let B;
  if (delta * delta > phi * phi + variance) {
    B = Math.log(delta * delta - phi * phi - variance);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 100) k++;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  let iterations = 0;
  while (Math.abs(B - A) > EPSILON && iterations++ < 100) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * Calculate a player's new Glicko-2 values after a rating period.
 * results: [{ rating, rd, score }] where score is 1 (win), 0.5 (draw), or 0 (loss).
 */
function updateGlicko2(player, results, tau = DEFAULT_TAU) {
  const rating = Number.isFinite(+player.rating) ? +player.rating : 1200;
  const rd = Math.min(350, Math.max(30, Number.isFinite(+player.rd) ? +player.rd : 350));
  const volatility = Math.min(0.2, Math.max(0.01, Number.isFinite(+player.volatility) ? +player.volatility : 0.06));
  const usable = (Array.isArray(results) ? results : []).filter((r) =>
    r && Number.isFinite(+r.rating) && Number.isFinite(+r.rd) && [0, 0.5, 1].includes(+r.score)
  );

  // With no games in a rating period, only uncertainty increases.
  const mu = (rating - 1500) / SCALE;
  const phi = rd / SCALE;
  if (!usable.length) {
    return {
      rating: Math.round(rating),
      rd: Math.min(350, SCALE * Math.sqrt(phi * phi + volatility * volatility)),
      volatility
    };
  }

  let sum = 0;
  let varianceSum = 0;
  for (const result of usable) {
    const oppMu = (+result.rating - 1500) / SCALE;
    const oppPhi = Math.min(350, Math.max(30, +result.rd)) / SCALE;
    const E = expected(mu, oppMu, oppPhi);
    const impact = g(oppPhi);
    varianceSum += impact * impact * E * (1 - E);
    sum += impact * (+result.score - E);
  }
  if (varianceSum <= 0) return { rating: Math.round(rating), rd, volatility };

  const variance = 1 / varianceSum;
  const delta = variance * sum;
  const newVolatility = volatilityRoot(phi, volatility, delta, variance, tau);
  const phiStar = Math.sqrt(phi * phi + newVolatility * newVolatility);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / variance);
  const newMu = mu + newPhi * newPhi * sum;

  return {
    rating: Math.round(1500 + SCALE * newMu),
    rd: Math.min(350, Math.max(30, SCALE * newPhi)),
    volatility: newVolatility
  };
}

module.exports = { updateGlicko2 };
