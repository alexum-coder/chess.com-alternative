require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const crypto = require('crypto');
const os = require('node:os');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createGunzip } = require('node:zlib');
const { updateGlicko2 } = require('./glicko2');
const { StockfishAnalyzer } = require('./stockfish-analyzer');
const { reviewGameMoves } = require('./engine-review');
const { serializeTournamentGame, restoreChess, hydrateTournamentState } = require('./tournament-recovery');
const { RATING_PLACEMENT_GAMES, publicPlayer } = require('./rating-status');
const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;
console.log(db ? 'Supabase connected: accounts and saved ratings are ON' : 'No Supabase config: guest-only mode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const path = require('path');
const fs = require('fs');
// Serve index.html from ./public, or from the same folder if it was downloaded without the folder.
const pub = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
app.get('/config.js', (req, res) => {
  res.type('js').send('window.ZZ_CONFIG=' + JSON.stringify({
    url: db ? process.env.SUPABASE_URL : null,
    anonKey: db ? process.env.SUPABASE_ANON_KEY : null
  }) + ';');
});
app.get('/api/leaderboard', async (req, res) => {
  if (!db) return res.json([]);
  const { data } = await db.from('profiles').select('username,rating,games_played')
    .gte('games_played', RATING_PLACEMENT_GAMES).order('rating', { ascending: false }).limit(10);
  res.json(data || []);
});

// Loads (or creates) the profile for a Supabase session token and caches it.
async function accountFor(token) {
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new Error(error && error.status >= 500 ? 'auth: ' + error.message : 'invalid session');
  const u = data.user;
  if (!users.get(u.id)?.authed) {
    let { data: prof, error: selErr } = await db.from('profiles').select('*').eq('id', u.id).maybeSingle();
    if (selErr) throw new Error('profile lookup: ' + selErr.message);
    let lastErr = null;
    if (!prof) {
      const base = String(u.user_metadata?.username || (u.email || 'player').split('@')[0])
        .replace(/[^\w]/g, '').slice(0, 16) || 'player';
      for (let i = 0; i < 5 && !prof; i++) {
        const username = i === 0 ? base : base + Math.floor(1000 + Math.random() * 9000);
        const r = await db.from('profiles').insert({ id: u.id, username }).select().single();
        if (!r.error) prof = r.data; else lastErr = r.error;
      }
    }
    if (!prof) throw new Error('profile create: ' + (lastErr ? lastErr.message : 'failed'));
    const { data: actions } = await db.from('moderation_actions').select('action,expires_at')
      .eq('target_id', u.id).eq('active', true);
    const activeActions = (actions || []).filter((a) => !a.expires_at || new Date(a.expires_at).getTime() > Date.now());
    users.set(u.id, {
      name: prof.username,
      rating: prof.rating,
      rd: prof.rating_deviation ?? 350,
      volatility: prof.volatility ?? 0.06,
      games: prof.games_played || 0,
      since: prof.created_at,
      banned: activeActions.some((a) => a.action === 'ban'),
      muted: activeActions.some((a) => a.action === 'mute'),
      muteUntil: activeActions.find((a) => a.action === 'mute')?.expires_at
        ? new Date(activeActions.find((a) => a.action === 'mute').expires_at).getTime() : null,
      authed: true
    });
  }
  return { id: u.id, ...users.get(u.id) };
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');
async function requireAccount(req, res) {
  if (!db) {
    res.status(503).json({ error: 'This feature requires Supabase accounts. Configure the server first.' });
    return null;
  }
  try { return await accountFor(bearer(req)); }
  catch (e) {
    console.error('Account authentication/profile lookup failed:', e.message || e);
    const invalid = e.message === 'invalid session';
    res.status(invalid ? 401 : 500).json({ error: invalid ? 'Please log in again.' : 'Could not load your account.' });
    return null;
  }
}
const adminIds = new Set(String(process.env.ADMIN_USER_IDS || '').split(',').map((x) => x.trim()).filter(Boolean));
const isAdmin = (pid) => adminIds.has(pid);
const apiHits = new Map();
function allowRate(key, max, windowMs) {
  const now = Date.now();
  const entry = apiHits.get(key) || { count: 0, start: now };
  if (now - entry.start >= windowMs) { entry.count = 0; entry.start = now; }
  entry.count++;
  apiHits.set(key, entry);
  return entry.count <= max;
}


app.use(express.json());
app.get('/api/me', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Accounts are not set up.' });
  try {
    const acct = await accountFor(bearer(req));
    res.json({
      id: acct.id, name: acct.name, ...publicPlayer(acct), volatility: acct.volatility,
      since: acct.since, authed: true, isAdmin: isAdmin(acct.id)
    });
  }
  catch (e) {
    console.error('/api/me failed:', e.message);
    res.status(e.message === 'invalid session' ? 401 : 500).json({ error: e.message === 'invalid session' ? 'Please log in again.' : 'Could not load your account.' });
  }
});
app.post('/api/username', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Accounts are not set up.' });
  let acct;
  try { acct = await accountFor(bearer(req)); } catch { return res.status(401).json({ error: 'Please log in again.' }); }
  const name = String(req.body?.username || '').trim();
  if (!/^\w{3,16}$/.test(name)) return res.status(400).json({ error: 'Username must be 3 to 16 letters, numbers or underscores.' });
  const { data: taken } = await db.from('profiles').select('id').ilike('username', name.replace(/_/g, '\\_')).neq('id', acct.id).limit(1);
  if (taken && taken.length) return res.status(409).json({ error: 'That username is taken.' });
  const { error } = await db.from('profiles').update({ username: name }).eq('id', acct.id);
  if (error) return res.status(500).json({ error: 'Could not save. Try again.' });
  users.get(acct.id).name = name;
  res.json({ username: name });
});

/* ---------- friends ---------- */
app.get('/api/friends', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  const { data: links, error } = await db.from('friendships').select('*')
    .or(`requester_id.eq.${acct.id},addressee_id.eq.${acct.id}`).order('created_at', { ascending: false });
  if (error) { console.error('/api/friends query failed:', error); return res.status(500).json({ error: 'Could not load friends.' }); }
  const ids = [...new Set((links || []).map((x) => x.requester_id === acct.id ? x.addressee_id : x.requester_id))];
  const { data: profiles, error: profileError } = ids.length
    ? await db.from('profiles').select('id,username,rating,games_played').in('id', ids)
    : { data: [], error: null };
  if (profileError) console.error('/api/friends profile lookup failed:', profileError);
  const byId = new Map((profiles || []).map((p) => [p.id, p]));
  const friends = [], incoming = [], outgoing = [];
  for (const link of links || []) {
    const otherId = link.requester_id === acct.id ? link.addressee_id : link.requester_id;
    const other = byId.get(otherId);
    if (!other) continue;
    const games = other.games_played || 0;
    const item = { id: other.id, username: other.username, rating: games >= RATING_PLACEMENT_GAMES ? other.rating : null,
      games, ratingReady: games >= RATING_PLACEMENT_GAMES, requestId: link.id };
    if (link.status === 'accepted') friends.push(item);
    else if (link.status === 'pending' && link.addressee_id === acct.id) incoming.push(item);
    else if (link.status === 'pending' && link.requester_id === acct.id) outgoing.push(item);
  }
  res.json({ friends, incoming, outgoing });
});

app.post('/api/friends/request', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!allowRate(`friend:${acct.id}`, 10, 60_000)) return res.status(429).json({ error: 'Too many friend requests. Try again in a minute.' });
  const username = String(req.body?.username || '').trim();
  if (!/^\w{3,16}$/.test(username)) return res.status(400).json({ error: 'Enter a valid username.' });
  const { data: target } = await db.from('profiles').select('id,username').ilike('username', username).maybeSingle();
  if (!target) return res.status(404).json({ error: 'Player not found.' });
  if (target.id === acct.id) return res.status(400).json({ error: 'You cannot add yourself.' });
  const { data: existing } = await db.from('friendships').select('*')
    .or(`and(requester_id.eq.${acct.id},addressee_id.eq.${target.id}),and(requester_id.eq.${target.id},addressee_id.eq.${acct.id})`).limit(1);
  if (existing?.length) {
    const link = existing[0];
    if (link.status === 'accepted') return res.status(409).json({ error: 'You are already friends.' });
    if (link.status === 'pending' && link.requester_id === target.id && link.addressee_id === acct.id) {
      const { error } = await db.from('friendships').update({ status: 'accepted', updated_at: new Date().toISOString() }).eq('id', link.id);
      if (error) return res.status(500).json({ error: 'Could not accept the existing request.' });
      return res.json({ message: `You and ${target.username} are now friends.` });
    }
    if (link.status === 'pending') return res.status(409).json({ error: 'A friend request is already pending.' });
    const { error } = await db.from('friendships').update({
      requester_id: acct.id, addressee_id: target.id, status: 'pending', updated_at: new Date().toISOString()
    }).eq('id', link.id);
    if (error) return res.status(500).json({ error: 'Could not resend friend request.' });
    return res.json({ message: `Friend request sent to ${target.username}.` });
  }
  const { error } = await db.from('friendships').insert({ requester_id: acct.id, addressee_id: target.id, status: 'pending' });
  if (error) return res.status(500).json({ error: 'Could not send friend request.' });
  res.json({ message: `Friend request sent to ${target.username}.` });
});

