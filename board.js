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
        if (targetSet.has(square)) {
          el.classList.add('target');
          if (piece) el.classList.add('cap');
          if (premoveTargets) el.classList.add('pre');
        }
        if (premove?.from === square) el.classList.add('pre-from');
        if (premove?.to === square) el.classList.add('pre-to');
        if (inCheck && piece?.type === 'k' && piece.color === turn) el.classList.add('chk');
        if (piece) el.appendChild(this.#piece(piece.color, piece.type));

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
