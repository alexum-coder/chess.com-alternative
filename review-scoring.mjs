/**
 * Shared Stockfish score handling and practical move grading.
 * UCI scores are relative to the side to move. Convert them to White's POV once,
 * then compare the expected game score from the perspective of the player who moved.
 *
 * The expected-score curve prevents a large centipawn swing inside an already-won
 * position from being treated like a game-losing blunder.
 */

const MATE_SCORE = 100;
const EXPECTED_SCORE_SLOPE = 1.25;

export function scoreToWhitePawns(score, sideToMove) {
  if (!score || !Number.isFinite(Number(score.value))) return null;
  const raw = Number(score.value);
  const relative = score.type === 'mate'
    ? Math.sign(raw || 1) * (MATE_SCORE - Math.min(99, Math.abs(raw)) * 0.01)
    : raw / 100;
  return sideToMove === 'b' ? -relative : relative;
}

export function parseUciInfoLine(line, sideToMove) {
  if (typeof line !== 'string' || !line.startsWith('info ')) return null;
  // Bound values are not exact evaluations; MultiPV 2+ are not the principal line.
  if (/\b(?:lowerbound|upperbound)\b/.test(line)) return null;
  const multiPv = line.match(/\bmultipv\s+(\d+)/);
  if (multiPv && Number(multiPv[1]) !== 1) return null;
  const depthMatch = line.match(/\bdepth\s+(\d+)/);
  const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
  if (!depthMatch || !scoreMatch) return null;

  const score = { type:scoreMatch[1], value:Number(scoreMatch[2]), depth:Number(depthMatch[1]) };
  const pvMatch = line.match(/\bpv\s+(.+)$/);
  const wdlMatch = line.match(/\bwdl\s+(\d+)\s+(\d+)\s+(\d+)/);
  let whiteExpectedPoints = null;
  if (wdlMatch) {
    // WDL is ordered win/draw/loss from the engine's side-to-move perspective.
    // Convert it to expected points (win + half a draw) from White's perspective.
    const [wins, draws, losses] = wdlMatch.slice(1).map(Number);
    const total = wins + draws + losses;
    if (total > 0) {
      whiteExpectedPoints = sideToMove === 'w'
        ? (wins + draws / 2) / total
        : (losses + draws / 2) / total;
    }
  }
  return {
    score,
    depth:score.depth,
    turn:sideToMove,
    whiteScore:scoreToWhitePawns(score, sideToMove),
    whiteExpectedPoints,
    wdl:wdlMatch ? wdlMatch.slice(1).map(Number) : null,
    pv:pvMatch ? pvMatch[1].trim().split(/\s+/).filter(Boolean) : []
  };
}

export function scoreForColor(whiteScore, color) {
  if (!Number.isFinite(whiteScore)) return null;
  return color === 'b' ? -whiteScore : whiteScore;
}

// Raw pawn swing is useful as engine context, but it is not a good move-grade scale.
export function calculateMoveLoss(before, after, moverColor) {
  const beforeForMover = scoreForColor(before?.whiteScore, moverColor);
  const afterForMover = scoreForColor(after?.whiteScore, moverColor);
  if (!Number.isFinite(beforeForMover) || !Number.isFinite(afterForMover)) return null;
  return Math.max(0, beforeForMover - afterForMover);
}

export function expectedScoreFromPawns(pawns) {
  if (!Number.isFinite(pawns)) return null;
  const bounded = Math.max(-12, Math.min(12, pawns));
  return 1 / (1 + Math.exp(-EXPECTED_SCORE_SLOPE * bounded));
}

function expectedPointsForColor(analysis, color) {
  if (Number.isFinite(analysis?.whiteExpectedPoints)) {
    return color === 'b' ? 1 - analysis.whiteExpectedPoints : analysis.whiteExpectedPoints;
  }
  const pawns = scoreForColor(analysis?.whiteScore, color);
  return expectedScoreFromPawns(pawns);
}