app.post('/api/friends/respond', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  const requestId = Number(req.body?.requestId), accept = req.body?.accept === true;
  if (!Number.isSafeInteger(requestId) || requestId <= 0) return res.status(400).json({ error: 'Invalid request.' });
  const { data, error } = await db.from('friendships').update({
    status: accept ? 'accepted' : 'declined', updated_at: new Date().toISOString()
  }).eq('id', requestId).eq('addressee_id', acct.id).eq('status', 'pending').select('id').maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'That friend request is no longer pending.' });
  res.json({ ok: true });
});

app.post('/api/friends/remove', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  const otherId = String(req.body?.userId || '');
  if (!/^[0-9a-f-]{36}$/i.test(otherId) || otherId === acct.id) return res.status(400).json({ error: 'Invalid friend.' });
  const { error } = await db.from('friendships').delete()
    .or(`and(requester_id.eq.${acct.id},addressee_id.eq.${otherId}),and(requester_id.eq.${otherId},addressee_id.eq.${acct.id})`);
  if (error) return res.status(500).json({ error: 'Could not remove friend.' });
  res.json({ ok: true });
});

/* ---------- moderator tools ---------- */
app.get('/api/mod/reports', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!isAdmin(acct.id)) return res.status(403).json({ error: 'Moderator access required.' });
  const { data: reports, error } = await db.from('moderation_reports').select('*')
    .order('created_at', { ascending: false }).limit(100);
  if (error) { console.error('/api/mod/reports query failed:', error); return res.status(500).json({ error: 'Could not load reports.' }); }
  const ids = [...new Set((reports || []).flatMap((r) => [r.reporter_id, r.reported_id]).filter(Boolean))];
  const { data: profiles } = ids.length ? await db.from('profiles').select('id,username').in('id', ids) : { data: [] };
  const names = new Map((profiles || []).map((p) => [p.id, p.username]));
  res.json((reports || []).map((r) => ({
    ...r, reporter_name: names.get(r.reporter_id) || 'Guest', reported_name: names.get(r.reported_id) || 'Guest'
  })));
});

app.post('/api/mod/action', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!isAdmin(acct.id)) return res.status(403).json({ error: 'Moderator access required.' });
  const targetId = String(req.body?.targetId || ''), action = String(req.body?.action || ''), reason = String(req.body?.reason || '').trim().slice(0, 500);
  const reportId = Number(req.body?.reportId) || null;
  if (!/^[0-9a-f-]{36}$/i.test(targetId) || !['warn', 'mute', 'ban', 'unmute', 'unban'].includes(action))
    return res.status(400).json({ error: 'Invalid moderation action.' });
  if (targetId === acct.id) return res.status(400).json({ error: 'You cannot moderate your own account.' });
  const active = !['unmute', 'unban'].includes(action);
  const type = action === 'unmute' ? 'mute' : action === 'unban' ? 'ban' : action;
  let expiresAt = null;
  if (active) {
    const durationMinutes = Math.min(Math.max(Number(req.body?.durationMinutes) || 0, 0), 525600);
    expiresAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60_000).toISOString() : null;
    const { error } = await db.from('moderation_actions').insert({
      moderator_id: acct.id, target_id: targetId, action: type, reason, active: true, expires_at: expiresAt
    });
    if (error) return res.status(500).json({ error: 'Could not save moderation action.' });
  } else {
    const { error } = await db.from('moderation_actions').update({ active: false })
      .eq('target_id', targetId).eq('action', type).eq('active', true);
    if (error) return res.status(500).json({ error: 'Could not clear moderation action.' });
  }
  if (reportId) await db.from('moderation_reports').update({ status: 'reviewed', reviewed_by: acct.id }).eq('id', reportId);
  const target = users.get(targetId);
  if (target) {
    if (type === 'ban') target.banned = active;
    if (type === 'mute') {
      target.muted = active;
      target.muteUntil = expiresAt ? new Date(expiresAt).getTime() : null;
    }
    if (type === 'ban' && active && target.sid) io.sockets.sockets.get(target.sid)?.disconnect(true);
    else if (target.sid) io.to(target.sid).emit('moderationNotice', { action: active ? type : `un${type}`, reason });
  }
  res.json({ ok: true });
});

app.get('/api/mod/integrity', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!isAdmin(acct.id)) return res.status(403).json({ error: 'Moderator access required.' });
  const { data, error } = await db.from('integrity_flags').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) { console.error('/api/mod/integrity query failed:', error); return res.status(500).json({ error: 'Could not load integrity flags.' }); }
  const ids = [...new Set((data || []).map((x) => x.player_id).filter(Boolean))];
  const { data: profiles } = ids.length ? await db.from('profiles').select('id,username').in('id', ids) : { data: [] };
  const names = new Map((profiles || []).map((p) => [p.id, p.username]));
  res.json((data || []).map((x) => ({ ...x, player_name: names.get(x.player_id) || 'Guest' })));
});

app.post('/api/mod/integrity/review', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!isAdmin(acct.id)) return res.status(403).json({ error: 'Moderator access required.' });
  const id = Number(req.body?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid integrity flag.' });
  const { error } = await db.from('integrity_flags').update({ reviewed: true }).eq('id', id);
  if (error) return res.status(500).json({ error: 'Could not mark the flag reviewed.' });
  res.json({ ok: true });
});

app.post('/api/mod/report-status', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!isAdmin(acct.id)) return res.status(403).json({ error: 'Moderator access required.' });
  const id = Number(req.body?.id), status = String(req.body?.status || '');
  if (!Number.isSafeInteger(id) || id <= 0 || !['reviewed', 'dismissed'].includes(status))
    return res.status(400).json({ error: 'Invalid report status.' });
  const { error } = await db.from('moderation_reports').update({ status, reviewed_by: acct.id }).eq('id', id);
  if (error) return res.status(500).json({ error: 'Could not update report.' });
  res.json({ ok: true });
});


// Browser Stockfish is stored in a public Supabase Storage bucket. The page
// creates a same-origin Worker; this bootstrap imports the cross-origin JS
// loader and points Emscripten at the matching public WASM object.
const stockfishBucket = String(process.env.STOCKFISH_STORAGE_BUCKET || 'stockfish').trim();
const storageObjectUrl = (file) => {
  if (!process.env.SUPABASE_URL || !stockfishBucket) return null;
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  return `${base}/storage/v1/object/public/${encodeURIComponent(stockfishBucket)}/${encodeURIComponent(file)}`;
};
const browserStockfishJsUrl = storageObjectUrl('stockfish-19-lite-single.js');
const browserStockfishWasmUrl = storageObjectUrl('stockfish-19-lite-single.wasm');
const nativeStockfishBucket = String(process.env.STOCKFISH_NATIVE_BUCKET || 'stockfish-native').trim();
// New split-object configuration; retain the single-object variable for backwards compatibility.
const nativeStockfishObjects = String(process.env.STOCKFISH_NATIVE_OBJECTS || process.env.STOCKFISH_NATIVE_OBJECT || '')
  .split(',').map((name) => name.trim()).filter(Boolean);
const nativeStockfishStatus = { configured: nativeStockfishObjects.length > 0, ready: false, error: null };
app.get('/stockfish-worker.js', (req, res) => {
  if (!browserStockfishJsUrl || !browserStockfishWasmUrl) {
    return res.status(503).type('text').send('Browser Stockfish Storage is not configured. Set SUPABASE_URL and STOCKFISH_STORAGE_BUCKET.');
  }
  res.set('Cache-Control', 'no-store');
  res.type('application/javascript').send(`
    // This bootstrap is hosted on the Zugzwang origin so Worker() is same-origin.
    // Stockfish's JS is loaded from the public Supabase bucket; locateFile keeps
    // its WASM download pointed at the matching Storage object.
    var Module = {
      locateFile: function (file, prefix) {
        if (/\.wasm(?:$|[?#])/.test(file)) return ${JSON.stringify(browserStockfishWasmUrl)};
        return (prefix || '') + file;
      }
    };
    try {
      importScripts(${JSON.stringify(browserStockfishJsUrl)});
    } catch (error) {
      postMessage('stockfish-bootstrap-error: ' + (error && error.message ? error.message : String(error)));
    }
  `);
});
app.get('/stockfish-worker.wasm', async (req, res) => {
  if (!browserStockfishWasmUrl) {
    return res.status(503).send('Stockfish WASM URL is not configured');
  }

  try {
    const upstream = await fetch(browserStockfishWasmUrl);

    if (!upstream.ok) {
      return res.status(upstream.status).send('Could not load Stockfish WASM');
    }

    const wasm = Buffer.from(await upstream.arrayBuffer());

    res.set('Content-Type', 'application/wasm');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(wasm);
  } catch (error) {
    console.error('Stockfish WASM proxy error:', error);
    res.status(502).send('Stockfish WASM proxy failed');
  }
});

