'use strict';

const { spawn } = require('node:child_process');
const readline = require('node:readline');

/** A small, serialized UCI client for a locally installed Stockfish executable. */
class StockfishAnalyzer {
  constructor({ command = process.env.STOCKFISH_PATH || 'stockfish', args = [], depth = Number(process.env.STOCKFISH_DEPTH) || 11 } = {}) {
    this.command = command;
    this.args = args;
    this.depth = Math.max(8, Math.min(20, depth));
    this.child = null;
    this.ready = null;
    this.name = 'Stockfish (UCI)';
    this.waiters = [];
    this.active = null;
    this.queue = Promise.resolve();
  }

  send(command) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error('Stockfish is not running.');
    this.child.stdin.write(command + '\n');
  }

  waitFor(predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error('Stockfish timed out during UCI startup.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  onLine(line) {
    if (!line) return;
    const idName = line.match(/^id name\s+(.+)$/i);
    if (idName) this.name = idName[1].trim();

    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(line)) {
        clearTimeout(waiter.timer);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        waiter.resolve(line);
        break;
      }
    }

    if (!this.active) return;
    const score = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    const depth = line.match(/\bdepth\s+(\d+)/);
    if (score) {
      const candidate = {
        type: score[1], value: Number(score[2]),
        depth: depth ? Number(depth[1]) : 0
      };
      if (!this.active.score || candidate.depth >= this.active.score.depth) this.active.score = candidate;
    }
    const best = line.match(/^bestmove\s+(\S+)/);
    if (best) {
      const active = this.active;
      this.active = null;
      clearTimeout(active.timer);
      active.resolve({ bestMove: best[1], score: active.score, engine: this.name });
    }
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = readline.createInterface({ input: this.child.stdout });
      lines.on('line', (line) => this.onLine(line.trim()));
      this.child.on('error', (error) => this.fail(error));
      this.child.on('exit', (code, signal) => this.fail(new Error(`Stockfish exited (${code ?? signal ?? 'unknown'}).`)));
      const uciOk = this.waitFor((line) => line === 'uciok');
      this.send('uci');
      await uciOk;
      this.send('setoption name Threads value 1');
      this.send('setoption name Hash value 64');
      const readyOk = this.waitFor((line) => line === 'readyok');
      this.send('isready');
      await readyOk;
      return true;
    })().catch((error) => {
      this.ready = null;
      this.terminate();
      throw error;
    });
    return this.ready;
  }

  fail(error) {
    this.ready = null;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    if (this.active) {
      const active = this.active;
      this.active = null;
      clearTimeout(active.timer);
      active.reject(error);
    }
  }

  analyze(fen) {
    const task = this.queue.then(() => this.analyzeNow(fen));
    this.queue = task.catch(() => {});
    return task;
  }

  async analyzeNow(fen) {
    await this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.active?.resolve === resolve) {
          this.active = null;
          try { this.send('stop'); } catch {}
          reject(new Error('Stockfish analysis timed out.'));
        }
      }, 20000);
      this.active = { resolve, reject, score: null, timer };
      try {
        this.send('position fen ' + fen);
        this.send('go depth ' + this.depth);
      } catch (error) {
        clearTimeout(timer);
        this.active = null;
        reject(error);
      }
    });
  }

  async terminate() {
    try { this.send('quit'); } catch {}
    if (this.child && !this.child.killed) this.child.kill();
    this.child = null;
    this.ready = null;
  }
}

module.exports = { StockfishAnalyzer };