export function calculateExpectedPointsLoss(before, after, moverColor) {
  const beforeExpected = expectedPointsForColor(before, moverColor);
  const afterExpected = expectedPointsForColor(after, moverColor);
  if (!Number.isFinite(beforeExpected) || !Number.isFinite(afterExpected)) return null;
  return Math.max(0, beforeExpected - afterExpected);
}

// A small, named repertoire for common opening main lines. This is a curated
// guide rather than a full Polyglot database: suggestions are shown only while
// the played move prefix exactly follows one of these legal lines.
const OPENING_BOOK_LINES = [
  { name:'Ruy López', moves:'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6 b5a4 g8f6 e1g1 f8e7', priority:1 },
  { name:'Italian Game', moves:'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6 d2d4 e5d4 c3d4', priority:1 },
  { name:'Four Knights Game', moves:'e2e4 e7e5 g1f3 b8c6 b1c3 g8f6', priority:2 },
  { name:'Scotch Game', moves:'e2e4 e7e5 g1f3 b8c6 d2d4 e5d4 f3d4', priority:2 },
  { name:'Sicilian Defense · Najdorf setup', moves:'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6', priority:1 },
  { name:'French Defense', moves:'e2e4 e7e6 d2d4 d7d5 b1c3 g8f6', priority:2 },
  { name:'Caro–Kann Defense', moves:'e2e4 c7c6 d2d4 d7d5 b1c3 d5e4 c3e4', priority:2 },
  { name:'Queen’s Gambit Declined', moves:'d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7', priority:1 },
  { name:'Slav Defense', moves:'d2d4 d7d5 c2c4 c7c6 g1f3 g8f6 b1c3 d5c4', priority:2 },
  { name:'King’s Indian Defense', moves:'d2d4 g8f6 c2c4 g7g6 b1c3 f8g7 e2e4 d7d6', priority:1 },
  { name:'Nimzo-Indian Defense', moves:'d2d4 g8f6 c2c4 e7e6 b1c3 f8b4', priority:2 },
  { name:'English Opening', moves:'c2c4 e7e5 b1c3 g8f6', priority:2 },
  { name:'Pirc Defense', moves:'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6', priority:2 },
  { name:'London System', moves:'d2d4 d7d5 c1f4 g8f6 e2e3 e7e6 g1f3 c7c5', priority:2 },
  { name:'Réti Opening', moves:'g1f3 d7d5 g2g3 g8f6 f1g2', priority:2 }
].map(line => ({ ...line, moves:line.moves.split(' ') }));

function followsBookLine(playedUci, line) {
  return Array.isArray(playedUci)
    && playedUci.length <= line.moves.length
    && playedUci.every((move, index) => line.moves[index] === move);
}

export function getBookOpenings(uciMoves) {
  if (!Array.isArray(uciMoves) || !uciMoves.length) return [];
  return OPENING_BOOK_LINES
    .filter(line => followsBookLine(uciMoves, line))
    .map(line => line.name);
}

export function isKnownBookPrefix(uciMoves) {
  return getBookOpenings(uciMoves).length > 0;
}

// Return the next known book choices from a position. Options are grouped by
// move, so one move can correctly belong to several named opening variations.
export function getBookOptions(playedUci) {
  if (!Array.isArray(playedUci)) return [];
  const grouped = new Map();
  for (const line of OPENING_BOOK_LINES) {
    if (!followsBookLine(playedUci, line) || playedUci.length >= line.moves.length) continue;
    const uci = line.moves[playedUci.length];
    if (!grouped.has(uci)) grouped.set(uci, { uci, openings:[], continuations:[], priority:line.priority });
    const option = grouped.get(uci);
    option.openings.push(line.name);
    option.continuations.push(line.moves.slice(playedUci.length));
    option.priority = Math.min(option.priority, line.priority);
  }
  return [...grouped.values()]
    .sort((a,b) => a.priority-b.priority || a.openings[0].localeCompare(b.openings[0]));
}

