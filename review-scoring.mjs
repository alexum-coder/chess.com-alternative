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
  missedWin: { key:'missed-win', icon:'?!', name:'Missed win' },
  miss: { key:'miss', icon:'×', name:'Miss' },
  checkmate: { key:'checkmate', icon:'♔', name:'Checkmate' }
};

function classifyByExpectedLoss(loss) {
  // Use wider bands than the previous build: small WDL changes are common at
  // low depth and should not inflate the Blunder count.
  if (loss <= 0.02) return LABELS.excellent;
  if (loss <= 0.05) return LABELS.good;
  if (loss <= 0.12) return LABELS.inaccuracy;
  if (loss <= 0.35) return LABELS.mistake;
  return LABELS.blunder;
}

const QUALITY_RANK = { excellent:0, good:1, inaccuracy:2, mistake:3, blunder:4 };

function classifyByRawEvaluationLoss(rawLoss, moverAfter, expectedLoss) {
  if (!Number.isFinite(rawLoss)) return null;
  // Raw centipawn jumps can be noisy, especially in already-decided positions.
  // Only use them as a guardrail for large, meaningful swings; don't turn every
  // 1-2 pawn fluctuation into a mistake or blunder.
  if (rawLoss >= 4.0) {
    if (moverAfter <= 0.5) return LABELS.blunder;
    if (moverAfter <= 2.5) return LABELS.mistake;
    return LABELS.inaccuracy;
  }
  if (rawLoss >= 2.5 && expectedLoss >= 0.10) return LABELS.mistake;
  if (rawLoss >= 1.5 && expectedLoss >= 0.05) return LABELS.inaccuracy;
  if (rawLoss >= 0.8 && expectedLoss >= 0.025) return LABELS.good;
  return null;
}

/**
 * Detect a genuine missed tactical opportunity.
 * bestMoveDetails is a legal chess.js verbose move generated from before.bestMove.
 * We only call it a Miss when the engine's best move wins at least a minor piece
 * or there was a forced mate, and the played move fails to preserve that chance.
 */
export function detectMissedOpportunity({ row, before, after, bestMoveDetails } = {}) {
  if (!row || row.checkmate || !bestMoveDetails || bestMoveDetails.uci === row.uci) return null;

  const afterAllowsOpponentMate = after?.score?.type === 'mate' && Number(after.score.value) > 0;
  if (afterAllowsOpponentMate) return null;

  const moverStillHasForcedMate = after?.score?.type === 'mate' && Number(after.score.value) < 0;
  const hadForcedMate = before?.score?.type === 'mate'
    && Number(before.score.value) > 0
    && before.turn === row.color;
  if (((bestMoveDetails.san || '').includes('#') || hadForcedMate) && !moverStillHasForcedMate) {
    return { type:'mate', san:bestMoveDetails.san || '', mateIn:hadForcedMate ? Number(before.score.value) : 1 };
  }

  const pieceValues = { p:1, n:3, b:3, r:5, q:9, k:100 };
  const wonPiece = String(bestMoveDetails.captured || '').toLowerCase();
  const playedCapture = String(row.move?.captured || '').toLowerCase();
  const missedValue = pieceValues[wonPiece] || 0;
  const actualValue = pieceValues[playedCapture] || 0;
  if (missedValue >= 3 && missedValue > actualValue) {
    return {
      type:'piece',
      piece:wonPiece,
      square:bestMoveDetails.to || '',
      bestSan:bestMoveDetails.san || ''
    };
  }
  return null;
}