app.get('/api/health', async (req, res) => {
  const urlsConfigured = !!(browserStockfishJsUrl && browserStockfishWasmUrl);
  const checks = await Promise.all([browserStockfishJsUrl, browserStockfishWasmUrl].map(async (url) => {
    if (!url) return false;
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      return response.ok;
    } catch { return false; }
  }));
  const engineJs = checks[0], engineWasm = checks[1];
  const browserStockfishOk = urlsConfigured && engineJs && engineWasm;
  res.status(browserStockfishOk ? 200 : 503).json({
    ok: browserStockfishOk,
    supabaseConfigured: !!db,
    browserStockfish: {
      source: 'supabase-storage', bucket: stockfishBucket,
      configured: urlsConfigured, js: engineJs, wasm: engineWasm
    },
    nativeStockfish: {
      source: nativeStockfishStatus.configured ? 'private-supabase-storage' : 'STOCKFISH_PATH',
      configured: nativeStockfishStatus.configured,
      parts: nativeStockfishObjects.length,
      ready: nativeStockfishStatus.ready,
      error: nativeStockfishStatus.error
    }
  });
});

// Public CC0 puzzle pool imported from the Lichess puzzle CSV (see puzzle-import.js).
app.get('/api/puzzles/random', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Puzzle database is not configured.' });
  const min = Math.max(0, Math.min(3000, Number(req.query.min) || 0));
  const max = Math.max(min, Math.min(3500, Number(req.query.max) || 3500));
  const filter = (q) => q.gte('rating', min).lte('rating', max);
  const { count, error: countError } = await filter(db.from('puzzles').select('puzzle_id', { count: 'exact', head: true }));
  if (countError) { console.error('/api/puzzles/random count query failed:', countError); return res.status(500).json({ error: 'Could not load puzzles.' }); }
  if (!count) return res.status(404).json({ error: 'No puzzles in this rating range. Import the Lichess CC0 puzzle database first.' });
  const offset = Math.floor(Math.random() * count);
  const { data, error } = await filter(db.from('puzzles').select('puzzle_id,fen,moves,rating,themes')).range(offset, offset);
  if (error || !data?.length) { if (error) console.error('/api/puzzles/random fetch failed:', error); return res.status(500).json({ error: 'Could not load a puzzle.' }); }
  res.json(data[0]);
});

app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.use(express.static(pub, { index: false }));
console.log('Serving client from', pub);

// In-memory stores. Swap for a database (e.g. Supabase free tier) to persist.
const users = new Map();   // playerId -> { name, rating, rd, volatility, ... }
const queues = new Map();  // "base+inc" -> waiting seeker { sid, pid }
const games = new Map();   // gameId -> game
const connectedSockets = new Map();
const tournaments = new Map();
const stockfish = new StockfishAnalyzer();
let stockfishUnavailableLogged = false;
const tournamentRoom = (id) => `tournament:${id}`;
const notifyTournament = (id) => io.to(tournamentRoom(id)).emit('tournamentUpdate', { tournamentId: id });

async function saveTournamentCheckpoint(game) {
  if (!db || !game.tournamentMatch) return;
  const state = serializeTournamentGame(game);
  const { error } = await db.from('tournament_matches').update({ game_state: state }).eq('id', game.tournamentMatch.matchId);
  if (error) throw new Error('Could not save tournament checkpoint: ' + error.message);
}

function queueTournamentCheckpoint(game) {
  if (!db || !game.tournamentMatch) return Promise.resolve();
  const next = (game.checkpointChain || Promise.resolve()).then(() => saveTournamentCheckpoint(game));
  game.checkpointChain = next.catch((error) => console.error(error.message));
  return game.checkpointChain;
}

const tournamentCheckpointTimer = setInterval(() => {
  for (const game of games.values()) if (!game.over && game.tournamentMatch) queueTournamentCheckpoint(game);
}, 5000);
tournamentCheckpointTimer.unref?.();

async function reviewFinishedGame(game, moves) {
  if (!db || !moves.length) return;
  try {
    const review = await reviewGameMoves(moves, stockfish, {
      minPly: Number(process.env.STOCKFISH_MIN_PLY) || 10,
      maxPlies: Number(process.env.STOCKFISH_MAX_PLIES) || 60,
      minSamples: Number(process.env.STOCKFISH_MIN_SAMPLES) || 12,
      concordanceThreshold: Number(process.env.STOCKFISH_CONCORDANCE) || 0.90,
      avgLossThreshold: Number(process.env.STOCKFISH_AVG_CPL) || 18
    });
    const inserts = [];
    for (const color of ['w', 'b']) {
      const player = color === 'w' ? game.white : game.black;
      const metrics = review.players[color];
      if (!player.pid || player.pid.startsWith('g:') || !metrics.flagForReview) continue;
      inserts.push({
        game_id: game.id, player_id: player.pid, signal: 'stockfish_concordance',
        details: {
          engine: review.engine, depth: review.depth, analyzed_moves: metrics.analyzedMoves,
          best_move_rate: Math.round(metrics.bestMoveRate * 1000) / 1000,
          average_centipawn_loss: metrics.averageCentipawnLoss,
          samples: metrics.samples.slice(0, 40),
          note: 'Automated engine agreement is a review signal, not proof of cheating.'
        }
      });
    }
    if (inserts.length) {
      const { error } = await db.from('integrity_flags').insert(inserts);
      if (error) throw new Error(error.message);
    }
  } catch (error) {
    if (!stockfishUnavailableLogged) {
      console.warn('Stockfish post-game review unavailable:', error.message,
        '\nSet STOCKFISH_PATH to a local Stockfish executable to enable engine review.');
      stockfishUnavailableLogged = true;
    }
  }
}
function joinPlayerTournaments(socket, playerId) {
  if (!db) return;
  db.from('tournament_players').select('tournament_id').eq('player_id', playerId)
    .then(({ data, error }) => {
      if (error) return console.error('tournament room lookup failed:', error.message);
      for (const row of data || []) socket.join(tournamentRoom(row.tournament_id));
    });
}

async function persist(g, w, b, result, reason, pgn) {
  if (!db) return true;
  const { data, error } = await db.rpc('finalize_chess_game', {
    p_game_id: g.id,
    p_white_id: w.authed ? g.white.pid : null,
    p_black_id: b.authed ? g.black.pid : null,
    p_white_name: w.name,
    p_black_name: b.name,
    p_result: result,
    p_reason: reason,
    p_pgn: pgn,
    p_base: g.base,
    p_inc: g.inc,
    p_white_rating: Math.round(w.rating),
    p_white_deviation: w.rd,
    p_white_volatility: w.volatility,
    p_white_games: w.games || 0,
    p_black_rating: Math.round(b.rating),
    p_black_deviation: b.rd,
    p_black_volatility: b.volatility,
    p_black_games: b.games || 0
  });
  if (error) throw new Error('Could not atomically save game result: ' + error.message);
  if (data === false) {
    // The game row already exists: this is a recovery retry after the result
    // committed but before the tournament bracket was advanced. Reload the
    // profiles written by the first commit rather than applying Glicko twice.
    const ids = [g.white, g.black].filter((player) => player.pid && !player.pid.startsWith('g:')).map((player) => player.pid);
    if (ids.length) {
      const { data: profiles, error: profileError } = await db.from('profiles')
        .select('id,username,rating,rating_deviation,volatility,games_played').in('id', ids);
      if (profileError) throw new Error('Could not reload committed ratings: ' + profileError.message);
      for (const profile of profiles || []) {
        const user = users.get(profile.id);
        if (user) Object.assign(user, {
          name: profile.username, rating: profile.rating,
          rd: profile.rating_deviation ?? 350, volatility: profile.volatility ?? 0.06,
          games: profile.games_played || 0
        });
      }
    }
    return 'duplicate';
  }
  return true;
}

