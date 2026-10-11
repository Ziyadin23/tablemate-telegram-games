export type GameType = 'chess' | 'checkers' | 'tictactoe';
export type Seat = 'first' | 'second';
export type Player = { id: string; name: string; username?: string };
export type GameResult = { winner: Seat | null; reason: string };
export type ChessMove = { kind: 'chess'; from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' };
export type CheckersMove = { kind: 'checkers'; path: number[] };
export type TicTacToeMove = { kind: 'tictactoe'; cell: number };
export type Move = ChessMove | CheckersMove | TicTacToeMove;
export type CheckerPiece = { seat: Seat; king: boolean };
export type ChessState = { kind: 'chess'; fen: string; moves: string[] };
export type CheckersState = { kind: 'checkers'; board: (CheckerPiece | null)[]; turn: Seat; positions: string[]; quietPlies: number };
export type TicTacToeState = { kind: 'tictactoe'; board: (Seat | null)[]; turn: Seat };
export type GameState = ChessState | CheckersState | TicTacToeState;
export type GameSnapshot = {
  id: string; game: GameType; status: 'waiting' | 'active' | 'finished' | 'cancelled';
  creator: Player; opponent: Player | null; state: GameState; turn: Seat;
  legalMoves: Move[]; result: GameResult | null; drawOffer: Seat | null;
  version: number; createdAt: string; updatedAt: string;
  history: { number: number; seat: Seat; label: string }[];
};
// Lobby and Telegram messages do not need boards, legal moves, or move history.
export type GameSummary = Omit<GameSnapshot, 'state' | 'legalMoves' | 'history' | 'drawOffer'>;
export type GameEngine = {
  initialize(): GameState;
  turn(state: GameState): Seat;
  legalMoves(state: GameState): Move[];
  applyMove(state: GameState, move: Move): { state: GameState; label: string };
  result(state: GameState): GameResult | null;
};
export const otherSeat = (seat: Seat): Seat => seat === 'first' ? 'second' : 'first';
export const gameNames: Record<GameType, string> = { chess: 'Chess', checkers: 'Checkers', tictactoe: 'Tic-tac-toe' };