export function classifyMoveQuality({ row, before, after, loss, soundSacrifice = false }) {
  if (row?.checkmate) return { ...LABELS.checkmate, effectiveLoss:0, queenCaptureProtected:false };
  if (row?.book) return { ...LABELS.book, effectiveLoss:0, queenCaptureProtected:false };
  if (!Number.isFinite(loss)) return { ...LABELS.good, effectiveLoss:0, queenCaptureProtected:false, uncertain:true };

  const moverBefore = scoreForColor(before?.whiteScore, row?.color);
  const moverAfter = scoreForColor(after?.whiteScore, row?.color);
  const moverAfterExpected = expectedPointsForColor(after, row?.color);
  const bestMatch = Boolean(before?.bestMove && before.bestMove === row?.uci);
  const rawLoss = before?.score?.type === 'mate' || after?.score?.type === 'mate'
    ? null
    : calculateMoveLoss(before, after, row?.color);
  // After the player's move it is the opponent's turn. A positive mate score means
  // that side (the opponent) can force mate, so neither a queen-capture guard nor
  // a missed-opportunity tag may disguise a forced mating refutation.
  const opponentHasForcedMate = after?.score?.type === 'mate' && Number(after.score.value) > 0;

  if (!opponentHasForcedMate && row?.missedOpportunity) {
    return { ...LABELS.miss, effectiveLoss:loss, queenCaptureProtected:false, rawLoss, missedOpportunity:row.missedOpportunity };
  }

  if (!opponentHasForcedMate && moverBefore >= 2.5 && (moverAfter <= 0.5 || (Number.isFinite(moverAfterExpected) && moverAfterExpected <= 0.5))) {
    return { ...LABELS.missedWin, effectiveLoss:loss, queenCaptureProtected:false, rawLoss };
  }

  // A queen capture is not automatically good: an immediate forced mate or a
  // position that still favours the opponent remains eligible for a blunder.
  // But if best play leaves the capturer with a clear expected-score advantage,
  // don't let a saturated WDL estimate call a real queen win a blunder.
  const queenCaptureProtected = row?.move?.captured === 'q'
    && !opponentHasForcedMate
    && Number.isFinite(moverAfterExpected)
    && moverAfterExpected >= 0.70;
  const effectiveLoss = queenCaptureProtected ? Math.min(loss, 0.095) : loss;
  const expectedGrade = classifyByExpectedLoss(effectiveLoss);
  const rawGrade = queenCaptureProtected || bestMatch
    ? null
    : classifyByRawEvaluationLoss(rawLoss, moverAfter, effectiveLoss);

  if (rawGrade && QUALITY_RANK[rawGrade.key] > QUALITY_RANK[expectedGrade.key]) {
    return { ...rawGrade, effectiveLoss, queenCaptureProtected, rawLoss, gradingBasis:'raw-evaluation' };
  }
  if (bestMatch && soundSacrifice && moverBefore < 2.0 && moverAfter > -0.25) {
    return { ...LABELS.brilliant, effectiveLoss, queenCaptureProtected, rawLoss };
  }
  if (row?.legalMoveCount === 1 && effectiveLoss <= 0.12 && !rawGrade) {
    return { ...LABELS.great, effectiveLoss, queenCaptureProtected, rawLoss };
  }
  if (bestMatch) return { ...LABELS.best, effectiveLoss, queenCaptureProtected, rawLoss };
  if (moverBefore <= 0.25 && moverAfter >= 1.5 && effectiveLoss <= 0.02 && !rawGrade) {
    return { ...LABELS.great, effectiveLoss, queenCaptureProtected, rawLoss };
  }
  const finalGrade = rawGrade && QUALITY_RANK[rawGrade.key] > QUALITY_RANK[expectedGrade.key] ? rawGrade : expectedGrade;
  return { ...finalGrade, effectiveLoss, queenCaptureProtected, rawLoss, gradingBasis:finalGrade === rawGrade ? 'raw-evaluation' : 'expected-score' };
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
  if (!Number.isFinite(value)) return 'The engine could not judge the position clearly.';
  if (value >= 3) return 'You are winning.';
  if (value >= 1.25) return 'You have a clear advantage.';
  if (value >= 0.35) return 'You are a little better.';
  if (value <= -3) return 'The opponent is winning.';
  if (value <= -1.25) return 'The opponent has a clear advantage.';
  if (value <= -0.35) return 'The opponent is a little better.';
  return 'The game is about even.';
}