async function endGame(g, result, reason) {
  if (g.over) return true;
  g.over = true;
  clearTimeout(g.timer);

  // Persist a terminal intent with the final board before finalizing the result.
  // This lets bootstrap finish a resignation/timeout as well as a checkmate.
  if (db && g.tournamentMatch) {
    g.pendingResult = { result, reason };
    try {
      await g.checkpointChain;
      await saveTournamentCheckpoint(g);
    } catch (error) {
      console.error('Could not save terminal tournament checkpoint; the atomic game result will be the recovery source:', error.message);
    }
  }

  const w = users.get(g.white.pid), b = users.get(g.black.pid);
  if (!w || !b) return false;
  const oldW = { rating: w.rating, rd: w.rd ?? 350, volatility: w.volatility ?? 0.06, games: w.games || 0 };
  const oldB = { rating: b.rating, rd: b.rd ?? 350, volatility: b.volatility ?? 0.06, games: b.games || 0 };
  const sw = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  Object.assign(w, updateGlicko2(oldW, [{ ...oldB, score: sw }]));
  Object.assign(b, updateGlicko2(oldB, [{ ...oldW, score: 1 - sw }]));
  if (w.authed) w.games = oldW.games + 1;
  if (b.authed) b.games = oldB.games + 1;

  const pgn = g.chess.pgn();
  let committed = true, newlyCommitted = true;
  try {
    const saveResult = await persist(g, w, b, result, reason, pgn);
    newlyCommitted = saveResult !== 'duplicate';
  } catch (error) {
    committed = false;
    newlyCommitted = false;
    console.error('game result persistence failed:', error.message);
    if (db) {
      const ids = [g.white, g.black].filter((player) => player.pid && !player.pid.startsWith('g:')).map((player) => player.pid);
      if (ids.length) {
        const { data: profiles } = await db.from('profiles').select('id,username,rating,rating_deviation,volatility,games_played').in('id', ids);
        for (const profile of profiles || []) {
          const user = users.get(profile.id);
          if (user) Object.assign(user, { name: profile.username, rating: profile.rating,
            rd: profile.rating_deviation ?? 350, volatility: profile.volatility ?? 0.06, games: profile.games_played || 0 });
        }
      }
    }
    if (g.tournamentMatch) {
      const tournamentId = g.tournamentMatch.tournamentId;
      const state = tournaments.get(tournamentId);
      if (state) state.status = 'paused';
      await db.from('tournaments').update({ status: 'paused' }).eq('id', tournamentId);
      // Keep the terminal game in memory and its pendingResult in the checkpoint;
      // a server restart can retry the idempotent commit safely.
    }
  }

  const wPublic = publicPlayer(w), bPublic = publicPlayer(b);
  const dw = committed && newlyCommitted && wPublic.ratingReady && oldW.games >= RATING_PLACEMENT_GAMES ? Math.round(w.rating - oldW.rating) : null;
  const dbRating = committed && newlyCommitted && bPublic.ratingReady && oldB.games >= RATING_PLACEMENT_GAMES ? Math.round(b.rating - oldB.rating) : null;
  const engineMoves = g.chess.history({ verbose: true }).map((move) => ({
    from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {})
  }));
  if (committed && newlyCommitted) reviewFinishedGame(g, engineMoves);
  io.to(g.id).emit('over', {
    result, reason, saved: committed, tournamentPaused: !committed && !!g.tournamentMatch,
    ratings: {
      w: wPublic.rating, b: bPublic.rating, dw, db: dbRating,
      wGames: w.games || 0, bGames: b.games || 0,
      wReady: wPublic.ratingReady, bReady: bPublic.ratingReady
    }
  });

  if (!committed && g.tournamentMatch) return false;
  try { await advanceTournament(g, result); }
  catch (error) { console.error('tournament progression failed:', error.message); }
  games.delete(g.id);
  return committed;
}

function scheduleTimeout(g) {
  clearTimeout(g.timer);
  if (g.recoveryPaused || !g.started) return;
  const side = g.chess.turn();
  g.timer = setTimeout(() => {
    endGame(g, side === 'w' ? '0-1' : '1-0', 'timeout');
  }, Math.max(0, g.clock[side]) + 50);
}

const info = (p) => {
  const user = users.get(p.pid) || { name: 'Player', authed: true, games: 0, rating: 1200, rd: 350 };
  return { name: user.name, ...publicPlayer(user), authed: !!user.authed };
};

// Everything a client needs to draw a game from scratch (used for new games and reconnects).
function snapshot(g, color) {
  const hist = g.chess.history({ verbose: true });
  const last = hist[hist.length - 1];
  return {
    gameId: g.id, color, fen: g.chess.fen(), clock: g.clock, elapsed: g.started && !g.recoveryPaused ? Date.now() - g.turnStart : 0,
    turn: g.chess.turn(), started: g.started, recovering: !!g.recoveryPaused, inc: g.inc, base: g.base,
    moves: hist.map((m) => m.san), last: last ? [last.from, last.to] : null,
    white: info(g.white), black: info(g.black),
    draw: g.draw ? g.draw.by : null,
    drawLockedUntil: g.drawLock[color],
    chat: (g.chat || []).slice(-50)
  };
}

/* ---------- draw offers ---------- */
const DRAW_MIN_PLY = 2;        // no offers before each side has moved once
const DRAW_COOLDOWN_PLY = 4;   // after offering, wait 2 of your own moves (4 plies) before offering again
const DRAW_MAX_OFFERS = 3;     // per player, per game
const sideOf = (g, sid) => (g.white.sid === sid ? 'w' : g.black.sid === sid ? 'b' : null);
const ply = (g) => g.chess.history().length;
function clearDraw(g, reason) {
  if (!g.draw) return;
  const by = g.draw.by;
  g.draw = null;
  io.to(g.id).emit('drawCleared', { by, reason });
}
const activeGameFor = (pid) => [...games.values()].find((g) => !g.over && (g.white.pid === pid || g.black.pid === pid));

function maybeResumeRecoveredGame(g) {
  if (!g.recoveryPaused) return;
  const whiteOnline = g.white.sid && io.sockets.sockets.has(g.white.sid);
  const blackOnline = g.black.sid && io.sockets.sockets.has(g.black.sid);
  if (!whiteOnline || !blackOnline) return;
  g.recoveryPaused = false;
  g.started = true;
  g.turnStart = Date.now();
  scheduleTimeout(g);
  io.to(g.id).emit('gameResumed', { clock: g.clock, turn: g.chess.turn() });
  queueTournamentCheckpoint(g);
}

function resume(socket, g, pid) {
  const isWhite = g.white.pid === pid;
  (isWhite ? g.white : g.black).sid = socket.id;
  connectedSockets.set(pid, socket.id);
  const user = users.get(pid);
  if (user) user.sid = socket.id;
  socket.join(g.id);
  socket.emit('start', snapshot(g, isWhite ? 'w' : 'b'));
  io.to(g.id).emit('opp', { online: true });
  maybeResumeRecoveredGame(g);
}

function startGame(a, b, base, inc, tournamentMatch = null, options = {}) {
  for (const player of [a, b]) {
    if (!player?.sid || !io.sockets.sockets.has(player.sid)) {
      throw new Error('Both players must be connected before a game can start.');
    }
  }
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  const g = {
    id: crypto.randomBytes(5).toString('hex'),
    chess: new Chess(),
    white, black, inc, base,
    clock: { w: base * 1000, b: base * 1000 },
    turnStart: Date.now(),
    started: !options.deferStart, over: false, recoveryPaused: false, checkpointChain: Promise.resolve(),
    draw: null,                       // { by: 'w' | 'b' } while an offer is pending
    drawLock: { w: DRAW_MIN_PLY, b: DRAW_MIN_PLY }, // earliest ply at which each side may offer
    drawCount: { w: 0, b: 0 },
    chat: [],
    timing: { w: { total: 0, veryFast: 0 }, b: { total: 0, veryFast: 0 } },
    tournamentMatch
  };
  games.set(g.id, g);
  for (const p of [white, black]) io.sockets.sockets.get(p.sid)?.join(g.id);
  if (!options.deferStart) announceStartedGame(g);
  return g.id;
}

function announceStartedGame(g) {
  g.started = true;
  g.turnStart = Date.now();
  for (const [player, color] of [[g.white, 'w'], [g.black, 'b']]) {
    if (player.sid) io.to(player.sid).emit('start', snapshot(g, color));
  }
  scheduleTimeout(g);
}

/* ---------- single-elimination tournaments ---------- */
const tournamentPublic = (t, playerCount) => ({
  id: t.id, name: t.name, status: t.status, base: t.base, inc: t.inc,
  max_players: t.max_players, player_count: playerCount, created_at: t.created_at,
  creator_id: t.creator_id, winner_id: t.winner_id || null
});

