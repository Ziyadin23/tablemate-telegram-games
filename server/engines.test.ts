import { describe, expect, it } from 'vitest';
import { engines } from './engines.js';
import type { CheckersState, GameState, Move } from '../shared/types.js';

const play = (game: keyof typeof engines, moves: Move[]) => moves.reduce((state, move) => engines[game].applyMove(state, move).state, engines[game].initialize());
const cm = (from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n'): Move => ({ kind: 'chess', from, to, ...(promotion ? { promotion } : {}) });
function checkerFixture(pieces: [number, 'first' | 'second', boolean?][], quietPlies = 0): CheckersState {
  const board: CheckersState['board'] = Array(64).fill(null);
  for (const [i, seat, king] of pieces) board[i] = { seat, king: Boolean(king) };
  return { kind: 'checkers', board, turn: 'first', positions: [], quietPlies };
}

describe('chess rules and persistent history', () => {
  it('starts with 20 legal moves and rejects illegal moves', () => {
    const state = engines.chess.initialize(); expect(engines.chess.legalMoves(state)).toHaveLength(20);
    expect(() => engines.chess.applyMove(state, cm('e2', 'e5'))).toThrow();
  });
  it('detects Fool’s Mate after serializing and restoring the game', () => {
    const state = play('chess', [cm('f2', 'f3'), cm('e7', 'e5'), cm('g2', 'g4'), cm('d8', 'h4')]);
    expect(engines.chess.result(JSON.parse(JSON.stringify(state)))).toEqual({ winner: 'second', reason: 'Checkmate' });
  });
  it('supports castling and preserves rook movement', () => {
    const state = play('chess', [cm('e2', 'e4'), cm('e7', 'e5'), cm('g1', 'f3'), cm('b8', 'c6'), cm('f1', 'c4'), cm('g8', 'f6'), cm('e1', 'g1')]);
    expect(state.kind === 'chess' && state.moves.at(-1)).toBe('O-O');
    expect(state.kind === 'chess' && state.fen.split(' ')[0].endsWith('RNBQ1RK1')).toBe(true);
  });
  it('supports en passant', () => {
    const state = play('chess', [cm('e2', 'e4'), cm('a7', 'a6'), cm('e4', 'e5'), cm('d7', 'd5'), cm('e5', 'd6')]);
    expect(state.kind === 'chess' && state.moves.at(-1)).toBe('exd6');
  });
  it('offers four promotion choices and supports underpromotion', () => {
    let state = play('chess', [cm('a2', 'a4'), cm('h7', 'h5'), cm('a4', 'a5'), cm('h5', 'h4'), cm('a5', 'a6'), cm('h4', 'h3'), cm('a6', 'b7'), cm('h3', 'g2')]);
    expect(engines.chess.legalMoves(state).filter(m => m.kind === 'chess' && m.from === 'b7' && m.to === 'a8')).toHaveLength(4);
    state = engines.chess.applyMove(state, cm('b7', 'a8', 'n')).state;
    expect(state.kind === 'chess' && state.moves.at(-1)).toBe('bxa8=N');
  });
  it('retains threefold repetition across snapshots', () => {
    const cycle = [cm('g1', 'f3'), cm('g8', 'f6'), cm('f3', 'g1'), cm('f6', 'g8')];
    const state = play('chess', [...cycle, ...cycle]);
    expect(engines.chess.result(JSON.parse(JSON.stringify(state)))?.reason).toBe('Threefold repetition');
  });
});

describe('English checkers', () => {
  it('has twelve pieces each and seven opening moves', () => {
    const state = engines.checkers.initialize() as CheckersState;
    expect(state.board.filter(p => p?.seat === 'first')).toHaveLength(12);
    expect(state.board.filter(p => p?.seat === 'second')).toHaveLength(12);
    expect(engines.checkers.legalMoves(state)).toHaveLength(7);
  });
  it('forces a complete multi-jump instead of an available ordinary move', () => {
    const state = checkerFixture([[17, 'first'], [21, 'first'], [26, 'second'], [44, 'second']]);
    expect(engines.checkers.legalMoves(state)).toEqual([{ kind: 'checkers', path: [17, 35, 53] }]);
    expect(() => engines.checkers.applyMove(state, { kind: 'checkers', path: [17, 35] })).toThrow();
    const after = engines.checkers.applyMove(state, { kind: 'checkers', path: [17, 35, 53] }).state as CheckersState;
    expect(after.board[26]).toBeNull(); expect(after.board[44]).toBeNull(); expect(after.turn).toBe('second');
    expect(engines.checkers.result(after)?.winner).toBe('first');
  });
  it('allows a choice of capture chains rather than maximum capture', () => {
    const state = checkerFixture([[19, 'first'], [26, 'second'], [28, 'second'], [42, 'second']]);
    expect(engines.checkers.legalMoves(state)).toEqual(expect.arrayContaining([{ kind: 'checkers', path: [19, 33, 51] }, { kind: 'checkers', path: [19, 37] }]));
  });
  it('does not allow men to capture backward, but allows kings', () => {
    const state = checkerFixture([[35, 'first'], [26, 'second']]);
    expect(engines.checkers.legalMoves(state)).not.toContainEqual({ kind: 'checkers', path: [35, 17] });
    state.board[35]!.king = true;
    expect(engines.checkers.legalMoves(state)).toContainEqual({ kind: 'checkers', path: [35, 17] });
  });
  it('ends a capture when a man reaches the king row', () => {
    const state = checkerFixture([[40, 'first'], [49, 'second'], [51, 'second']]);
    expect(engines.checkers.legalMoves(state)).toEqual([{ kind: 'checkers', path: [40, 58] }]);
    const after = engines.checkers.applyMove(state, { kind: 'checkers', path: [40, 58] }).state as CheckersState;
    expect(after.board[58]?.king).toBe(true); expect(after.board[51]).not.toBeNull();
  });
  it('treats a blocked opponent as a loss', () => {
    const state = checkerFixture([[1, 'second'], [62, 'first']]);
    expect(engines.checkers.result(state)).toEqual({ winner: 'second', reason: 'No legal moves' });
  });
  it('detects forty quiet moves per player and resets the counter for a man', () => {
    const state = checkerFixture([[17, 'first', true], [46, 'second', true]], 79);
    const after = engines.checkers.applyMove(state, { kind: 'checkers', path: [17, 24] }).state;
    expect(engines.checkers.result(after)?.reason).toBe('Forty-move rule');
    const man = checkerFixture([[17, 'first'], [46, 'second', true]], 79);
    expect((engines.checkers.applyMove(man, { kind: 'checkers', path: [17, 24] }).state as CheckersState).quietPlies).toBe(0);
  });
  it('detects threefold repetition with the same player to move', () => {
    let state: GameState = checkerFixture([[1, 'first', true], [62, 'second', true]]);
    const cycle = [[1, 8], [62, 55], [8, 1], [55, 62]];
    for (const path of [...cycle, ...cycle, ...cycle]) state = engines.checkers.applyMove(state, { kind: 'checkers', path }).state;
    expect(engines.checkers.result(state)?.reason).toBe('Threefold repetition');
  });
});

describe('tic-tac-toe', () => {
  it('recognizes a winning row and prevents further play', () => {
    const state = play('tictactoe', [0, 3, 1, 4, 2].map(cell => ({ kind: 'tictactoe', cell })));
    expect(engines.tictactoe.result(state)).toEqual({ winner: 'first', reason: 'Three in a row' });
    expect(engines.tictactoe.legalMoves(state)).toEqual([]);
  });
  it('recognizes a full-board draw', () => {
    const state = play('tictactoe', [0, 1, 2, 4, 3, 5, 7, 6, 8].map(cell => ({ kind: 'tictactoe', cell })));
    expect(engines.tictactoe.result(state)?.winner).toBeNull();
  });
  it('rejects occupied or out-of-range cells', () => {
    const state = play('tictactoe', [{ kind: 'tictactoe', cell: 0 }]);
    for (const cell of [0, -1, 9, 1.5]) expect(() => engines.tictactoe.applyMove(state, { kind: 'tictactoe', cell })).toThrow();
  });
});

it('detects fifty quiet chess moves after serialization without confusing repetition or cached older states', async () => {
  const { Chess } = await import('chess.js');
  const game = new Chess(); for (const move of ['e4', 'e5', 'd4', 'd5']) game.move(move); let seed = 710;
  const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 100; i++) {
    const options = game.moves({ verbose: true }).filter(m => m.piece !== 'p' && !m.captured).filter(m => { game.move(m); const valid = !game.isThreefoldRepetition() && !game.isCheckmate() && !game.isStalemate(); game.undo(); return valid; });
    expect(options.length).toBeGreaterThan(0); game.move(options[Math.floor(rng() * options.length)]);
  }
  expect(game.isDrawByFiftyMoves()).toBe(true);
  const restored = JSON.parse(JSON.stringify({ kind: 'chess', fen: game.fen(), moves: game.history() }));
  expect(engines.chess.result(restored)?.reason).toBe('Fifty-move rule');
  const initial = engines.chess.initialize(), saved = JSON.stringify(initial);
  const next = engines.chess.applyMove(initial, cm('e2', 'e4')).state;
  expect(JSON.stringify(initial)).toBe(saved); expect(engines.chess.result(initial)).toBeNull(); expect(engines.chess.result(next)).toBeNull();
});
