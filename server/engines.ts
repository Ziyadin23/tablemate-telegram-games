import { Chess, type Square } from 'chess.js';
import { otherSeat, type GameEngine, type GameState, type CheckersState, type CheckerPiece, type CheckersMove, type TicTacToeState, type BoardGameType, type Move, type Seat } from '../shared/types.js';

const chessHistory = new WeakMap<GameState, Chess>();
function chess(state: GameState) {
  if (state.kind !== 'chess') throw new Error('Invalid chess state');
  const cached = chessHistory.get(state);
  if (cached) return cached;
  const game = new Chess();
  for (const move of state.moves) game.move(move);
  if (game.fen() !== state.fen) throw new Error('Inconsistent chess history');
  chessHistory.set(state, game);
  return game;
}

const chessEngine: GameEngine = {
  initialize: () => ({ kind: 'chess', fen: new Chess().fen(), moves: [] }),
  turn: state => {
    if (state.kind !== 'chess') throw new Error('Invalid chess state');
    return state.fen.split(' ')[1] === 'w' ? 'first' : 'second';
  },
  legalMoves: state => {
    if (state.kind !== 'chess') throw new Error('Invalid chess state');
    return new Chess(state.fen).moves({ verbose: true }).map(m => ({ kind: 'chess', from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion as 'q' | 'r' | 'b' | 'n' } : {}) }));
  },
  applyMove(state, move) {
    if (state.kind !== 'chess' || move.kind !== 'chess') throw new Error('Invalid chess move');
    const game = chess(state);
    const played = game.move({ from: move.from as Square, to: move.to as Square, promotion: move.promotion });
    const next: GameState = { kind: 'chess', fen: game.fen(), moves: [...state.moves, played.san] };
    // Transfer the history-bearing instance. Older immutable states rebuild on demand.
    chessHistory.delete(state); chessHistory.set(next, game);
    return { state: next, label: played.san };
  },
  result(state) {
    const game = chess(state);
    if (game.isCheckmate()) return { winner: game.turn() === 'w' ? 'second' : 'first', reason: 'Checkmate' };
    if (game.isStalemate()) return { winner: null, reason: 'Stalemate' };
    if (game.isInsufficientMaterial()) return { winner: null, reason: 'Insufficient material' };
    if (game.isThreefoldRepetition()) return { winner: null, reason: 'Threefold repetition' };
    if (game.isDrawByFiftyMoves()) return { winner: null, reason: 'Fifty-move rule' };
    return null;
  },
};

function checkersState(state: GameState): CheckersState {
  if (state.kind !== 'checkers') throw new Error('Invalid checkers state');
  return state;
}
function position(board: (CheckerPiece | null)[], turn: Seat) {
  return board.map(p => p ? (p.seat === 'first' ? (p.king ? 'R' : 'r') : (p.king ? 'W' : 'w')) : '.').join('') + turn;
}
function target(index: number, dr: number, dc: number): number | null {
  const r = Math.floor(index / 8) + dr, c = index % 8 + dc;
  return r >= 0 && r < 8 && c >= 0 && c < 8 ? r * 8 + c : null;
}
const directions = (p: CheckerPiece): number[] => p.king ? [-1, 1] : [p.seat === 'first' ? 1 : -1];
const crowns = (p: CheckerPiece, index: number) => !p.king && Math.floor(index / 8) === (p.seat === 'first' ? 7 : 0);

function jumps(board: (CheckerPiece | null)[], at: number, path: number[]): number[][] {
  const piece = board[at]!;
  const sequences: number[][] = [];
  for (const dr of directions(piece)) for (const dc of [-1, 1]) {
    const over = target(at, dr, dc), end = target(at, dr * 2, dc * 2);
    if (over === null || end === null || !board[over] || board[over]!.seat === piece.seat || board[end]) continue;
    const next = board.slice(); next[at] = null; next[over] = null; next[end] = piece;
    const nextPath = [...path, end];
    // Crowning ends a man's capture turn under English rules.
    sequences.push(...(crowns(piece, end) ? [nextPath] : jumps(next, end, nextPath)));
  }
  return sequences.length ? sequences : path.length > 1 ? [path] : [];
}

