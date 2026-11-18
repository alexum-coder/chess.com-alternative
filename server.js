const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const path = require('path');
const fs = require('fs');
// Serve index.html from ./public, or from the same folder if it was downloaded without the folder.
const pub = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
app.get('/', (req, res) => res.sendFile(path.join(pub, 'index.html')));
app.use(express.static(pub, { index: false }));
console.log('Serving client from', pub);

// In-memory stores. Swap for a database (e.g. Supabase free tier) to persist.
const users = new Map();   // playerId -> { name, rating }
const queues = new Map();  // "base+inc" -> waiting seeker { sid, pid }
const games = new Map();   // gameId -> game

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

function startGame(a, b, base, inc) {
  const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a];
  const g = {
    id: crypto.randomBytes(5).toString('hex'),
    chess: new Chess(),
    white, black, inc,
    clock: { w: base * 1000, b: base * 1000 },
    turnStart: Date.now(),
    started: false, over: false
  };
  games.set(g.id, g);
  for (const p of [white, black]) io.sockets.sockets.get(p.sid)?.join(g.id);
  const info = (p) => ({ name: users.get(p.pid).name, rating: users.get(p.pid).rating });
  for (const [p, color] of [[white, 'w'], [black, 'b']]) {
    io.to(p.sid).emit('start', {
      gameId: g.id, color, fen: g.chess.fen(), clock: g.clock, inc,
      white: info(white), black: info(black)
    });
  }
  scheduleTimeout(g);
}

io.on('connection', (socket) => {
  let pid = null;

  socket.on('hello', ({ id, name }) => {
    pid = String(id || '').slice(0, 40) || crypto.randomUUID();
    if (!users.has(pid)) {
      users.set(pid, { name: String(name || 'Guest').slice(0, 20), rating: 1200 });
    } else if (name) {
      users.get(pid).name = String(name).slice(0, 20);
    }
    socket.emit('me', { id: pid, ...users.get(pid) });
  });

  socket.on('seek', ({ base, inc }) => {
    if (!pid) return;
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
    // Clock starts ticking only after White's first move (like real chess sites).
    if (g.started) g.clock[side] -= now - g.turnStart;
    if (g.clock[side] <= 0) return endGame(g, side === 'w' ? '0-1' : '1-0', 'timeout');

    let mv;
    try { mv = g.chess.move({ from, to, promotion: promotion || 'q' }); } catch { return; }
    if (g.started) g.clock[side] += g.inc * 1000;
    if (g.chess.history().length >= 2) g.started = true;
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