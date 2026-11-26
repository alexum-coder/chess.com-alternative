/** Shared Zugzwang chessboard renderer used by live games, puzzles and computer games. */
const FILES = 'abcdefgh';

export class ZugzwangBoard {
  constructor(root, onSquare = () => {}) {
    if (!root) throw new Error('A board root element is required.');
    this.root = root;
    this.onSquare = onSquare;
    this.root.classList.add('zz-board');
    this.root.setAttribute('role', 'grid');
    this.root.setAttribute('aria-label', 'Chess board');
  }

  render({
    position,
    orientation = 'white',
    selected = null,
    targets = [],
    lastMove = [],
    inCheck = false,
    turn = 'w',
    premove = null,
    premoveTargets = false,
    moveAnnotation = null,
    hintSquare = null,
    solutionArrow = null,
    interactive = true
  } = {}) {
    if (!Array.isArray(position) || position.length !== 8) {
      throw new TypeError('Board position must be the 8×8 array returned by chess.board().');
    }

    const flip = orientation === 'black';
    const targetSet = new Set(targets || []);
    const lastSet = new Set(lastMove || []);
    const frag = document.createDocumentFragment();

    for (let displayRow = 0; displayRow < 8; displayRow++) {
      for (let displayCol = 0; displayCol < 8; displayCol++) {
        const row = flip ? 7 - displayRow : displayRow;
        const col = flip ? 7 - displayCol : displayCol;
        const square = FILES[col] + (8 - row);
        const piece = position[row][col];
        const el = document.createElement('div');
        el.className = 'sq ' + ((row + col) % 2 ? 'd' : 'l');
        el.dataset.sq = square;
        el.tabIndex = interactive ? 0 : -1;
        el.setAttribute('role', 'gridcell');
        el.setAttribute('aria-label', square + (piece ? ` ${piece.color === 'w' ? 'White' : 'Black'} ${piece.type}` : ' empty'));

        if (lastSet.has(square)) el.classList.add('last');
        if (selected === square) el.classList.add('sel');
        if (hintSquare === square) el.classList.add('puzzle-hint-square');
        if (moveAnnotation?.from === square) el.classList.add('review-move-from');
        if (moveAnnotation?.to === square) el.classList.add('review-move-to');
        if (moveAnnotation?.from === square || moveAnnotation?.to === square) {
          el.style.setProperty('--review-annotation-color', moveAnnotation.color || '#81b64c');
          el.setAttribute('aria-label', `${el.getAttribute('aria-label')} · ${moveAnnotation.label || moveAnnotation.key || 'review'} ${moveAnnotation.from === square ? 'move origin' : 'move destination'}`);
        }
        if (targetSet.has(square)) {
          el.classList.add('target');
          if (piece) el.classList.add('cap');
          if (premoveTargets) el.classList.add('pre');
        }
        if (premove?.from === square) el.classList.add('pre-from');
        if (premove?.to === square) el.classList.add('pre-to');
        if (inCheck && piece?.type === 'k' && piece.color === turn) el.classList.add('chk');
        if (piece) el.appendChild(this.#piece(piece.color, piece.type));
        if (moveAnnotation?.to === square) el.appendChild(this.#reviewBadge(moveAnnotation));

        if (premove?.to === square && premove.from) {
          const fromRow = 8 - Number(premove.from[1]);
          const fromCol = FILES.indexOf(premove.from[0]);
          const mover = position[fromRow]?.[fromCol];
          if (mover) {
            const ghost = this.#piece(mover.color, premove.promotion || mover.type);
            ghost.classList.add('ghost');
            el.appendChild(ghost);
          }
        }

        if (displayRow === 7) {
          const file = document.createElement('i');
          file.className = 'f'; file.textContent = FILES[col]; el.appendChild(file);
        }
        if (displayCol === 0) {
          const rank = document.createElement('i');
          rank.className = 'r'; rank.textContent = String(8 - row); el.appendChild(rank);
        }

        if (interactive) {
          el.addEventListener('click', () => this.onSquare(square));
          el.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault(); this.onSquare(square);
            }
          });
        }
        frag.appendChild(el);
      }
    }
    this.root.replaceChildren(frag);
    if (solutionArrow?.from && solutionArrow?.to) this.#appendSolutionArrow(solutionArrow, flip);
  }

  #appendSolutionArrow({ from, to }, flip) {
    const squareCenter = (square) => {
      if (!/^[a-h][1-8]$/.test(square)) return null;
      const file = FILES.indexOf(square[0]);
      const rank = Number(square[1]);
      const col = flip ? 7 - file : file;
      const row = flip ? rank - 1 : 8 - rank;
      return { x: (col + 0.5) * 100, y: (row + 0.5) * 100 };
    };
    const a = squareCenter(from), b = squareCenter(to);
    if (!a || !b) return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 800 800');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('zz-solution-arrow');
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'zz-puzzle-arrow-head'); marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7'); marker.setAttribute('orient', 'auto-start-reverse');
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); head.setAttribute('fill', '#ffe16b');
    marker.appendChild(head); defs.appendChild(marker); svg.appendChild(defs);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
    line.setAttribute('stroke', '#ffe16b'); line.setAttribute('stroke-width', '17');
    line.setAttribute('stroke-linecap', 'round'); line.setAttribute('marker-end', 'url(#zz-puzzle-arrow-head)');
    line.setAttribute('opacity', '.94'); svg.appendChild(line);
    this.root.appendChild(svg);
  }

  #reviewBadge(annotation) {
    const badge = document.createElement('span');
    badge.className = `zz-review-badge mark-${annotation.key || 'good'}`;
    badge.setAttribute('aria-hidden', 'true');
    badge.title = `${annotation.label || annotation.key || 'Move'} annotation`;
    const key = annotation.key;
    if (key === 'best' || key === 'excellent' || key === 'checkmate') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('focusable', 'false');
      if (key === 'best') {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M2 10h4v11H2zM22 11.1c0-1.1-.9-2-2-2h-6.1l.9-4.3.03-.35c0-.42-.17-.8-.45-1.08L13.3 2 6.8 8.5c-.36.36-.58.86-.58 1.4V19c0 1.1.9 2 2 2h8.8c.83 0 1.55-.51 1.86-1.25l3-7.05c.09-.22.14-.46.14-.7v-.9z');
        path.setAttribute('fill', 'currentColor'); svg.append(path);
      } else if (key === 'excellent') {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 2.4l2.93 5.94 6.56.95-4.75 4.63 1.12 6.53L12 17.37l-5.86 3.08 1.12-6.53L2.5 9.29l6.57-.95L12 2.4z');
        path.setAttribute('fill', 'currentColor'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-linejoin', 'round'); svg.append(path);
      } else {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M8 3L6 21M18 3l-2 18M3 9h18M2 15h18');
        path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2.8'); path.setAttribute('stroke-linecap', 'round'); svg.append(path);
      }
      badge.append(svg);
    } else {
      badge.textContent = annotation.mark || ({ brilliant:'!!', great:'!', good:'✓', inaccuracy:'?', mistake:'?!', blunder:'??', 'missed-win':'?!', miss:'X', book:'▤' }[key] || '·');
    }
    return badge;
  }

  #piece(color, type) {
    const img = document.createElement('img');
    img.className = 'pc';
    img.alt = '';
    img.draggable = false;
    img.src = `/pieces/${color}${String(type).toUpperCase()}.svg`;
    return img;
  }
}