app.get('/api/tournaments', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  const { data: rows, error } = await db.from('tournaments').select('*')
    .order('created_at', { ascending: false }).limit(30);
  if (error) return res.status(500).json({ error: 'Could not load tournaments.' });
  const ids = (rows || []).map((t) => t.id);
  const [{ data: entrants }, { data: matchRows, error: matchError }] = await Promise.all([
    ids.length ? db.from('tournament_players').select('tournament_id,player_id').in('tournament_id', ids) : Promise.resolve({ data: [] }),
    ids.length ? db.from('tournament_matches').select('*').in('tournament_id', ids).order('round', { ascending: true }) : Promise.resolve({ data: [], error: null })
  ]);
  if (matchError) return res.status(500).json({ error: 'Could not load tournament brackets.' });
  const counts = new Map();
  for (const row of entrants || []) counts.set(row.tournament_id, (counts.get(row.tournament_id) || 0) + 1);
  const playerIds = [...new Set((matchRows || []).flatMap((m) => [m.player_a, m.player_b, m.winner_id]).filter(Boolean))];
  const { data: playerProfiles } = playerIds.length
    ? await db.from('profiles').select('id,username').in('id', playerIds)
    : { data: [] };
  const names = new Map((playerProfiles || []).map((p) => [p.id, p.username]));
  const matchesByTournament = new Map();
  for (const m of matchRows || []) {
    if (!matchesByTournament.has(m.tournament_id)) matchesByTournament.set(m.tournament_id, []);
    matchesByTournament.get(m.tournament_id).push({
      id: m.id, round: m.round, status: m.status, result: m.result,
      player_a_name: names.get(m.player_a) || 'Player',
      player_b_name: m.player_b ? (names.get(m.player_b) || 'Player') : 'BYE',
      winner_name: names.get(m.winner_id) || null
    });
  }
  res.json({ tournaments: (rows || []).map((t) => ({
    ...tournamentPublic(t, counts.get(t.id) || 0),
    joined: (entrants || []).some((p) => p.tournament_id === t.id && p.player_id === acct.id),
    winner_name: names.get(t.winner_id) || null,
    matches: matchesByTournament.get(t.id) || []
  })), playerId: acct.id });
});

app.post('/api/tournaments', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!allowRate(`tournament:${acct.id}`, 4, 60_000)) return res.status(429).json({ error: 'Please wait before creating another tournament.' });
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const base = Math.round(Math.min(3600, Math.max(60, Number(req.body?.base) || 300)));
  const inc = Math.round(Math.min(60, Math.max(0, Number(req.body?.inc) || 0)));
  const maxPlayers = Math.round(Math.min(16, Math.max(2, Number(req.body?.maxPlayers) || 8)));
  if (name.length < 3) return res.status(400).json({ error: 'Tournament name must be at least 3 characters.' });
  const tournament = {
    id: crypto.randomUUID(), name, creator_id: acct.id, status: 'open', base, inc,
    max_players: maxPlayers
  };
  const { data, error } = await db.from('tournaments').insert(tournament).select().single();
  if (error) { console.error('/api/tournaments insert failed:', error); return res.status(500).json({ error: 'Could not create tournament.' }); }
  const { error: joinError } = await db.from('tournament_players').insert({ tournament_id: data.id, player_id: acct.id });
  if (joinError) {
    console.error('/api/tournaments host registration failed:', joinError);
    await db.from('tournaments').delete().eq('id', data.id);
    return res.status(500).json({ error: 'Could not register the host for this tournament.' });
  }
  tournaments.set(data.id, { ...data, players: [acct.id], round: 0, matches: [], byes: [], status: 'open' });
  const creatorSocket = connectedSockets.get(acct.id);
  if (creatorSocket) io.sockets.sockets.get(creatorSocket)?.join(tournamentRoom(data.id));
  res.json({ tournament: tournamentPublic(data, 1) });
});

app.post('/api/tournaments/join', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  if (!allowRate(`tournament-join:${acct.id}`, 10, 60_000)) return res.status(429).json({ error: 'Please wait before joining more tournaments.' });
  const id = String(req.body?.tournamentId || '');
  const { data: tournament, error } = await db.from('tournaments').select('*').eq('id', id).maybeSingle();
  if (error || !tournament) return res.status(404).json({ error: 'Tournament not found.' });
  if (tournament.status !== 'open') return res.status(409).json({ error: 'This tournament is no longer accepting players.' });
  const { data: entrants, error: entrantsError } = await db.from('tournament_players').select('player_id').eq('tournament_id', id);
  if (entrantsError) { console.error('/api/tournaments/join entrant lookup failed:', entrantsError); return res.status(500).json({ error: 'Could not check tournament entrants.' }); }
  const players = (entrants || []).map((p) => p.player_id);
  if (players.includes(acct.id)) return res.status(409).json({ error: 'You are already entered.' });
  if (players.length >= tournament.max_players) return res.status(409).json({ error: 'This tournament is full.' });
  const { error: joinError } = await db.from('tournament_players').insert({ tournament_id: id, player_id: acct.id });
  if (joinError) { console.error('/api/tournaments/join insert failed:', joinError); return res.status(500).json({ error: 'Could not join tournament.' }); }
  const state = tournaments.get(id);
  if (state && !state.players.includes(acct.id)) state.players.push(acct.id);
  const playerSocket = connectedSockets.get(acct.id);
  if (playerSocket) io.sockets.sockets.get(playerSocket)?.join(tournamentRoom(id));
  notifyTournament(id);
  res.json({ ok: true });
});

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function startTournamentRound(state, entrants) {
  if (entrants.length <= 1) {
    state.status = 'completed';
    state.winner = entrants[0] || null;
    await db.from('tournaments').update({ status: 'completed', winner_id: state.winner }).eq('id', state.id);
    notifyTournament(state.id);
    return;
  }
  state.round++;
  state.matches = [];
  const players = shuffle(entrants);
  state.byes = players.length % 2 ? [players.pop()] : [];
  const rowsToInsert = [];
  if (state.byes.length) {
    const byePlayer = state.byes[0];
    rowsToInsert.push({
      id: crypto.randomUUID(), tournament_id: state.id, round: state.round,
      player_a: byePlayer, player_b: null, winner_id: byePlayer, status: 'done', result: 'bye'
    });
  }
  for (let i = 0; i < players.length; i += 2) {
    const match = { id: crypto.randomUUID(), a: players[i], b: players[i + 1], winner: null, status: 'pending', gameId: null, result: null };
    state.matches.push(match);
    rowsToInsert.push({
      id: match.id, tournament_id: state.id, round: state.round,
      player_a: match.a, player_b: match.b, status: 'pending'
    });
  }
  // Insert every pairing in one database statement. A restart can therefore
  // either see the previous completed round or the complete new round, never a half bracket.
  const { error } = await db.from('tournament_matches').insert(rowsToInsert);
  if (error) throw new Error('Could not persist the complete tournament round: ' + error.message);
  await resumePendingTournamentPairs(state);
  notifyTournament(state.id);
}

async function resumePendingTournamentPairs(state) {
  if (!db || !state || state.status !== 'running') return;
  state.pairingStarting ||= new Set();
  const pending = state.matches.filter((match) => match.status === 'pending'
    || (match.status === 'done' && match.result === '1/2-1/2' && !match.winner));
  for (const match of pending) {
    if (state.pairingStarting.has(match.id)) continue;
    const sidA = connectedSockets.get(match.a), sidB = connectedSockets.get(match.b);
    if (!sidA || !sidB || !io.sockets.sockets.has(sidA) || !io.sockets.sockets.has(sidB)) continue;
    state.pairingStarting.add(match.id);
    let gameId = null;
    try {
      gameId = startGame({ sid: sidA, pid: match.a }, { sid: sidB, pid: match.b }, state.base, state.inc, {
        tournamentId: state.id, matchId: match.id, round: state.round
      }, { deferStart: true });
      const game = games.get(gameId);
      const { error } = await db.from('tournament_matches').update({
        status: 'playing', game_id: gameId, winner_id: null, result: null,
        game_state: serializeTournamentGame(game)
      }).eq('id', match.id);
      if (error) throw error;
      match.status = 'playing'; match.winner = null; match.result = null; match.gameId = gameId;
      announceStartedGame(game);
      notifyTournament(state.id);
    } catch (error) {
      if (gameId) {
        const game = games.get(gameId);
        if (game) { clearTimeout(game.timer); game.over = true; games.delete(gameId); }
      }
      state.status = 'paused';
      await db.from('tournaments').update({ status: 'paused' }).eq('id', state.id);
      console.error('Could not start tournament pairing:', match.id, error.message);
    } finally {
      state.pairingStarting.delete(match.id);
    }
  }
}

