import { Chess } from 'chess.js';
import type { ChessState } from '../shared/types';

export const chessMotionDuration = 280;
export type PieceTravel = { from: string; to: string; piece: string };
export type ChessMotion = { travels: PieceTravel[]; captured: { square: string; piece: string } | null };
export const squareIndex = (square: string) => (8 - Number(square[1])) * 8 + square.charCodeAt(0) - 97;
export const visualIndex = (index: number, reversed: boolean) => reversed ? 63 - index : index;

// Animate only a single confirmed move. Opening a saved game or catching up on
// several moves should show the current position immediately.
export function planChessMotion(previous: ChessState, next: ChessState): ChessMotion | null {
  if (next.moves.length !== previous.moves.length + 1 || !previous.moves.every((move, i) => next.moves[i] === move)) return null;
  try {
    const chess = new Chess(previous.fen);
    const move = chess.move(next.moves.at(-1)!);
    if (chess.fen() !== next.fen) return null;
    const symbol = (piece: string) => move.color === 'w' ? piece.toUpperCase() : piece;
    const travels: PieceTravel[] = [{ from: move.from, to: move.to, piece: symbol(move.piece) }];
    if (move.isKingsideCastle()) travels.push({ from: `h${move.from[1]}`, to: `f${move.from[1]}`, piece: symbol('r') });
    if (move.isQueensideCastle()) travels.push({ from: `a${move.from[1]}`, to: `d${move.from[1]}`, piece: symbol('r') });
    const captureSquare = move.isEnPassant() ? `${move.to[0]}${move.from[1]}` : move.to;
    const captured = move.captured ? { square: captureSquare, piece: move.color === 'w' ? move.captured : move.captured.toUpperCase() } : null;
    return { travels, captured };
  } catch { return null; }
}
