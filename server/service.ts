import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { engines, sameMove } from './engines.js';
import { AppError } from './auth.js';
import { otherSeat, type GameType, type Player, type GameState, type GameSnapshot, type GameSummary, type GameResult, type Move, type Seat } from '../shared/types.js';

type MatchRow = { id: string; game: GameType; creator_id: string; opponent_id: string | null; status: GameSnapshot['status']; state: string; result: string | null; draw_offer: Seat | null; version: number; published: number; created_at: string; updated_at: string };
export type Action = { actionId: string; version: number } & ({ kind: 'join' | 'resign' | 'cancel' | 'offer-draw' | 'accept-draw' | 'decline-draw' } | { kind: 'move'; move: Move });
export type MessageRef = { ref: string; match_id: string; chat_id: string | null; message_id: number | null; inline_message_id: string | null; attempts: number; next_attempt_at: number };

export class GameService {
  private listeners = new Set<(match: GameSnapshot) => void>();
  constructor(public db: Database.Database) {}
  onChange(fn: (match: GameSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(match: GameSnapshot) { for (const fn of this.listeners) fn(match); }
  upsertPlayer(p: Player) {
    this.db.prepare('INSERT INTO players(id,name,username) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username').run(p.id, p.name, p.username ?? null);
  }
  player(id: string): Player {
    const p = this.db.prepare('SELECT * FROM players WHERE id=?').get(id) as { id: string; name: string; username: string | null } | undefined;
    if (!p) throw new AppError(401, 'Unknown player');
    return { id: p.id, name: p.name, ...(p.username ? { username: p.username } : {}) };
  }
  private row(id: string): MatchRow {
    const row = this.db.prepare('SELECT * FROM matches WHERE id=?').get(id) as MatchRow | undefined;
    if (!row) throw new AppError(404, 'Game not found.');
    return row;
  }
  get(id: string): GameSnapshot {
    const r = this.row(id), state: GameState = JSON.parse(r.state), engine = engines[r.game];
    return {
      id, game: r.game, status: r.status, creator: this.player(r.creator_id), opponent: r.opponent_id ? this.player(r.opponent_id) : null,
      state, turn: engine.turn(state), legalMoves: r.status === 'active' ? engine.legalMoves(state) : [],
      result: r.result ? JSON.parse(r.result) : null, drawOffer: r.draw_offer, version: r.version,
      createdAt: r.created_at, updatedAt: r.updated_at,
      history: this.db.prepare('SELECT number,seat,label FROM moves WHERE match_id=? ORDER BY number').all(id) as GameSnapshot['history'],
    };
  }
  create(game: GameType, creatorId: string, published = true, requestId?: string): GameSnapshot {
    return this.db.transaction(() => {
      this.player(creatorId);
      if (requestId) {
        const prior = this.db.prepare('SELECT game,match_id FROM creations WHERE player_id=? AND request_id=?').get(creatorId, requestId) as { game: GameType; match_id: string } | undefined;
        if (prior) {
          if (prior.game !== game) throw new AppError(409, 'This creation request ID was already used');
          return this.get(prior.match_id);
        }
      }
      const id = randomBytes(12).toString('base64url'), now = new Date().toISOString();
      this.db.prepare('INSERT INTO matches(id,game,creator_id,status,state,published,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, game, creatorId, 'waiting', JSON.stringify(engines[game].initialize()), Number(published), now, now);
      if (requestId) this.db.prepare('INSERT INTO creations(player_id,request_id,game,match_id) VALUES(?,?,?,?)').run(creatorId, requestId, game, id);
      return this.get(id);
    })();
  }
  publish(id: string) { this.row(id); this.db.prepare('UPDATE matches SET published=1 WHERE id=?').run(id); return this.get(id); }
  creation(playerId: string, requestId: string) {
    const row = this.db.prepare('SELECT match_id FROM creations WHERE player_id=? AND request_id=?').get(playerId, requestId) as { match_id: string } | undefined;
    if (!row) throw new AppError(404, 'Creation has not been saved yet');
    return this.get(row.match_id);
  }
  open(id: string, playerId: string) {
    let changed = false;
    const match = this.db.transaction(() => {
      this.player(playerId);
      const r = this.row(id);
      if (r.status === 'waiting' && !r.opponent_id && r.creator_id !== playerId) {
        this.db.prepare("UPDATE matches SET opponent_id=?,status='active',version=version+1,published=1,updated_at=? WHERE id=?").run(playerId, new Date().toISOString(), id);
        this.db.prepare('UPDATE message_refs SET pending=1 WHERE match_id=?').run(id);
        changed = true;
      } else this.db.prepare('UPDATE matches SET published=1 WHERE id=?').run(id);
      return this.get(id);
    })();
    if (changed) this.emit(match);
    return match;
  }
  private summaries(where: string, params: string[]): GameSummary[] {
    // Extract only the side to move from storage; never replay chess or read moves here.
    const rows = this.db.prepare(`SELECT m.id,m.game,m.status,m.result,m.version,m.created_at,m.updated_at,
      c.id AS creator_id,c.name AS creator_name,c.username AS creator_username,
      o.id AS opponent_id,o.name AS opponent_name,o.username AS opponent_username,
      CASE WHEN m.game='chess' THEN CASE WHEN json_extract(m.state,'$.fen') LIKE '% w %' THEN 'first' ELSE 'second' END
        ELSE json_extract(m.state,'$.turn') END AS turn
      FROM matches m JOIN players c ON c.id=m.creator_id LEFT JOIN players o ON o.id=m.opponent_id
      WHERE ${where} ORDER BY m.updated_at DESC,m.id LIMIT 100`).all(...params) as (MatchRow & { creator_name: string; creator_username: string | null; opponent_name: string; opponent_username: string | null; turn: Seat })[];
    return rows.map(r => ({
      id: r.id, game: r.game, status: r.status, version: r.version, turn: r.turn,
      creator: { id: r.creator_id, name: r.creator_name, ...(r.creator_username ? { username: r.creator_username } : {}) },
      opponent: r.opponent_id ? { id: r.opponent_id, name: r.opponent_name, ...(r.opponent_username ? { username: r.opponent_username } : {}) } : null,
      result: r.result ? JSON.parse(r.result) : null, createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  }
  summary(id: string): GameSummary {
    const result = this.summaries('m.id=?', [id])[0];
    if (!result) throw new AppError(404, 'Game not found.');
    return result;
  }
  list(playerId: string): GameSummary[] {
    return this.summaries('m.published=1 AND (m.creator_id=? OR m.opponent_id=?)', [playerId, playerId]);
  }
  act(id: string, playerId: string, action: Action): GameSnapshot {
    let changed = false;
    const match = this.db.transaction(() => {
      const r = this.row(id);
      const { actionId, version, ...payload } = action;
      const fingerprint = JSON.stringify(payload);
      const prior = this.db.prepare('SELECT player_id,payload FROM actions WHERE match_id=? AND action_id=?').get(id, actionId) as { player_id: string; payload: string } | undefined;
      if (prior) {
        if (prior.player_id !== playerId || prior.payload !== fingerprint) throw new AppError(409, 'This action ID was already used');
        return this.get(id);
      }
      if (r.version !== version) throw new AppError(409, 'The game changed. Your board has been refreshed; try again.');
      const seat: Seat | null = playerId === r.creator_id ? 'first' : playerId === r.opponent_id ? 'second' : null;
      let state: GameState = JSON.parse(r.state), status = r.status, result: GameResult | null = r.result ? JSON.parse(r.result) : null;
      let opponentId = r.opponent_id, drawOffer = r.draw_offer;
      if (action.kind === 'join') {
        if (seat) return this.get(id);
        if (status !== 'waiting' || opponentId) throw new AppError(409, 'Both seats are taken. You can watch this game.');
        this.player(playerId); opponentId = playerId; status = 'active';
      } else {
        if (!seat) throw new AppError(403, 'Only the players can change this game');
        if (action.kind === 'cancel') {
          if (seat !== 'first' || status !== 'waiting') throw new AppError(409, 'Only a waiting game can be cancelled');
          status = 'cancelled';
        } else {
          if (status !== 'active') throw new AppError(409, 'This game is not in progress');
          if (action.kind === 'move') {
            const engine = engines[r.game];
            if (engine.turn(state) !== seat) throw new AppError(403, 'Wait for your turn');
            if (!engine.legalMoves(state).some(m => sameMove(m, action.move))) throw new AppError(400, 'That move is not legal');
            const applied = engine.applyMove(state, action.move); state = applied.state;
            const count = (this.db.prepare('SELECT COUNT(*) AS n FROM moves WHERE match_id=?').get(id) as { n: number }).n;
            this.db.prepare('INSERT INTO moves(match_id,number,seat,label,move) VALUES(?,?,?,?,?)').run(id, count + 1, seat, applied.label, JSON.stringify(action.move));
            result = engine.result(state); if (result) status = 'finished';
            if (drawOffer !== seat || result) drawOffer = null;
          } else if (action.kind === 'resign') {
            result = { winner: otherSeat(seat), reason: 'Resignation' }; status = 'finished'; drawOffer = null;
          } else {
            if (r.game === 'tictactoe') throw new AppError(400, 'Draw offers are available in chess and checkers');
            if (action.kind === 'offer-draw') {
              if (drawOffer) throw new AppError(409, 'A draw offer is already pending');
              drawOffer = seat;
            } else if (action.kind === 'accept-draw') {
              if (!drawOffer || drawOffer === seat) throw new AppError(409, 'There is no opponent draw offer');
              result = { winner: null, reason: 'Draw by agreement' }; status = 'finished'; drawOffer = null;
            } else if (action.kind === 'decline-draw') {
              if (!drawOffer || drawOffer === seat) throw new AppError(409, 'There is no opponent draw offer');
              drawOffer = null;
            }
          }
        }
      }
      this.db.prepare('UPDATE matches SET opponent_id=?,status=?,state=?,result=?,draw_offer=?,version=version+1,published=1,updated_at=? WHERE id=?').run(opponentId, status, JSON.stringify(state), result ? JSON.stringify(result) : null, drawOffer, new Date().toISOString(), id);
      this.db.prepare('INSERT INTO actions(match_id,action_id,player_id,kind,payload) VALUES(?,?,?,?,?)').run(id, actionId, playerId, action.kind, fingerprint);
      if (status !== r.status) this.db.prepare('UPDATE message_refs SET pending=1 WHERE match_id=?').run(id);
      changed = true;
      return this.get(id);
    })();
    if (changed) this.emit(match);
    return match;
  }
  addMessageRef(id: string, ref: { chatId: string; messageId: number } | { inlineMessageId: string }) {
    this.publish(id);
    const inline = 'inlineMessageId' in ref;
    const key = inline ? ref.inlineMessageId : `${ref.chatId}:${ref.messageId}`;
    this.db.prepare('INSERT OR IGNORE INTO message_refs(ref,match_id,chat_id,message_id,inline_message_id) VALUES(?,?,?,?,?)').run(key, id, inline ? null : ref.chatId, inline ? null : ref.messageId, inline ? ref.inlineMessageId : null);
  }
  hasMessageRef(chatId: string, messageId: number) { return Boolean(this.db.prepare('SELECT 1 FROM message_refs WHERE ref=?').get(`${chatId}:${messageId}`)); }
  pendingMessages(now = Date.now()): MessageRef[] { return this.db.prepare('SELECT * FROM message_refs WHERE pending=1 AND next_attempt_at<=? ORDER BY next_attempt_at,ref LIMIT 50').all(now) as MessageRef[]; }
  messageDeferred(ref: string, attempts: number, until: number) { this.db.prepare('UPDATE message_refs SET attempts=?,next_attempt_at=? WHERE ref=?').run(attempts, until, ref); }
  telegramCooldown() { return (this.db.prepare("SELECT until FROM worker_state WHERE key='telegram'").get() as { until: number } | undefined)?.until ?? 0; }
  deferTelegram(until: number) { this.db.prepare("INSERT INTO worker_state(key,until) VALUES('telegram',?) ON CONFLICT(key) DO UPDATE SET until=MAX(until,excluded.until)").run(until); }
  messageUpdated(ref: string) { this.db.prepare('UPDATE message_refs SET pending=0,attempts=0,next_attempt_at=0 WHERE ref=?').run(ref); }
  clearOldDrafts() { this.db.prepare("DELETE FROM matches WHERE published=0 AND julianday(created_at) < julianday('now','-1 day')").run(); }
}