async function advanceTournament(g, result) {
  const ref = g.tournamentMatch;
  if (!ref || !db) return;
  const state = tournaments.get(ref.tournamentId);
  if (!state || state.status !== 'running') return;
  const winner = result === '1/2-1/2' ? null : result === '1-0' ? g.white.pid : g.black.pid;
  const match = state.matches.find((m) => m.id === ref.matchId);
  if (!match || match.status === 'done') return;

  // Drawn matches remain as round blockers until the same players reconnect for a replay.
  if (!winner) {
    match.status = 'done'; match.winner = null; match.result = result;
    const { error } = await db.from('tournament_matches').update({ status: 'done', winner_id: null, result }).eq('id', match.id);
    if (error) throw new Error('Could not save drawn tournament result: ' + error.message);
    await resumePendingTournamentPairs(state);
    notifyTournament(state.id);
    return;
  }

  match.status = 'done'; match.winner = winner; match.result = result;
  // Claim round advancement before awaiting the database. Multiple matches can end
  // almost simultaneously; only the final result handler may create the next round.
  const roundComplete = state.matches.every((m) => m.status === 'done');
  const waitingForDrawRematch = state.matches.some((m) => m.status === 'done' && m.result === '1/2-1/2' && !m.winner);
  const ownsAdvancement = roundComplete && !waitingForDrawRematch && !state.advancingRound;
  if (ownsAdvancement) state.advancingRound = true;
  const { error: resultError } = await db.from('tournament_matches').update({ status: 'done', winner_id: winner, result }).eq('id', match.id);
  if (resultError) {
    state.status = 'paused';
    await db.from('tournaments').update({ status: 'paused' }).eq('id', state.id);
    throw new Error('Could not save tournament match result: ' + resultError.message);
  }
  notifyTournament(state.id);
  if (!ownsAdvancement) return;

  const winners = [...state.byes, ...state.matches.map((m) => m.winner).filter(Boolean)];
  try {
    await startTournamentRound(state, winners);
  } catch (error) {
    state.status = 'paused';
    await db.from('tournaments').update({ status: 'paused' }).eq('id', state.id);
    throw error;
  } finally {
    state.advancingRound = false;
  }
}

app.post('/api/tournaments/start', async (req, res) => {
  const acct = await requireAccount(req, res);
  if (!acct) return;
  const id = String(req.body?.tournamentId || '');
  const { data: tournament, error } = await db.from('tournaments').select('*').eq('id', id).maybeSingle();
  if (error || !tournament) return res.status(404).json({ error: 'Tournament not found.' });
  if (tournament.creator_id !== acct.id) return res.status(403).json({ error: 'Only the tournament host can start it.' });
  if (tournament.status !== 'open') return res.status(409).json({ error: 'Tournament has already started.' });
  const { data: entrants, error: entrantsError } = await db.from('tournament_players').select('player_id').eq('tournament_id', id);
  if (entrantsError) { console.error('/api/tournaments/start entrant lookup failed:', entrantsError); return res.status(500).json({ error: 'Could not load tournament entrants.' }); }
  const players = (entrants || []).map((p) => p.player_id);
  if (players.length < 2) return res.status(400).json({ error: 'At least two players are needed.' });
  const offline = players.filter((pid) => !connectedSockets.has(pid) || !io.sockets.sockets.has(connectedSockets.get(pid)));
  if (offline.length) return res.status(409).json({ error: `${offline.length} player(s) must be online before the tournament can start.` });
  const playing = players.find((pid) => activeGameFor(pid));
  if (playing) return res.status(409).json({ error: 'All entrants must finish their current games first.' });
  const state = {
    ...tournament, players, round: 0, matches: [], byes: [], status: 'running', winner: null, advancingRound: false
  };
  for (const playerId of players) {
    const sid = connectedSockets.get(playerId);
    if (sid) io.sockets.sockets.get(sid)?.join(tournamentRoom(id));
  }
  tournaments.set(id, state);
  await db.from('tournaments').update({ status: 'running' }).eq('id', id);
  try { await startTournamentRound(state, players); }
  catch (e) {
    state.status = 'paused';
    await db.from('tournaments').update({ status: 'paused' }).eq('id', id);
    return res.status(500).json({ error: 'Could not create the first round.' });
  }
  notifyTournament(id);
  res.json({ ok: true, message: 'Tournament started. First-round games are being paired.' });
});


async function loadRecoveredUser(playerId, profilesById) {
  if (users.get(playerId)?.authed) return;
  const profile = profilesById.get(playerId);
  if (!profile) throw new Error(`Missing account profile for tournament player ${playerId}.`);
  const { data: actions } = await db.from('moderation_actions').select('action,expires_at')
    .eq('target_id', playerId).eq('active', true);
  const active = (actions || []).filter((action) => !action.expires_at || new Date(action.expires_at).getTime() > Date.now());
  users.set(playerId, {
    name: profile.username, rating: profile.rating, rd: profile.rating_deviation ?? 350,
    volatility: profile.volatility ?? 0.06, games: profile.games_played || 0,
    since: profile.created_at, banned: active.some((action) => action.action === 'ban'),
    muted: active.some((action) => action.action === 'mute'),
    muteUntil: active.find((action) => action.action === 'mute')?.expires_at
      ? new Date(active.find((action) => action.action === 'mute').expires_at).getTime() : null,
    authed: true
  });
}