function describeMoveIntent(row) {
  const move = row?.move;
  if (!move) return 'This move changes the position.';

  const piece = String(move.piece || 'p').toLowerCase();
  const from = move.from || '—';
  const to = move.to || '—';
  const file = to[0] || '';
  const pieceLabel = pieceName(piece);
  const san = String(row.san || '');
  const flags = String(move.flags || '');
  const castle = san.startsWith('O-O-O') ? 'queen’s side' : san.startsWith('O-O') ? 'king’s side' : '';
  let description;

  if (castle) {
    description = `You castle on the ${castle}, tucking your king away and bringing your rook into play.`;
  } else if (flags.includes('e')) {
    description = 'Your pawn captures en passant, taking the pawn that just moved past it.';
  } else if (move.captured) {
    description = `Your ${pieceLabel} takes the opponent’s ${pieceName(move.captured)} on ${to}.`;
  } else if (piece === 'p' && ['d4','e4','d5','e5'].includes(to)) {
    description = `You push your ${from[0]}-pawn into the centre, helping you fight for control of the middle of the board.`;
  } else if (piece === 'p') {
    const flank = 'ab'.includes(file) ? 'the queen’s side' : 'gh'.includes(file) ? 'the king’s side' : 'the middle of the board';
    description = `You push your ${from[0]}-pawn to ${to}, gaining space on ${flank}.`;
  } else if ((piece === 'n' || piece === 'b') && ((row.color === 'w' && from[1] === '1') || (row.color === 'b' && from[1] === '8'))) {
    description = `You bring your ${pieceLabel} into the game, moving it from ${from} to ${to}.`;
  } else if (piece === 'n' && 'cdef'.includes(file) && '3456'.includes(to[1] || '')) {
    description = `You move your knight to ${to}, closer to the centre where it can influence more of the board.`;
  } else if (piece === 'b') {
    description = `You move your bishop to ${to}, giving it a new diagonal to work along.`;
  } else if (piece === 'r') {
    description = `You move your rook to ${to}, giving it a more active line to work along.`;
  } else if (piece === 'q') {
    description = `You move your queen to ${to}, giving it new attacking and defensive options.`;
  } else if (piece === 'k') {
    description = `You move your king from ${from} to ${to}.`;
  } else {
    description = `You move your ${pieceLabel} from ${from} to ${to}.`;
  }

  if (san.includes('#')) description += ' It is checkmate—the game is over.';
  else if (san.includes('+')) description += ' It also puts the opponent’s king in check.';
  if (move.promotion) description += ` Your pawn reaches the other side and becomes a ${pieceName(move.promotion)}.`;
  if (row.wasInCheck && !san.includes('+') && !san.includes('#')) description += ' It also gets your king out of check.';
  return description;
}

function impactPhrase(loss) {
  if (!Number.isFinite(loss)) return '';
  if (loss <= 0.02) return 'It barely changes your chances.';
  if (loss <= 0.05) return 'You give up a little of your advantage.';
  if (loss <= 0.12) return 'You let your opponent improve their position.';
  if (loss <= 0.35) return 'You give your opponent a real chance to take control.';
  return 'You give your opponent a major chance to turn the game around.';
}

