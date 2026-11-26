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
    this.dragPosition = null;
    this.pointerState = null;
    this.suppressPointerClick = false;
    this.handoffTimer = null;
    this.dragLayer = document.createElement('div');
    this.dragLayer.className = 'zz-drag-piece';
    this.dragLayer.setAttribute('aria-hidden', 'true');

    // Pointer events support mouse, pen and touch. Click and keyboard selection remain
    // available as accessible alternatives.
    this.root.addEventListener('pointerdown', (event) => this.#pointerDown(event));
    this.root.addEventListener('pointermove', (event) => this.#pointerMove(event));
    this.root.addEventListener('pointerup', (event) => this.#pointerUp(event));
    this.root.addEventListener('pointercancel', () => this.#clearPointer());
    this.root.addEventListener('click', (event) => {
      if (this.suppressPointerClick) {
        this.suppressPointerClick = false;
        event.preventDefault(); event.stopPropagation(); return;
      }
      const square = event.target.closest?.('.sq[data-sq]');
      if (square && this.root.contains(square)) this.onSquare(square.dataset.sq);
    });
    this.root.addEventListener('keydown', (event) => {
      this.suppressPointerClick = false;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const square = event.target.closest?.('.sq[data-sq]');
      if (square && this.root.contains(square)) {
        event.preventDefault(); this.onSquare(square.dataset.sq);
      }
    });
  }

  #pieceAt(position, square) {
    if (!Array.isArray(position) || !/^[a-h][1-8]$/.test(square || '')) return null;
    return position[8 - Number(square[1])]?.[FILES.indexOf(square[0])] || null;
  }

  // Expose the source square during an in-progress drag so a turn update can
  // convert a premove drag into a normal move without making the player start over.
  getActiveDragSource() {
    return this.pointerState?.from || null;
  }

  pulseTurnHandoff() {
    this.root.classList.remove('zz-turn-handoff');
    void this.root.offsetWidth;
    this.root.classList.add('zz-turn-handoff');
    if (this.handoffTimer) clearTimeout(this.handoffTimer);
    this.handoffTimer = setTimeout(() => {
      this.root.classList.remove('zz-turn-handoff');
      this.handoffTimer = null;
    }, 520);
  }

  #pointerDown(event) {
    this.suppressPointerClick = false;
    if (this.interactive === false) return;
    if (event.button != null && event.button !== 0) return;
    if (this.pointerState) return;
    const square = event.target.closest?.('.sq[data-sq]');
    if (!square || !this.root.contains(square)) return;
    const piece = this.#pieceAt(this.dragPosition, square.dataset.sq);
    if (!piece) return;
    this.pointerState = {
      id:event.pointerId, from:square.dataset.sq, piece,
      startX:event.clientX, startY:event.clientY, didDrag:false
    };
    try { this.root.setPointerCapture(event.pointerId); } catch { /* Pointer capture may be unavailable in older browsers. */ }
    event.preventDefault();
  }

  #pointerMove(event) {
    const drag = this.pointerState;
    if (!drag || drag.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.didDrag && distance < 6) return;
    if (!drag.didDrag) {
      drag.didDrag = true;
      this.onSquare(drag.from);
    }
    this.#updateDragLayer(event.clientX, event.clientY);
    event.preventDefault();
  }

  #pointerUp(event) {
    const drag = this.pointerState;
    if (!drag || drag.id !== event.pointerId) return;
    if (drag.didDrag) {
      const destination = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('.sq[data-sq]');
      if (destination && this.root.contains(destination) && destination.dataset.sq !== drag.from) {
        this.onSquare(destination.dataset.sq);
      }
    } else {
      // Treat a short pointer press as a normal piece selection. Suppress the synthetic
      // click fired by the browser after pointerup to avoid double-selecting/toggling.
      this.onSquare(drag.from);
    }
    this.suppressPointerClick = true;
    this.#clearPointer();
    event.preventDefault();
  }

  #clearPointer() {
    this.pointerState = null;
    this.dragLayer.style.display = 'none';
    this.dragLayer.dataset.piece = '';
    this.root.querySelectorAll('.sq.drag-origin').forEach((square) => square.classList.remove('drag-origin'));
  }

  #updateDragLayer(clientX, clientY) {
    const drag = this.pointerState;
    if (!drag?.didDrag) return;
    const rect = this.root.getBoundingClientRect();
    const size = rect.width / 8;
    if (!this.dragLayer.firstChild || this.dragLayer.dataset.piece !== `${drag.piece.color}${drag.piece.type}`) {
      this.dragLayer.replaceChildren(this.#piece(drag.piece.color, drag.piece.type));
      this.dragLayer.dataset.piece = `${drag.piece.color}${drag.piece.type}`;
    }
    this.dragLayer.style.display = 'block';
    this.dragLayer.style.left = `${clientX - rect.left}px`;
    this.dragLayer.style.top = `${clientY - rect.top}px`;
    this.dragLayer.style.width = `${size}px`;
    this.dragLayer.style.height = `${size}px`;
    const origin = this.root.querySelector(`.sq[data-sq="${drag.from}"]`);
    origin?.classList.add('drag-origin');
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
    premovePosition = null,
    dragPosition = null,
    interactive = true
  } = {}) {
    if (!Array.isArray(position) || position.length !== 8) {
      throw new TypeError('Board position must be the 8×8 array returned by chess.board().');
    }

    const flip = orientation === 'black';
    this.interactive = interactive;
    const targetSet = new Set(targets || []);
    const lastSet = new Set(lastMove || []);
    this.dragPosition = dragPosition || premovePosition || position;
    const frag = document.createDocumentFragment();

    for (let displayRow = 0; displayRow < 8; displayRow++) {
      for (let displayCol = 0; displayCol < 8; displayCol++) {
        const row = flip ? 7 - displayRow : displayRow;
        const col = flip ? 7 - displayCol : displayCol;
        const square = FILES[col] + (8 - row);
        const piece = position[row][col];
        const projectedPiece = premovePosition ? premovePosition[row]?.[col] || null : piece;
        const changedByPremove = !!premovePosition && (
          (piece?.color || null) !== (projectedPiece?.color || null) ||
          (piece?.type || null) !== (projectedPiece?.type || null)
        );
        const el = document.createElement('div');
        el.className = 'sq ' + ((row + col) % 2 ? 'd' : 'l');
        el.dataset.sq = square;
        el.tabIndex = interactive ? 0 : -1;
        el.setAttribute('role', 'gridcell');
        el.setAttribute('aria-label', square + (piece ? ` ${piece.color === 'w' ? 'White' : 'Black'} ${piece.type}` : ' empty'));
        if (piece || projectedPiece) el.classList.add('has-piece');

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

        if (changedByPremove) {
          el.classList.add(projectedPiece ? 'pre-projection-to' : 'pre-projection-from');
          if (projectedPiece) {
            const ghost = this.#piece(projectedPiece.color, projectedPiece.type);
            ghost.classList.add('ghost', 'pre-projection-piece');
            el.appendChild(ghost);
          }
        } else if (premove?.to === square && premove.from) {
          const mover = this.#pieceAt(position, premove.from);
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

        if (!interactive) {
          el.tabIndex = -1;
          el.setAttribute('aria-disabled', 'true');
        }
        frag.appendChild(el);
      }
    }
    this.root.replaceChildren(frag);
    if (solutionArrow?.from && solutionArrow?.to) this.#appendSolutionArrow(solutionArrow, flip);
    this.root.appendChild(this.dragLayer);
    if (this.pointerState?.didDrag) {
      const origin = this.root.querySelector(`.sq[data-sq="${this.pointerState.from}"]`);
      origin?.classList.add('drag-origin');
    }
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
    marker.setAttribute('refX', '8'); marker.setAttribute('refY', '5'); marker.setAttribute('markerWidth', '4.5');
    marker.setAttribute('markerHeight', '4.5'); marker.setAttribute('orient', 'auto-start-reverse');
    const head = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    head.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z'); head.setAttribute('fill', '#ffe16b');
    marker.appendChild(head); defs.appendChild(marker); svg.appendChild(defs);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(a.x)); line.setAttribute('y1', String(a.y));
    line.setAttribute('x2', String(b.x)); line.setAttribute('y2', String(b.y));
    line.setAttribute('stroke', '#ffe16b'); line.setAttribute('stroke-width', '9');
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
