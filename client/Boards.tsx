import { useModal } from './useModal';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ChessMove, ChessState, GameSnapshot, Move, Seat, CheckerPiece } from '../shared/types';
import { chessMotionDuration, planChessMotion, squareIndex, visualIndex, type ChessMotion } from './chessMotion';

const chessSymbols: Record<string, string> = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const pieceNames: Record<string, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const indices = Array.from({ length: 64 }, (_, i) => i);
const square = (index: number) => `${String.fromCharCode(97 + index % 8)}${8 - Math.floor(index / 8)}`;
function chessBoard(fen: string): (string | null)[] {
  return fen.split(' ')[0].split('/').flatMap(row => [...row].flatMap(c => /\d/.test(c) ? Array(Number(c)).fill(null) : [c]));
}
type BoardProps = { match: GameSnapshot; seat: Seat | null; enabled: boolean; play(move: Move): void };
type MotionStyle = CSSProperties & { '--move-x'?: string; '--move-y'?: string; '--move-duration'?: string };

function piecePosition(square: string, reversed: boolean): MotionStyle {
  const index = visualIndex(squareIndex(square), reversed);
  return { left: `${index % 8 * 12.5}%`, top: `${Math.floor(index / 8) * 12.5}%` };
}
function Piece({ symbol }: { symbol: string }) {
  return <span aria-hidden="true" className={`chess-piece ${symbol === symbol.toUpperCase() ? 'white-piece' : 'black-piece'}`}>{chessSymbols[symbol]}</span>;
}
function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    change(); query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