async function restoreActiveTournaments() {
  if (!db) return;
  const { data: activeTournaments, error } = await db.from('tournaments').select('*').in('status', ['running', 'paused']);
  if (error) throw new Error('Could not load active tournaments: ' + error.message);
  for (const tournament of activeTournaments || []) {
    const [{ data: entrantRows, error: entrantError }, { data: matchRows, error: matchError }] = await Promise.all([
      db.from('tournament_players').select('player_id').eq('tournament_id', tournament.id),
      db.from('tournament_matches').select('*').eq('tournament_id', tournament.id).order('round', { ascending: true })
    ]);
    if (entrantError || matchError) {
      console.error('Tournament recovery lookup failed:', tournament.id, entrantError?.message || matchError?.message);
      continue;
    }
    const playerIds = [...new Set([...(entrantRows || []).map((row) => row.player_id), ...(matchRows || []).flatMap((row) => [row.player_a, row.player_b, row.winner_id]).filter(Boolean)])];
    const { data: profiles, error: profileError } = playerIds.length
      ? await db.from('profiles').select('*').in('id', playerIds)
      : { data: [], error: null };
    if (profileError) { console.error('Tournament profile restore failed:', profileError.message); continue; }
    const profilesById = new Map((profiles || []).map((profile) => [profile.id, profile]));
    const state = hydrateTournamentState(tournament, (entrantRows || []).map((row) => row.player_id), matchRows || []);
    const activeGameIds = state.matches.filter((match) => match.status === 'playing' && match.gameId).map((match) => match.gameId);
    const { data: committedGames, error: committedGamesError } = activeGameIds.length
      ? await db.from('games').select('id,result,reason').in('id', activeGameIds)
      : { data: [], error: null };
    if (committedGamesError) {
      console.error('Tournament result recovery lookup failed:', committedGamesError.message);
      continue;
    }
    const committedByGameId = new Map((committedGames || []).map((row) => [row.id, row]));
    const pendingDrawReplay = state.matches.some((match) => match.status === 'done' && match.result === '1/2-1/2' && !match.winner);
    const pendingPairing = state.matches.some((match) => match.status === 'pending');
    if (state.status === 'paused' && (pendingPairing || pendingDrawReplay || state.matches.some((match) => match.status === 'playing'
        && (matchRows || []).some((row) => row.id === match.id && row.game_state)))) {
      state.status = 'running';
      await db.from('tournaments').update({ status: 'running' }).eq('id', tournament.id);
    }
    tournaments.set(tournament.id, state);
    let recoveryFailed = false;
    for (const match of state.matches.filter((item) => item.status === 'playing')) {
      const row = (matchRows || []).find((item) => item.id === match.id);
      try {
        const saved = row?.game_state;
        if (!saved || !row.game_id) throw new Error('No saved position is available for this active pairing.');
        await loadRecoveredUser(saved.whitePid, profilesById);
        await loadRecoveredUser(saved.blackPid, profilesById);
        const chess = restoreChess(saved);
        const white = { pid: saved.whitePid, sid: null };
        const black = { pid: saved.blackPid, sid: null };
        const game = {
          id: row.game_id, chess, white, black, base: saved.base || tournament.base,
          inc: saved.inc ?? tournament.inc, clock: { w: Number(saved.clock.w), b: Number(saved.clock.b) },
          turnStart: Date.now(), started: false, recoveryPaused: true, over: false,
          draw: saved.draw || null, drawLock: saved.drawLock || { w: DRAW_MIN_PLY, b: DRAW_MIN_PLY },
          drawCount: saved.drawCount || { w: 0, b: 0 }, chat: [],
          timing: saved.timing || { w: { total: 0, veryFast: 0 }, b: { total: 0, veryFast: 0 } },
          pendingResult: saved.pendingResult || null,
          tournamentMatch: { tournamentId: tournament.id, matchId: match.id, round: state.round },
          checkpointChain: Promise.resolve()
        };
        games.set(game.id, game);
        match.gameId = game.id;
        const committedResult = committedByGameId.get(row.game_id);
        const pendingResult = saved.pendingResult || (committedResult ? { result: committedResult.result, reason: committedResult.reason } : null);
        if (pendingResult) {
          const finalized = await endGame(game, pendingResult.result, pendingResult.reason);
          if (!finalized) recoveryFailed = true;
        } else if (chess.isCheckmate()) {
          const finalized = await endGame(game, chess.turn() === 'w' ? '0-1' : '1-0', 'checkmate');
          if (!finalized) recoveryFailed = true;
        } else if (chess.isDraw()) {
          const finalized = await endGame(game, '1/2-1/2', chess.isStalemate() ? 'stalemate' : chess.isThreefoldRepetition() ? 'repetition' : 'draw');
          if (!finalized) recoveryFailed = true;
        }
      } catch (error) {
        recoveryFailed = true;
        console.error('Could not restore tournament match:', match.id, error.message);
      }
    }
    for (const playerId of state.players) {
      const sid = connectedSockets.get(playerId);
      if (sid) io.sockets.sockets.get(sid)?.join(tournamentRoom(tournament.id));
    }
    if (recoveryFailed) {
      state.status = 'paused';
      await db.from('tournaments').update({ status: 'paused' }).eq('id', tournament.id);
    } else if (state.round === 0 && state.players.length >= 2 && ['running', 'paused'].includes(state.status)) {
      // A process may stop after marking a new tournament running but before its
      // first round rows are inserted. Recreate the round from the entrant list.
      state.status = 'running';
      await db.from('tournaments').update({ status: 'running' }).eq('id', tournament.id);
      try { await startTournamentRound(state, state.players); }
      catch (error) {
        state.status = 'paused';
        await db.from('tournaments').update({ status: 'paused' }).eq('id', tournament.id);
        console.error('Could not initialize recovered first round:', error.message);
      }
    } else if (state.status === 'paused' && state.matches.some((match) => match.status === 'playing')) {
      state.status = 'running';
      await db.from('tournaments').update({ status: 'running' }).eq('id', tournament.id);
    }

    // A crash can occur after the final match result was committed but before the next
    // round was created. Complete that transition exactly once during bootstrap.
    if (!recoveryFailed && state.status === 'running' && state.round > 0
        && state.matches.length && state.matches.every((match) => match.status === 'done')
        && !state.matches.some((match) => match.result === '1/2-1/2' && !match.winner)) {
      const winners = [...state.byes, ...state.matches.map((match) => match.winner).filter(Boolean)];
      state.advancingRound = true;
      try { await startTournamentRound(state, winners); }
      catch (error) {
        state.status = 'paused';
        await db.from('tournaments').update({ status: 'paused' }).eq('id', tournament.id);
        console.error('Could not advance recovered tournament:', error.message);
      } finally { state.advancingRound = false; }
    }
    await resumePendingTournamentPairs(state);
    notifyTournament(tournament.id);
  }
}