const LABELS = {
  book: { key:'book', icon:'▤', name:'Book' },
  brilliant: { key:'brilliant', icon:'!!', name:'Brilliant' },
  best: { key:'best', icon:'✓', name:'Best' },
  great: { key:'great', icon:'!', name:'Great' },
  excellent: { key:'excellent', icon:'★', name:'Excellent' },
  good: { key:'good', icon:'○', name:'Good' },
  inaccuracy: { key:'inaccuracy', icon:'?!', name:'Inaccuracy' },
  mistake: { key:'mistake', icon:'?', name:'Mistake' },
  blunder: { key:'blunder', icon:'??', name:'Blunder' },
  missedWin: { key:'missed-win', icon:'??', name:'Missed win' },
  checkmate: { key:'checkmate', icon:'♔', name:'Checkmate' }
};

function classifyByExpectedLoss(loss) {
  // Approximate expected-points thresholds: 0.02 / 0.05 / 0.10 / 0.20.
  if (loss <= 0.02) return LABELS.excellent;
  if (loss <= 0.05) return LABELS.good;
  if (loss <= 0.10) return LABELS.inaccuracy;
  if (loss <= 0.20) return LABELS.mistake;
  return LABELS.blunder;
}

export function classifyMoveQuality({ row, before, after, loss, soundSacrifice = false }) {
  if (row?.checkmate) return { ...LABELS.checkmate, effectiveLoss:0, queenCaptureProtected:false };
  if (row?.book) return { ...LABELS.book, effectiveLoss:0, queenCaptureProtected:false };
  if (!Number.isFinite(loss)) return { ...LABELS.good, effectiveLoss:0, queenCaptureProtected:false, uncertain:true };

  const moverBefore = scoreForColor(before?.whiteScore, row?.color);
  const moverAfter = scoreForColor(after?.whiteScore, row?.color);
  const moverAfterExpected = expectedPointsForColor(after, row?.color);
  const bestMatch = Boolean(before?.bestMove && before.bestMove === row?.uci);
  // After the player's move it is the opponent's turn. A positive mate score means
  // that side (the opponent) can force mate, so a queen-capture safeguard must not apply.
  const opponentHasForcedMate = after?.score?.type === 'mate' && Number(after.score.value) > 0;

  if (!opponentHasForcedMate && moverBefore >= 2.5 && (moverAfter <= 0.5 || (Number.isFinite(moverAfterExpected) && moverAfterExpected <= 0.5))) {
    return { ...LABELS.missedWin, effectiveLoss:loss, queenCaptureProtected:false };
  }

  // A queen capture is not automatically good: an immediate forced mate or a
  // position that still favours the opponent remains eligible for a blunder.
  // But if best play leaves the capturer with a clear expected-score advantage,
  // never call the queen-winning move a blunder just because centipawns swung.
  const queenCaptureProtected = row?.move?.captured === 'q'
    && !opponentHasForcedMate
    && Number.isFinite(moverAfterExpected)
    && moverAfterExpected >= 0.70;
  const effectiveLoss = queenCaptureProtected ? Math.min(loss, 0.095) : loss;

  if (bestMatch && soundSacrifice && moverBefore < 2.0 && moverAfter > -0.25) {
    return { ...LABELS.brilliant, effectiveLoss, queenCaptureProtected };
  }
  if (row?.legalMoveCount === 1 && effectiveLoss <= 0.10) {
    return { ...LABELS.great, effectiveLoss, queenCaptureProtected };
  }
  if (bestMatch) return { ...LABELS.best, effectiveLoss, queenCaptureProtected };
  if (moverBefore <= 0.25 && moverAfter >= 1.5 && effectiveLoss <= 0.02) {
    return { ...LABELS.great, effectiveLoss, queenCaptureProtected };
  }
  return { ...classifyByExpectedLoss(effectiveLoss), effectiveLoss, queenCaptureProtected };
}