export function Board(props: BoardProps) {
  if (props.match.game === 'chess') return <ChessBoard {...props} />;
  if (props.match.game === 'checkers') return <CheckersBoard {...props} />;
  return <TicTacToeBoard {...props} />;
}
function ChessBoard({ match, seat, enabled, play }: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null), [promotion, setPromotion] = useState<ChessMove[]>([]);
  const [motion, setMotion] = useState<(ChessMotion & { key: number }) | null>(null), [lastMove, setLastMove] = useState<string[]>([]);
  const previous = useRef<{ id: string; seat: Seat | null; state: ChessState } | null>(null), sequence = useRef(0);
  const reduced = useReducedMotion(), state = match.state.kind === 'chess' ? match.state : null;
  useLayoutEffect(() => {
    if (!state) return;
    const before = previous.current;
    previous.current = { id: match.id, seat, state };
    if (reduced) setMotion(null);
    if (!before || before.id !== match.id || before.seat !== seat) { setMotion(null); setLastMove([]); return; }
    if (before.state.fen === state.fen) return;
    const plan = planChessMotion(before.state, state);
    setLastMove(plan ? [plan.travels[0].from, plan.travels[0].to] : []);
    setMotion(plan && !reduced ? { ...plan, key: ++sequence.current } : null);
  }, [match.id, state, seat, reduced]);
  useEffect(() => {
    if (!motion) return;
    const timer = setTimeout(() => setMotion(current => current?.key === motion.key ? null : current), chessMotionDuration + 80);
    return () => clearTimeout(timer);
  }, [motion]);
  useEffect(() => { setSelected(null); setPromotion([]); }, [match.id, match.version, seat]);
  useModal(promotion.length > 0, '.promotion', () => setPromotion([]));
  useEffect(() => { if (!enabled) setPromotion([]); }, [enabled]);
  if (!state) return null;
  const board = chessBoard(state.fen), moves = match.legalMoves.filter((m): m is ChessMove => m.kind === 'chess');
  const reversed = seat === 'second', order = reversed ? [...indices].reverse() : indices;
  const interactive = enabled && !motion;
  const finishMotion = () => setMotion(current => current?.key === motion?.key ? null : current);
  function click(index: number) {
    if (!interactive || promotion.length) return;
    const at = square(index), options = moves.filter(m => m.from === selected && m.to === at);
    if (options.length > 1) { setPromotion(options.sort((a, b) => 'qrbn'.indexOf(a.promotion!) - 'qrbn'.indexOf(b.promotion!))); return; }
    if (options.length === 1) { play(options[0]); setSelected(null); return; }
    setSelected(selected === at ? null : moves.some(m => m.from === at) ? at : null);
  }
  return <div className="board-wrap">
    <div className="board chess-board" role="group" aria-label="Chess board">
      {order.map((i, visual) => {
        const piece = board[i], at = square(i), valid = Boolean(selected && moves.some(m => m.from === selected && m.to === at));
        const white = piece && piece === piece.toUpperCase();
        return <button type="button" key={at} data-square={at} className={`square ${(Math.floor(i / 8) + i % 8) % 2 ? 'dark' : 'light'} ${lastMove.includes(at) ? 'last-move' : ''} ${selected === at ? 'selected' : ''} ${valid ? 'legal' : ''} ${motion?.travels.some(travel => travel.to === at) ? 'moving-target' : ''} ${piece ? 'occupied' : ''}`} aria-label={`${at}${piece ? ` ${white ? 'white' : 'black'} ${pieceNames[piece.toLowerCase()]}` : ''}${valid ? ' legal move' : ''}`} aria-pressed={selected === at} onClick={() => click(i)} disabled={!interactive}>
          {piece && <Piece symbol={piece} />}
          {visual % 8 === 0 && <span className="rank">{at[1]}</span>}
          {visual >= 56 && <span className="file">{at[0]}</span>}
        </button>;
      })}
    </div>
    {motion && <div key={motion.key} className="piece-motion-layer" aria-hidden="true" style={{ '--move-duration': `${chessMotionDuration}ms` } as MotionStyle}>
      {motion.captured && <div className="captured-piece" data-square={motion.captured.square} style={piecePosition(motion.captured.square, reversed)}><Piece symbol={motion.captured.piece} /></div>}
      {motion.travels.map((travel, i) => {
        const from = visualIndex(squareIndex(travel.from), reversed), to = visualIndex(squareIndex(travel.to), reversed);
        const style: MotionStyle = { ...piecePosition(travel.to, reversed), '--move-x': `${(from % 8 - to % 8) * 100}%`, '--move-y': `${(Math.floor(from / 8) - Math.floor(to / 8)) * 100}%` };
        return <div key={travel.from} className="moving-piece" data-from={travel.from} data-to={travel.to} style={style} onAnimationEnd={i === 0 ? finishMotion : undefined}><Piece symbol={travel.piece} /></div>;
      })}
    </div>}
    {promotion.length > 0 && <div className="promotion" role="dialog" aria-label="Choose promotion piece" aria-modal="true"><p>Choose your promotion</p><div>{promotion.map(move => <button key={move.promotion} aria-label={`Promote to ${pieceNames[move.promotion!]}`} disabled={!enabled} onClick={() => { if (enabled) play(move); setPromotion([]); }}>{chessSymbols[seat === 'second' ? move.promotion! : move.promotion!.toUpperCase()]}</button>)}</div><button className="text-button" onClick={() => setPromotion([])}>Cancel</button></div>}
  </div>;
}
function CheckersBoard({ match, seat, enabled, play }: BoardProps) {
  const [path, setPath] = useState<number[]>([]);
  useEffect(() => { setPath([]); }, [match.id, match.version, seat]);
  if (match.state.kind !== 'checkers') return null;
  const moves = match.legalMoves.filter(m => m.kind === 'checkers');
  const possible = moves.filter(m => path.every((p, i) => p === m.path[i]));
  const board: (CheckerPiece | null)[] = match.state.board.slice();
  if (path.length > 1) {
    const p = board[path[0]];
    for (let i = 1; i < path.length; i++) { board[path[i - 1]] = null; if (Math.abs(path[i] - path[i - 1]) > 9) board[(path[i] + path[i - 1]) / 2] = null; }
    board[path.at(-1)!] = p;
  }
  function click(at: number) {
    if (!enabled) return;
    if (path.length && possible.some(m => m.path[path.length] === at)) {
      const next = [...path, at], complete = possible.find(m => JSON.stringify(m.path) === JSON.stringify(next));
      if (complete) { play(complete); setPath([]); } else setPath(next);
    } else if (path.length <= 1) setPath(path[0] === at ? [] : moves.some(m => m.path[0] === at) ? [at] : []);
  }
  const order = seat === 'second' ? indices : [...indices].reverse();
  return <div className="board-wrap"><div className="board checkers-board" role="group" aria-label="Checkers board">
    {order.map(i => {
      const p = board[i], valid = path.length > 0 && possible.some(m => m.path[path.length] === i);
      return <button key={i} type="button" className={`square ${(Math.floor(i / 8) + i % 8) % 2 ? 'dark' : 'light'} ${path.at(-1) === i ? 'selected' : ''} ${valid ? 'legal' : ''}`} aria-label={`Square ${i}${p ? ` ${p.seat === 'first' ? 'red' : 'white'} ${p.king ? 'king' : 'checker'}` : ''}${valid ? ' legal move' : ''}`} onClick={() => click(i)} disabled={!enabled}>
        {p && <span className={`checker ${p.seat === 'first' ? 'red-checker' : 'white-checker'}`}>{p.king ? '♛' : ''}</span>}
      </button>;
    })}
  </div>{path.length > 1 && <div className="capture-hint">Finish your capture <button className="text-button" onClick={() => setPath([])}>Reset selection</button></div>}</div>;
}
function TicTacToeBoard({ match, enabled, play }: BoardProps) {
  if (match.state.kind !== 'tictactoe') return null;
  return <div className="board-wrap ttt-wrap"><div className="ttt-board" role="group" aria-label="Tic-tac-toe board">{match.state.board.map((mark, cell) => <button type="button" className={`ttt-cell ${mark || ''}`} key={cell} aria-label={`Cell ${cell + 1}${mark ? ` ${mark === 'first' ? 'X' : 'O'}` : ' empty'}`} disabled={!enabled || Boolean(mark)} onClick={() => play({ kind: 'tictactoe', cell })}>{mark === 'first' ? <span>×</span> : mark === 'second' ? <span>○</span> : null}</button>)}</div></div>;
}
