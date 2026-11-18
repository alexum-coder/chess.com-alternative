require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const crypto = require('crypto');

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
    .gt('games_played', 0).order('rating', { ascending: false }).limit(10);
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
    users.set(u.id, { name: prof.username, rating: prof.rating, games: prof.games_played, since: prof.created_at, authed: true });
  }
  return { id: u.id, ...users.get(u.id) };
}
const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer /, '');

app.use(express.json());
app.get('/api/me', async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Accounts are not set up.' });
  try { res.json(await accountFor(bearer(req))); }
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

app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.use(express.static(pub, { index: false }));
console.log('Serving client from', pub);

// In-memory stores. Swap for a database (e.g. Supabase free tier) to persist.
const users = new Map();   // playerId -> { name, rating }
const queues = new Map();  // "base+inc" -> waiting seeker { sid, pid }
const games = new Map();   // gameId -> game

async function persist(g, w, b, result, reason, pgn) {
  if (!db) return;
  try {
    for (const [p, u] of [[g.white, w], [g.black, b]]) {
      if (!u.authed) continue;
      u.games = (u.games || 0) + 1;
      await db.from('profiles').update({ rating: u.rating, games_played: u.games }).eq('id', p.pid);
    }
    await db.from('games').insert({
      id: g.id, white: w.authed ? g.white.pid : null, black: b.authed ? g.black.pid : null,
      white_name: w.name, black_name: b.name, result, reason, pgn, base: g.base, inc: g.inc
    });
  } catch (e) { console.error('persist failed', e.message); }
}

const K = 32;
const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));

function endGame(g, result, reason) {
  if (g.over) return;
  g.over = true;
  clearTimeout(g.timer);
  const w = users.get(g.white.pid), b = users.get(g.black.pid);
  const sw = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  const ew = expected(w.rating, b.rating);
  const dw = Math.round(K * (sw - ew));
  w.rating += dw;
  b.rating -= dw;
  persist(g, w, b, result, reason, g.chess.pgn());
  io.to(g.id).emit('over', {
    result, reason,
    ratings: { w: w.rating, b: b.rating, dw }
  });
  games.delete(g.id);
}

function scheduleTimeout(g) {
  clearTimeout(g.timer);
  const side = g.chess.turn();
  g.timer = setTimeout(() => {
    endGame(g, side === 'w' ? '0-1' : '1-0', 'timeout');
  }, g.clock[side] + 50);
}

const info = (p) => ({ name: users.get(p.pid).name, rating: users.get(p.pid).rating });

// Everything a client needs to draw a game from scratch (used for new games and reconnects).
function snapshot(g, color) {
  const hist = g.chess.history({ verbose: true });
  const last = hist[hist.length - 1];
  return {
    gameId: g.id, color, fen: g.chess.fen(), clock: g.clock, elapsed: Date.now() - g.turnStart,
    turn: g.chess.turn(), started: g.started, inc: g.inc, base: g.base,
    moves: hist.map((m) => m.san), last: last ? [last.from, last.to] : null,
    white: info(g.white), black: info(g.black)
  };
}
const activeGameFor = (pid) => [...games.values()].find((g) => !g.over && (g.white.pid === pid || g.black.pid === pid));

function resume(socket, g, pid) {
  const isWhite = g.white.pid === pid;
  (isWhite ? g.white : g.black).sid = socket.id;
  socket.join(g.id);
  socket.emit('start', snapshot(g, isWhite ? 'w' : 'b'));
  io.to(g.id).emit('opp', { online: true });
}

function startGame(a, b, base, inc) {
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  const g = {
    id: crypto.randomBytes(5).toString('hex'),
    chess: new Chess(),
    white, black, inc, base,
    clock: { w: base * 1000, b: base * 1000 },
    turnStart: Date.now(),
    started: true, over: false
  };
  games.set(g.id, g);
  for (const p of [white, black]) io.sockets.sockets.get(p.sid)?.join(g.id);
  for (const [p, color] of [[white, 'w'], [black, 'b']]) io.to(p.sid).emit('start', snapshot(g, color));
  scheduleTimeout(g);
}

io.on('connection', (socket) => {
  let pid = null;

  socket.on('hello', async ({ id, name, token }) => {
    try {
      if (token && db) {
        const a = await accountFor(token);
        pid = a.id;
      } else {
        // Guests get a "g:" prefix so they can never collide with real account ids.
        pid = 'g:' + String(id || crypto.randomUUID()).slice(0, 40);
        if (!users.has(pid)) users.set(pid, { name: String(name || 'Guest').slice(0, 20), rating: 1200 });
        else if (name) users.get(pid).name = String(name).slice(0, 20);
      }
      socket.emit('me', { id: pid, ...users.get(pid) });
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

  socket.on('move', ({ gameId, from, to, promotion }) => {
    const g = games.get(gameId);
    if (!g || g.over) return;
    const side = g.chess.turn();
    const player = side === 'w' ? g.white : g.black;
    if (player.sid !== socket.id) return;

    const now = Date.now();
    if (g.started) g.clock[side] -= now - g.turnStart;
    if (g.clock[side] <= 0) return endGame(g, side === 'w' ? '0-1' : '1-0', 'timeout');

    let mv;
    try { mv = g.chess.move({ from, to, promotion: promotion || 'q' }); } catch { return; }
    if (g.started) g.clock[side] += g.inc * 1000;
    g.turnStart = now;

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

  socket.on('resign', ({ gameId }) => {
    const g = games.get(gameId);
    if (!g) return;
    if (g.white.sid === socket.id) endGame(g, '0-1', 'resignation');
    else if (g.black.sid === socket.id) endGame(g, '1-0', 'resignation');
  });

  socket.on('disconnect', () => {
    for (const [k, v] of queues) if (v.sid === socket.id) queues.delete(k);
    for (const g of games.values()) {
      if (g.over) continue;
      if (g.white.sid === socket.id || g.black.sid === socket.id) {
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
server.listen(PORT, () => console.log(`Chess server on http://localhost:${PORT}`));