io.on('connection', (socket) => {

  let pid = null;

  socket.on('hello', async ({ id, name, token }) => {
    try {
      if (token && db) {
        const a = await accountFor(token);
        pid = a.id;
        if (a.banned) {
          socket.emit('autherror', { signOut: false, text: 'This account is suspended. Contact a moderator if you think this is a mistake.' });
          return;
        }
      } else {
        // Guests get a "g:" prefix so they can never collide with real account ids.
        pid = 'g:' + String(id || crypto.randomUUID()).slice(0, 40);
        if (!users.has(pid)) users.set(pid, { name: String(name || 'Guest').slice(0, 20), rating: 1200, rd: 350, volatility: 0.06, games: 0, authed: false });
        else if (name) users.get(pid).name = String(name).slice(0, 20);
      }
      connectedSockets.set(pid, socket.id);
      users.get(pid).sid = socket.id;
      if (users.get(pid).authed) {
        joinPlayerTournaments(socket, pid);
        for (const state of tournaments.values()) {
          if (state.players.includes(pid)) await resumePendingTournamentPairs(state);
        }
      }
      const current = users.get(pid);
      socket.emit('me', {
        id: pid, name: current.name, ...publicPlayer(current),
        since: current.since, authed: !!current.authed, isAdmin: isAdmin(pid)
      });
      const live = activeGameFor(pid);
      if (live) resume(socket, live, pid);
    } catch (e) {
      console.error('hello failed:', e.message);
      const expired = e.message === 'invalid session';
      socket.emit('autherror', {
        signOut: expired,
        text: expired ? 'Session expired. Please log in again.' : 'Could not load your account, so you are playing as a guest.'
      });
    }
  });

  socket.on('seek', ({ base, inc }) => {
    if (!pid) return;
    const live = activeGameFor(pid);
    if (live) return resume(socket, live, pid);
    base = Math.min(Math.max(+base || 300, 30), 3600);
    inc = Math.min(Math.max(+inc || 0, 0), 60);
    const key = `${base}+${inc}`;
    const waiting = queues.get(key);
    if (waiting && waiting.pid !== pid && io.sockets.sockets.get(waiting.sid)) {
      queues.delete(key);
      startGame(waiting, { sid: socket.id, pid }, base, inc);
    } else {
      queues.set(key, { sid: socket.id, pid });
      socket.emit('waiting', key);
    }
  });

  socket.on('cancelSeek', () => {
    for (const [k, v] of queues) if (v.sid === socket.id) queues.delete(k);
  });

  // `ack` is optional: clients use it to learn whether the move was accepted.
  socket.on('move', async ({ gameId, from, to, promotion } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const g = games.get(gameId);
    if (!g || g.over) return reply({ ok: false });
    if (g.recoveryPaused) return reply({ ok: false, error: 'Waiting for both tournament players to reconnect.' });
    if (!allowRate(`move:${pid || socket.id}`, 40, 10_000)) return reply({ ok: false, error: 'rate limited' });
    const side = g.chess.turn();
    const player = side === 'w' ? g.white : g.black;
    if (player.sid !== socket.id) return reply({ ok: false });

    const now = Date.now();
    const spent = g.started ? now - g.turnStart : 0;
    if (g.clock[side] - spent <= 0) { g.clock[side] = 0; return endGame(g, side === 'w' ? '0-1' : '1-0', 'timeout'); }

    // Only Queen, Rook, Bishop or Knight are valid; anything else falls back to Queen.
    const promo = typeof promotion === 'string' && 'qrbn'.includes(promotion.toLowerCase()) && promotion.length === 1
      ? promotion.toLowerCase() : 'q';
    // Validate before touching the clock, so an illegal attempt never costs time.
    let mv;
    try { mv = g.chess.move({ from, to, promotion: promo }); } catch { return reply({ ok: false }); }
    g.clock[side] -= spent;
    if (g.started) g.clock[side] += g.inc * 1000;
    g.turnStart = now;
    g.timing[side].total++;
    if (spent < 120) g.timing[side].veryFast++;
    if (db && !g.integrityFlagged && g.timing.w.total >= 12 && g.timing.b.total >= 12) {
      const wFast = g.timing.w.veryFast / g.timing.w.total;
      const bFast = g.timing.b.veryFast / g.timing.b.total;
      if (wFast >= 0.9 || bFast >= 0.9) {
        g.integrityFlagged = true;
        const flagged = wFast >= 0.9 ? g.white : g.black;
        db.from('integrity_flags').insert({
          game_id: g.id, player_id: flagged.pid.startsWith('g:') ? null : flagged.pid,
          signal: 'very_fast_moves',
          details: { very_fast_ratio: wFast >= 0.9 ? wFast : bFast, moves: g.timing[wFast >= 0.9 ? 'w' : 'b'].total }
        }).then(({ error }) => { if (error) console.error('integrity flag failed:', error.message); });
      }
    }
    await queueTournamentCheckpoint(g);
    reply({ ok: true });

    // A draw offer lapses when the player it was made to moves instead of answering.
    if (g.draw && g.draw.by !== side) clearDraw(g, 'ignored');

    io.to(g.id).emit('state', {
      fen: g.chess.fen(), san: mv.san, from: mv.from, to: mv.to,
      clock: g.clock, turn: g.chess.turn(), started: g.started
    });

    if (g.chess.isCheckmate()) return endGame(g, side === 'w' ? '1-0' : '0-1', 'checkmate');
    if (g.chess.isStalemate()) return endGame(g, '1/2-1/2', 'stalemate');
    if (g.chess.isInsufficientMaterial()) return endGame(g, '1/2-1/2', 'insufficient material');
    if (g.chess.isThreefoldRepetition()) return endGame(g, '1/2-1/2', 'repetition');
    if (g.chess.isDraw()) return endGame(g, '1/2-1/2', 'draw');
    if (g.started) scheduleTimeout(g); else clearTimeout(g.timer);
  });

  socket.on('chat', ({ gameId, text } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const g = games.get(gameId);
    if (!g || g.over || !sideOf(g, socket.id)) return reply({ ok: false, error: 'not in game' });
    const user = users.get(pid);
    if (user?.muted && (!user.muteUntil || user.muteUntil > Date.now())) return reply({ ok: false, error: 'Your chat is muted.' });
    if (user?.muteUntil && user.muteUntil <= Date.now()) user.muted = false;
    if (!allowRate(`chat:${pid || socket.id}`, 6, 10_000)) return reply({ ok: false, error: 'Slow down before sending another message.' });
    const message = String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, 240);
    if (!message) return reply({ ok: false, error: 'Write a message first.' });
    const item = {
      id: crypto.randomUUID(), playerId: pid, name: user?.name || 'Player',
      color: sideOf(g, socket.id), text: message, at: Date.now()
    };
    g.chat.push(item);
    if (g.chat.length > 50) g.chat.shift();
    io.to(g.id).emit('chatMessage', item);
    reply({ ok: true });
  });

  socket.on('reportOpponent', ({ gameId, reason } = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const g = games.get(gameId), me = g && sideOf(g, socket.id);
    if (!g || g.over || !me) return reply({ ok: false, error: 'This game is no longer reportable.' });
    if (!db) return reply({ ok: false, error: 'Reports require the server database to be configured.' });
    if (!allowRate(`report:${pid || socket.id}`, 2, 60_000)) return reply({ ok: false, error: 'Please wait before submitting another report.' });
    const detail = String(reason || '').trim().slice(0, 500);
    if (detail.length < 5) return reply({ ok: false, error: 'Add a little more detail to the report.' });
    const opponent = me === 'w' ? g.black : g.white;
    db.from('moderation_reports').insert({
      reporter_id: pid && !pid.startsWith('g:') ? pid : null,
      reported_id: opponent.pid.startsWith('g:') ? null : opponent.pid,
      game_id: g.id, reason: detail, status: 'open'
    }).then(({ error }) => reply(error ? { ok: false, error: 'Could not submit the report.' } : { ok: true, message: 'Report submitted for moderator review.' }));
  });

  socket.on('drawOffer', ({ gameId } = {}) => {
    const g = games.get(gameId);
    if (!g || g.over) return;
    const me = sideOf(g, socket.id);
    if (!me) return;
    const err = (text) => socket.emit('drawError', { text, lockedUntil: g.drawLock[me] });
    // If the opponent already offered, offering back simply accepts.
    if (g.draw && g.draw.by !== me) return endGame(g, '1/2-1/2', 'agreement');
    if (g.draw) return err('You already offered a draw.');
    if (ply(g) < DRAW_MIN_PLY) return err('You can offer a draw after the first moves.');
    if (g.drawCount[me] >= DRAW_MAX_OFFERS) return err(`You have used all ${DRAW_MAX_OFFERS} draw offers for this game.`);
    if (ply(g) < g.drawLock[me]) return err('Make a couple more moves before offering a draw again.');
    g.drawCount[me]++;
    g.drawLock[me] = ply(g) + DRAW_COOLDOWN_PLY;
    g.draw = { by: me };
    io.to(g.id).emit('drawOffer', { by: me, lockedUntil: g.drawLock[me] });
  });

  socket.on('drawAccept', ({ gameId } = {}) => {
    const g = games.get(gameId);
    if (!g || g.over || !g.draw) return;
    const me = sideOf(g, socket.id);
    if (me && g.draw.by !== me) endGame(g, '1/2-1/2', 'agreement');
  });

  socket.on('drawDecline', ({ gameId } = {}) => {
    const g = games.get(gameId);
    if (!g || g.over || !g.draw) return;
    const me = sideOf(g, socket.id);
    if (me && g.draw.by !== me) clearDraw(g, 'declined');
  });

  socket.on('drawCancel', ({ gameId } = {}) => {
    const g = games.get(gameId);
    if (!g || g.over || !g.draw) return;
    if (sideOf(g, socket.id) === g.draw.by) clearDraw(g, 'cancelled');
  });

  socket.on('resign', ({ gameId }) => {
    const g = games.get(gameId);
    if (!g) return;
    if (g.white.sid === socket.id) endGame(g, '0-1', 'resignation');
    else if (g.black.sid === socket.id) endGame(g, '1-0', 'resignation');
  });

  socket.on('disconnect', () => {
    for (const [k, v] of queues) if (v.sid === socket.id) queues.delete(k);
    if (pid && connectedSockets.get(pid) === socket.id) connectedSockets.delete(pid);
    for (const g of games.values()) {
      if (g.over) continue;
      if (!g.recoveryPaused && (g.white.sid === socket.id || g.black.sid === socket.id)) {
        // Give them 30s to come back before forfeiting.
        const white = g.white.sid === socket.id;
        io.to(g.id).emit('opp', { online: false, seconds: 30 });
        setTimeout(() => {
          const p = white ? g.white : g.black;
          if (p.sid === socket.id) endGame(g, white ? '0-1' : '1-0', 'abandoned');
        }, 30000);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

async function* nativeStockfishGzipParts() {
  for (const objectName of nativeStockfishObjects) {
    const { data, error } = await db.storage.from(nativeStockfishBucket).createSignedUrl(objectName, 300);
    if (error || !data?.signedUrl) {
      throw new Error(`Could not create a download URL for ${objectName}: ${error?.message || 'no signed URL returned'}`);
    }
    const downloadUrl = new URL(data.signedUrl, process.env.SUPABASE_URL).toString();
    const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) {
      throw new Error(`Private Storage download failed for ${objectName} (HTTP ${response.status}).`);
    }
    // The uploaded objects are adjacent byte ranges of one gzip stream. Yielding
    // their bodies sequentially reconstructs the exact original gzip byte stream.
    for await (const chunk of Readable.fromWeb(response.body)) yield chunk;
  }
}

async function loadNativeStockfishFromStorage() {
  if (!nativeStockfishObjects.length) return;
  if (!db) throw new Error('Supabase service-role client is not configured.');

  const dir = path.join(os.tmpdir(), 'zugzwang-engine');
  await fs.promises.mkdir(dir, { recursive: true });
  const executable = path.join(dir, 'stockfish');
  await pipeline(Readable.from(nativeStockfishGzipParts()), createGunzip(), fs.createWriteStream(executable, { mode: 0o700 }));
  await fs.promises.chmod(executable, 0o755);

  stockfish.command = executable;
  await stockfish.start(); // Validate the Linux binary and complete its UCI handshake before marking it ready.
  nativeStockfishStatus.ready = true;
  nativeStockfishStatus.error = null;
  console.log(`Native Stockfish ready from private Supabase Storage (${nativeStockfishBucket}/${nativeStockfishObjects.join(', ')}): ${stockfish.name}`);
}

async function boot() {
  try { await loadNativeStockfishFromStorage(); }
  catch (error) {
    nativeStockfishStatus.error = error.message || String(error);
    console.error('Native Stockfish Storage initialization failed:', nativeStockfishStatus.error);
    console.warn('Server will continue, but native-engine anti-cheat review will be unavailable until the binary is configured correctly.');
  }
  try { await restoreActiveTournaments(); }
  catch (error) { console.error('Tournament recovery initialization failed:', error.message); }
  server.listen(PORT, () => console.log(`Chess server on http://localhost:${PORT}`));
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; saving active tournament games...`);
  clearInterval(tournamentCheckpointTimer);
  for (const game of games.values()) clearTimeout(game.timer);
  await Promise.all([...games.values()].filter((game) => game.tournamentMatch).map(async (game) => {
    try {
      await game.checkpointChain;
      await saveTournamentCheckpoint(game);
    } catch (error) { console.error('Final tournament checkpoint failed:', error.message); }
  }));
  await stockfish.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
boot();