const checkersEngine: GameEngine = {
  initialize() {
    const board: (CheckerPiece | null)[] = Array.from({ length: 64 }, (_, i) => {
      const row = Math.floor(i / 8);
      return (row + i % 8) % 2 === 1 && (row < 3 || row > 4) ? { seat: row < 3 ? 'first' : 'second', king: false } : null;
    });
    return { kind: 'checkers', board, turn: 'first', positions: [position(board, 'first')], quietPlies: 0 };
  },
  turn: state => checkersState(state).turn,
  legalMoves(state) {
    const { board, turn } = checkersState(state);
    const captures: CheckersMove[] = [], steps: CheckersMove[] = [];
    for (let i = 0; i < 64; i++) {
      const p = board[i]; if (!p || p.seat !== turn) continue;
      captures.push(...jumps(board, i, [i]).map(path => ({ kind: 'checkers' as const, path })));
      for (const dr of directions(p)) for (const dc of [-1, 1]) {
        const end = target(i, dr, dc);
        if (end !== null && !board[end]) steps.push({ kind: 'checkers', path: [i, end] });
      }
    }
    return captures.length ? captures : steps;
  },
  applyMove(state, move) {
    const s = checkersState(state);
    if (move.kind !== 'checkers' || !this.legalMoves(state).some(m => m.kind === 'checkers' && JSON.stringify(m.path) === JSON.stringify(move.path))) throw new Error('Illegal checkers move');
    const board = s.board.slice(), piece = { ...board[move.path[0]]! };
    let captured = false;
    for (let i = 1; i < move.path.length; i++) {
      const from = move.path[i - 1], to = move.path[i];
      board[from] = null;
      if (Math.abs(Math.floor(to / 8) - Math.floor(from / 8)) === 2) { board[(from + to) / 2] = null; captured = true; }
      board[to] = piece;
    }
    const end = move.path.at(-1)!;
    const quietPlies = captured || !piece.king ? 0 : s.quietPlies + 1;
    if (crowns(piece, end)) piece.king = true;
    const turn = otherSeat(s.turn);
    const stateOut: CheckersState = { kind: 'checkers', board, turn, quietPlies, positions: [...s.positions, position(board, turn)] };
    const label = move.path.map(i => Math.floor(i / 8) * 4 + Math.floor(i % 8 / 2) + 1).join(captured ? '×' : '–');
    return { state: stateOut, label };
  },
  result(state) {
    const s = checkersState(state);
    if (!this.legalMoves(state).length) return { winner: otherSeat(s.turn), reason: 'No legal moves' };
    const current = position(s.board, s.turn);
    if (s.positions.filter(p => p === current).length >= 3) return { winner: null, reason: 'Threefold repetition' };
    if (s.quietPlies >= 80) return { winner: null, reason: 'Forty-move rule' };
    return null;
  },
};

const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const tttState = (state: GameState): TicTacToeState => {
  if (state.kind !== 'tictactoe') throw new Error('Invalid tic-tac-toe state');
  return state;
};
const ticTacToeEngine: GameEngine = {
  initialize: () => ({ kind: 'tictactoe', board: Array(9).fill(null), turn: 'first' }),
  turn: state => tttState(state).turn,
  legalMoves(state) {
    const s = tttState(state);
    return this.result(state) ? [] : s.board.flatMap((p, cell) => p === null ? [{ kind: 'tictactoe' as const, cell }] : []);
  },
  applyMove(state, move) {
    const s = tttState(state);
    if (move.kind !== 'tictactoe' || !Number.isInteger(move.cell) || move.cell < 0 || move.cell > 8 || s.board[move.cell] || this.result(state)) throw new Error('Illegal tic-tac-toe move');
    const board = s.board.slice(); board[move.cell] = s.turn;
    return { state: { kind: 'tictactoe', board, turn: otherSeat(s.turn) }, label: `${s.turn === 'first' ? 'X' : 'O'} · ${Math.floor(move.cell / 3) + 1},${move.cell % 3 + 1}` };
  },
  result(state) {
    const { board } = tttState(state);
    for (const [a, b, c] of lines) if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], reason: 'Three in a row' };
    return board.every(Boolean) ? { winner: null, reason: 'Board is full' } : null;
  },
};

export const engines: Record<BoardGameType, GameEngine> = { chess: chessEngine, checkers: checkersEngine, tictactoe: ticTacToeEngine };
export const sameMove = (a: Move, b: Move): boolean => a.kind === b.kind && (a.kind === 'chess' && b.kind === 'chess' ? a.from === b.from && a.to === b.to && a.promotion === b.promotion : a.kind === 'checkers' && b.kind === 'checkers' ? JSON.stringify(a.path) === JSON.stringify(b.path) : a.kind === 'tictactoe' && b.kind === 'tictactoe' && a.cell === b.cell);