export function explainMoveQuality({ row, label, loss, rawPawnsLoss, bestSan, bestLineSan, replySan, after, replyCapturesMovedPiece = false, replyTacticalText = '' }) {
  if (label.key === 'checkmate') return `You checkmate your opponent with ${row.san}. The game is over.`;
  if (label.key === 'book') {
    const openings = Array.isArray(row.bookOpenings) ? row.bookOpenings : [];
    if (!openings.length) return 'This is a recognised opening move. You’re following a line that players have studied and used for many years.';
    if (openings.length === 1) return `This is a well-known move in the ${openings[0]} opening. Players have studied this line for many years.`;
    return `This move appears in several well-known openings: ${openings.slice(0, 3).join(', ')}. These are established lines that players have studied for many years.`;
  }

  const intent = describeMoveIntent(row);
  const alternative = bestSan && bestSan !== row.san ? ` A stronger choice was ${bestSan}.` : '';
  const continuation = bestLineSan && bestSan && bestSan !== row.san ? ` One possible follow-up is ${bestLineSan}.` : '';
  const reply = replySan ? ` The opponent’s best reply is ${replySan}.${replyTacticalText ? ` ${replyTacticalText}` : ''}` : '';
  const impact = impactPhrase(loss);
  const position = positionPhrase(after, row.color);
  const opponentHasForcedMate = after?.score?.type === 'mate' && Number(after.score.value) > 0;

  if (label.key === 'blunder' && Number.isFinite(rawPawnsLoss) && rawPawnsLoss >= 4) {
    const extra = Number.isFinite(loss) && loss <= 0.02
      ? 'The game was already very one-sided, so the win chances barely moved—but this move still makes things much worse.'
      : 'This makes the game much harder for you.';
    return `${intent} This is a blunder—a major mistake. ${extra} ${position}${alternative}${continuation}${reply}`;
  }

  if (row.move?.captured === 'q') {
    if (opponentHasForcedMate) {
      return `${intent} Even though you win the queen, the opponent can still force checkmate. That means the queen won’t save the game.${reply}${alternative}${continuation}`;
    }
    if (replyCapturesMovedPiece) {
      return `${intent} But the opponent can immediately take back the piece that captured the queen with ${replySan}. The exchange does not work out in your favour.${position}${alternative}${continuation}`;
    }
    if (label.queenCaptureProtected) {
      return `${intent} And the good news: the engine still sees you as clearly ahead after the exchange. This queen win works out well for you.${position}${alternative}${continuation}${reply}`;
    }
    return `${intent} Winning the queen does not automatically win the game; the opponent still has counterplay. ${position}${alternative}${continuation}${reply}`;
  }

  if (label.key === 'brilliant') {
    return `${intent} A clever sacrifice: you leave a valuable piece available to take, but the follow-up gives you enough in return. Your opponent is better off refusing it.${reply}${continuation}`;
  }
  if (label.key === 'best') {
    return `${intent} Best move. This is the engine’s top choice and keeps your position as strong as possible. ${position}${reply}`;
  }
  if (label.key === 'great') {
    const reason = row.legalMoveCount === 1
      ? 'You found the only move that keeps the position together. Well spotted.'
      : 'A clever find that turns a difficult position in your favour.';
    return `${intent} ${reason} ${position}${reply}${continuation}`;
  }
  if (label.key === 'excellent') {
    return `${intent} A very strong move. You keep almost all of your advantage. ${impact}${alternative}${reply}`;
  }
  if (label.key === 'good') {
    return `${intent} A solid choice that keeps you in a good position. ${alternative || 'There was no major problem with this move.'}${reply}`;
  }
  if (label.key === 'inaccuracy') {
    return `${intent} Not your best option: this gives your opponent a little room to improve. ${alternative || 'A more careful move would have kept your advantage.'}${position}${reply}`;
  }
  if (label.key === 'mistake') {
    return `${intent} This is a mistake because it gives your opponent a real chance to take control. ${alternative || 'A safer move was available.'}${position}${reply}`;
  }
  if (label.key === 'miss') {
    const opportunity = row.missedOpportunity || {};
    if (opportunity.type === 'mate') return `${intent} You had a forced checkmate available with ${opportunity.san || bestSan || 'the engine’s suggested move'}, but this move lets the chance slip away.${alternative}${continuation}${reply}`;
    const piece = pieceName(opportunity.piece || 'piece');
    return `${intent} Missed chance: you could have won your opponent’s ${piece} on ${opportunity.square || 'the board'}, but the chance is gone. The move to play was ${opportunity.bestSan || bestSan || 'the capture'}.${continuation}${reply}`;
  }
  if (label.key === 'missed-win') {
    return `${intent} You had a chance to turn this into a winning position, but this move lets your opponent back into the game.${alternative}${continuation}${reply}`;
  }
  if (label.key === 'blunder') {
    return `${intent} This is a serious mistake and gives your opponent a big opportunity. ${alternative || 'You needed to find a more careful move.'}${position}${reply}${continuation}`;
  }
  return `${intent} ${impact || 'The engine has a more accurate way to play.'} ${position}${alternative}${reply}`;
}
