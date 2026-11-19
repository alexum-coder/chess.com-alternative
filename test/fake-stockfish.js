#!/usr/bin/env node
'use strict';
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line === 'uci') {
    process.stdout.write('id name Stockfish Mock 1\nuciok\n');
  } else if (line === 'isready') {
    process.stdout.write('readyok\n');
  } else if (line.startsWith('go depth ')) {
    process.stdout.write('info depth 12 score cp 27 nodes 100\nbestmove e2e4 ponder e7e5\n');
  } else if (line === 'quit') {
    process.exit(0);
  }
});
