import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { ChessState } from '../shared/types';
import { planChessMotion, squareIndex, visualIndex } from './chessMotion';

function position(moves: string[] = [], fen?: string): ChessState {
  const chess = new Chess(fen);
  for (const move of moves) chess.move(move);
  return { kind: 'chess', fen: chess.fen(), moves: chess.history() };
}
function next(previous: ChessState, san: string): ChessState {
  const chess = new Chess(previous.fen), move = chess.move(san);
  return { kind: 'chess', fen: chess.fen(), moves: [...previous.moves, move.san] };
}

describe('confirmed chess movement', () => {
  it('moves a pawn and a knight without confusing identical pieces', () => {
    const start = position();
    expect(planChessMotion(start, next(start, 'e4'))).toEqual({ travels: [{ from: 'e2', to: 'e4', piece: 'P' }], captured: null });
    const whiteMoved = next(start, 'e4');
    expect(planChessMotion(whiteMoved, next(whiteMoved, 'Nf6'))).toEqual({ travels: [{ from: 'g8', to: 'f6', piece: 'n' }], captured: null });
  });
  it('keeps the captured piece separate from the moving piece', () => {
    const before = position(['e4', 'd5']);
    expect(planChessMotion(before, next(before, 'exd5'))).toEqual({ travels: [{ from: 'e4', to: 'd5', piece: 'P' }], captured: { square: 'd5', piece: 'p' } });
    const black = position(['e4', 'd5', 'Nc3']);
    expect(planChessMotion(black, next(black, 'dxe4'))?.captured).toEqual({ square: 'e4', piece: 'P' });
  });
  it.each([
    ['w', 'O-O', 'e1', 'g1', 'h1', 'f1', 'K', 'R'],
    ['w', 'O-O-O', 'e1', 'c1', 'a1', 'd1', 'K', 'R'],
    ['b', 'O-O', 'e8', 'g8', 'h8', 'f8', 'k', 'r'],
    ['b', 'O-O-O', 'e8', 'c8', 'a8', 'd8', 'k', 'r'],
  ])('moves both pieces when %s plays %s', (color, san, from, to, rookFrom, rookTo, king, rook) => {
    const before = position([], `r3k2r/8/8/8/8/8/8/R3K2R ${color} KQkq - 0 1`);
    expect(planChessMotion(before, next(before, san))).toEqual({ travels: [{ from, to, piece: king }, { from: rookFrom, to: rookTo, piece: rook }], captured: null });
  });
  it.each([
    ['4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'exd6', 'd5', 'p'],
    ['4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1', 'exd3', 'd4', 'P'],
  ])('fades the correct pawn for en passant', (fen, san, square, piece) => {
    const before = position([], fen);
    expect(planChessMotion(before, next(before, san))?.captured).toEqual({ square, piece });
  });
  it.each([
    ['4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a8=Q', 'a7', 'a8', 'P'],
    ['4k3/8/8/8/8/8/p7/4K3 b - - 0 1', 'a1=N', 'a2', 'a1', 'p'],
  ])('moves the pawn before showing its promoted piece', (fen, san, from, to, piece) => {
    const before = position([], fen);
    expect(planChessMotion(before, next(before, san))?.travels).toEqual([{ from, to, piece }]);
  });
  it('does not replay duplicate positions, skipped moves, unrelated histories, or invalid snapshots', () => {
    const start = position(), e4 = next(start, 'e4');
    expect(planChessMotion(e4, e4)).toBeNull();
    expect(planChessMotion(start, position(['e4', 'e5']))).toBeNull();
    expect(planChessMotion(e4, { ...position(['e4', 'e5']), moves: ['d4', 'e5'] })).toBeNull();
    expect(planChessMotion(start, { ...e4, fen: start.fen })).toBeNull();
    expect(planChessMotion(start, { ...e4, moves: ['invalid'] })).toBeNull();
  });
  it('maps both board orientations to the same chess squares', () => {
    expect(squareIndex('a8')).toBe(0); expect(squareIndex('h1')).toBe(63);
    expect(visualIndex(squareIndex('e2'), false)).toBe(52);
    expect(visualIndex(squareIndex('e2'), true)).toBe(11);
    expect(visualIndex(squareIndex('e4'), true)).toBe(27);
  });
});