export function formatWhiteEvaluation(analysis) {
  if (!analysis || !Number.isFinite(analysis.whiteScore)) return '—';
  if (analysis.score?.type === 'mate') {
    const sideWins = Number(analysis.score.value) > 0;
    const whiteWins = analysis.turn === 'b' ? !sideWins : sideWins;
    return `${whiteWins ? '' : '−'}M${Math.abs(Number(analysis.score.value))}`;
  }
  const value = analysis.whiteScore;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

export function formatExpectedPointsLoss(loss) {
  return Number.isFinite(loss) ? `${(loss * 100).toFixed(1)}%` : '—';
}

export function pieceName(piece) {
  return ({ p:'pawn', n:'knight', b:'bishop', r:'rook', q:'queen', k:'king' })[String(piece || '').toLowerCase()] || 'piece';
}

function positionPhrase(after, color) {
  const value = scoreForColor(after?.whiteScore, color);
  if (!Number.isFinite(value)) return 'The resulting position could not be evaluated reliably.';
  if (value >= 3) return 'The resulting position is winning for you.';
  if (value >= 1.25) return 'You keep a clear advantage.';
  if (value >= 0.35) return 'You retain a small advantage.';
  if (value <= -3) return 'The opponent has a decisive advantage.';
  if (value <= -1.25) return 'The opponent is now clearly better.';
  if (value <= -0.35) return 'The opponent has a small edge.';
  return 'The position remains approximately balanced.';
}

function describeMoveIntent(row) {
  const move = row?.move;
  if (!move) return 'This move changes the position.';
  const piece = String(move.piece || 'p').toLowerCase();
  const from = move.from || '—', to = move.to || '—';
  const file = to[0], rank = to[1];
  const pieceLabel = pieceName(piece);
  const facts = [];
  const san = String(row.san || '');
  const castle = san.startsWith('O-O-O') ? 'queenside' : san.startsWith('O-O') ? 'kingside' : '';

  if (castle) {
    facts.push(`Castles ${castle}, moving the king toward safety and connecting the rooks.`);
  } else if (move.captured) {
    facts.push(`Captures the opponent’s ${pieceName(move.captured)} on ${to}.`);
  } else if (piece === 'p' && ['d4','e4','d5','e5'].includes(to)) {
    facts.push(`Advances the pawn to ${to}, claiming space in the centre and contesting key central squares.`);
  } else if (piece === 'p') {
    const flank = 'abc'.includes(file) ? 'queenside' : 'fgh'.includes(file) ? 'kingside' : 'central';
    facts.push(`Advances the ${flank} pawn to ${to}, changing the pawn structure and the space available on that side.`);
  } else if ((piece === 'n' || piece === 'b') && ((row.color === 'w' && from[1] === '1') || (row.color === 'b' && from[1] === '8'))) {
    facts.push(`Develops the ${pieceLabel} from ${from} to ${to}, bringing a minor piece into play.`);
  } else if (piece === 'n' && 'cdef'.includes(file) && '3456'.includes(rank)) {
    facts.push(`Centralises the knight on ${to}, where it can influence more squares.`);
  } else if (piece === 'b') {
    facts.push(`Repositions the bishop from ${from} to ${to}, changing its diagonal and influence.`);
  } else if (piece === 'r') {
    facts.push(`Activates the rook from ${from} to ${to}, bringing it onto a new file or rank.`);
  } else if (piece === 'q') {
    facts.push(`Repositions the queen from ${from} to ${to}, changing its lines of attack and defence.`);
  } else if (piece === 'k') {
    facts.push(`Moves the king from ${from} to ${to}.`);
  } else {
    facts.push(`Moves the ${pieceLabel} from ${from} to ${to}.`);
  }

  if (String(move.flags || '').includes('e')) facts.push('This is an en passant capture.');
  if (san.includes('#')) facts.push('It delivers checkmate.');
  else if (san.includes('+')) facts.push('It gives check.');
  if (move.promotion) facts.push(`The pawn promotes to a ${pieceName(move.promotion)}.`);
  if (row.wasInCheck && !String(row.san || '').includes('+') && !String(row.san || '').includes('#')) facts.push('The move also gets your king out of check.');
  return facts.join(' ');
}

export function explainMoveQuality({ row, label, loss, rawPawnsLoss, bestSan, bestLineSan, replySan, after, replyCapturesMovedPiece = false, replyTacticalText = '' }) {
  if (label.key === 'checkmate') return `${row.san} is checkmate. The game ends immediately.`;
  if (label.key === 'book') {
    const openings = Array.isArray(row.bookOpenings) ? row.bookOpenings : [];
    return openings.length
      ? `This move follows recognised ${openings.slice(0, 3).join(', ')} theory. The move is part of an established opening plan; it is not being graded as a tactical achievement.`
      : 'This move follows a recognised opening-theory sequence.';
  }

  const intent = describeMoveIntent(row);
  const alternative = bestSan && bestSan !== row.san ? ` Stockfish preferred ${bestSan}.` : '';
  const continuation = bestLineSan && bestSan && bestSan !== row.san ? ` Its best continuation is ${bestLineSan}.` : '';
  const reply = replySan ? ` The strongest reply is ${replySan}. ${replyTacticalText}` : '';
  const pointsText = `${formatExpectedPointsLoss(loss)} expected-score points`;
  const positionText = positionPhrase(after, row.color);
  const opponentHasForcedMate = after?.score?.type === 'mate' && Number(after.score.value) > 0;

  if (row.move?.captured === 'q') {
    if (opponentHasForcedMate) {
      return `${intent} Despite winning the queen, the resulting position allows a forced mating sequence.${reply}${alternative}${continuation}`;
    }
    if (replyCapturesMovedPiece) {
      return `${intent} The engine’s reply ${replySan} can immediately recapture the piece that took the queen. The full exchange, not just the queen capture, determines the grade.${positionText}${alternative}${continuation}`;
    }
    if (label.queenCaptureProtected) {
      return `${intent} Best-play analysis still gives you at least a 70% expected score, with no forced mate found against you. The queen win is therefore not treated as a blunder.${positionText}${alternative}${continuation}${reply}`;
    }
    return `${intent} ${positionText}${label.key === 'blunder' ? ' The engine finds a concrete tactical refutation.' : ` The move costs about ${pointsText}.`}${reply}${alternative}${continuation}`;
  }

  if (label.key === 'brilliant') {
    return `${intent} This is a rare, engine-approved sacrifice: the opponent can take the offered piece, but the strongest continuation declines it because the compensation is sufficient.${reply}${continuation}`;
  }
  if (label.key === 'best') {
    return `${intent} This is Stockfish’s top move at the selected depth. ${positionText}${reply}`;
  }
  if (label.key === 'great') {
    return `${intent} A critical find: it is the only legal move or turns an inferior position into a clearly favourable one. ${positionText}${reply}${continuation}`;
  }
  if (label.key === 'excellent') {
    return `${intent} A very accurate choice, giving up only ${pointsText} compared with the engine’s best continuation. ${positionText}${alternative}${continuation}${reply}`;
  }
  if (label.key === 'good') {
    return `${intent} A sound move that preserves most of the position’s value. A more precise option was available.${positionText}${alternative}${continuation}${reply}`;
  }
  if (label.key === 'inaccuracy') {
    return `${intent} This gives away about ${pointsText} and makes the opponent’s task easier. ${positionText}${alternative}${continuation}${reply}`;
  }
  if (label.key === 'mistake') {
    return `${intent} This is a meaningful error, losing about ${pointsText} of expected score. ${positionText}${alternative}${continuation}${reply}`;
  }
  if (label.key === 'missed-win') {
    return `${intent} The position contained a winning continuation, but this move lets the opponent escape with a much better result.${alternative}${continuation}${reply}`;
  }
  const rawNote = Number.isFinite(rawPawnsLoss) && rawPawnsLoss >= 1 ? ` The raw evaluation also shifted by ${rawPawnsLoss.toFixed(1)} pawns.` : '';
  return `${intent} This is a serious error, losing about ${pointsText} of expected score. ${positionText}${rawNote}${alternative}${continuation}${reply}`;
}
