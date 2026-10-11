import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { engines, sameMove } from './engines.js';
import { AppError } from './auth.js';
import { createMafia, joinMafia, startMafia, playMafia, leaveMafia, advanceMafia, mafiaView, mafiaTargets, mafiaResult, type MafiaState } from './mafia.js';
import { otherSeat, WAITING_TIMEOUT_MS, MAFIA_MIN_PLAYERS, MAFIA_MAX_PLAYERS, type GameType, type Player, type GameState, type GameSnapshot, type GameSummary, type GameResult, type Move, type Seat, type MafiaPhase } from '../shared/types.js';

type MatchRow = { id: string; game: GameType; creator_id: string; opponent_id: string | null; status: GameSnapshot['status']; state: string; result: string | null; draw_offer: Seat | null; version: number; published: number; created_at: string; updated_at: string; waiting_expires_at: string | null };
export type Action = { actionId: string; version: number } & ({ kind: 'join' | 'start' | 'leave' | 'resign' | 'cancel' | 'offer-draw' | 'accept-draw' | 'decline-draw' } | { kind: 'move'; move: Move });
export type MessageRef = { ref: string; match_id: string; chat_id: string | null; message_id: number | null; inline_message_id: string | null; attempts: number; next_attempt_at: number };

export class GameService {
  private listeners = new Set<(match: GameSnapshot) => void>();
  constructor(public db: Database.Database) {}
  onChange(fn: (match: GameSnapshot) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(match: GameSnapshot) {
    const publicMatch = match.game === 'mafia' ? this.snapshot(this.row(match.id)) : match;
    for (const fn of this.listeners) fn(publicMatch);
  }
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
  get(id: string, viewerId?: string): GameSnapshot {
    this.expireWaitingGames(Date.now(), id);
    this.advanceMafiaGames(Date.now(), id);
    return this.snapshot(this.row(id), viewerId);
  }
  private snapshot(r: MatchRow, viewerId?: string): GameSnapshot {
    if (r.game === 'mafia') {
      const state: MafiaState = JSON.parse(r.state), view = mafiaView(state, id => this.player(id), viewerId);
      return {
        id: r.id, game: 'mafia', status: r.status, creator: this.player(r.creator_id), opponent: null,
        state: view, turn: 'first', result: r.result ? JSON.parse(r.result) : null, drawOffer: null,
        legalMoves: r.status === 'active' && viewerId && (state.phase === 'night' || state.phase === 'day') ? mafiaTargets(state, viewerId).map(target => ({ kind: 'mafia', phase: state.phase as 'night' | 'day', round: state.round, target })) : [],
        version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, waitingExpiresAt: r.waiting_expires_at,
        history: [], participants: state.players.map(member => this.player(member.id)), mafiaPhase: state.phase,
      };
    }
    const id = r.id, state: GameState = JSON.parse(r.state), engine = engines[r.game];
    return {
      id, game: r.game, status: r.status, creator: this.player(r.creator_id), opponent: r.opponent_id ? this.player(r.opponent_id) : null,
      state, turn: engine.turn(state), legalMoves: r.status === 'active' ? engine.legalMoves(state) : [],
      result: r.result ? JSON.parse(r.result) : null, drawOffer: r.draw_offer, version: r.version,
      createdAt: r.created_at, updatedAt: r.updated_at, waitingExpiresAt: r.waiting_expires_at,
      history: this.db.prepare('SELECT number,seat,label FROM moves WHERE match_id=? ORDER BY number').all(id) as GameSnapshot['history'],
    };
  }
  create(game: GameType, creatorId: string, published = true, requestId?: string): GameSnapshot {
    const id = this.db.transaction(() => {
      this.player(creatorId);
      if (requestId) {
        const prior = this.db.prepare('SELECT game,match_id FROM creations WHERE player_id=? AND request_id=?').get(creatorId, requestId) as { game: GameType; match_id: string } | undefined;
        if (prior) {
          if (prior.game !== game) throw new AppError(409, 'This creation request ID was already used');
          return prior.match_id;
        }
      }
      const id = randomBytes(12).toString('base64url'), timestamp = Date.now(), now = new Date(timestamp).toISOString();
      const state = game === 'mafia' ? createMafia(creatorId) : engines[game].initialize();
      this.db.prepare('INSERT INTO matches(id,game,creator_id,status,state,published,created_at,updated_at,waiting_expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, game, creatorId, 'waiting', JSON.stringify(state), Number(published), now, now, published ? new Date(timestamp + WAITING_TIMEOUT_MS).toISOString() : null);
      if (game === 'mafia') this.db.prepare('INSERT INTO match_members(match_id,player_id) VALUES(?,?)').run(id, creatorId);
      if (requestId) this.db.prepare('INSERT INTO creations(player_id,request_id,game,match_id) VALUES(?,?,?,?)').run(creatorId, requestId, game, id);
      return id;
    })();
    return this.get(id, creatorId);
  }
  private markPublished(id: string) {
    this.db.prepare("UPDATE matches SET published=1,waiting_expires_at=CASE WHEN status='waiting' THEN COALESCE(waiting_expires_at,?) ELSE NULL END WHERE id=?").run(new Date(Date.now() + WAITING_TIMEOUT_MS).toISOString(), id);
  }
  publish(id: string) { this.expireWaitingGames(Date.now(), id); this.row(id); this.markPublished(id); return this.get(id); }
  creation(playerId: string, requestId: string) {
    const row = this.db.prepare('SELECT match_id FROM creations WHERE player_id=? AND request_id=?').get(playerId, requestId) as { match_id: string } | undefined;
    if (!row) throw new AppError(404, 'Creation has not been saved yet');
    return this.get(row.match_id, playerId);
  }
  open(id: string, playerId: string) {
    this.player(playerId);
    this.expireWaitingGames(Date.now(), id);
    this.advanceMafiaGames(Date.now(), id);
    let changed = false;
    const match = this.db.transaction(() => {
      const r = this.row(id);
      if (r.game === 'mafia') {
        const state: MafiaState = JSON.parse(r.state);
        if (r.status === 'waiting' && !state.players.some(member => member.id === playerId) && state.players.length < MAFIA_MAX_PLAYERS) {
          this.saveMafia(id, joinMafia(state, playerId)); changed = true;
        } else this.markPublished(id);
        return this.snapshot(this.row(id), playerId);
      }
      if (r.status === 'waiting' && !r.opponent_id && r.creator_id !== playerId) {
        this.db.prepare("UPDATE matches SET opponent_id=?,status='active',version=version+1,published=1,waiting_expires_at=NULL,updated_at=? WHERE id=?").run(playerId, new Date().toISOString(), id);
        this.db.prepare('UPDATE message_refs SET pending=1 WHERE match_id=?').run(id);
        changed = true;
      } else this.markPublished(id);
      return this.snapshot(this.row(id));
    })();
    if (changed) this.emit(match);
    return match;
  }
  private summaries(where: string, params: string[]): GameSummary[] {
    // Extract only the side to move from storage; never replay chess or read moves here.
    const rows = this.db.prepare(`SELECT m.id,m.game,m.status,m.result,m.version,m.created_at,m.updated_at,m.waiting_expires_at,
      CASE WHEN m.game='mafia' THEN json_extract(m.state,'$.phase') ELSE NULL END AS mafia_phase,
      c.id AS creator_id,c.name AS creator_name,c.username AS creator_username,
      o.id AS opponent_id,o.name AS opponent_name,o.username AS opponent_username,
      CASE WHEN m.game='mafia' THEN 'first' WHEN m.game='chess' THEN CASE WHEN json_extract(m.state,'$.fen') LIKE '% w %' THEN 'first' ELSE 'second' END
        ELSE json_extract(m.state,'$.turn') END AS turn
      FROM matches m JOIN players c ON c.id=m.creator_id LEFT JOIN players o ON o.id=m.opponent_id
      WHERE ${where} ORDER BY m.updated_at DESC,m.id LIMIT 100`).all(...params) as (MatchRow & { creator_name: string; creator_username: string | null; opponent_name: string; opponent_username: string | null; turn: Seat; mafia_phase: MafiaPhase | null })[];
    return rows.map(r => ({
      id: r.id, game: r.game, status: r.status, version: r.version, turn: r.turn,
      creator: { id: r.creator_id, name: r.creator_name, ...(r.creator_username ? { username: r.creator_username } : {}) },
      opponent: r.opponent_id ? { id: r.opponent_id, name: r.opponent_name, ...(r.opponent_username ? { username: r.opponent_username } : {}) } : null,
      result: r.result ? JSON.parse(r.result) : null, createdAt: r.created_at, updatedAt: r.updated_at, waitingExpiresAt: r.waiting_expires_at,
      ...(r.game === 'mafia' ? { mafiaPhase: r.mafia_phase!, participants: (this.db.prepare('SELECT p.id,p.name,p.username FROM match_members m JOIN players p ON p.id=m.player_id WHERE m.match_id=?').all(r.id) as Player[]).map(player => ({ id: player.id, name: player.name, ...(player.username ? { username: player.username } : {}) })) } : {}),
    }));
  }
  summary(id: string): GameSummary {
    this.expireWaitingGames(Date.now(), id);
    this.advanceMafiaGames(Date.now(), id);
    const result = this.summaries('m.id=?', [id])[0];
    if (!result) throw new AppError(404, 'Game not found.');
    return result;
  }
  list(playerId: string): GameSummary[] {
    this.expireWaitingGames();
    this.advanceMafiaGames();
    return this.summaries('m.published=1 AND (m.creator_id=? OR m.opponent_id=? OR EXISTS(SELECT 1 FROM match_members member WHERE member.match_id=m.id AND member.player_id=?))', [playerId, playerId, playerId]);
  }
  act(id: string, playerId: string, action: Action): GameSnapshot {
    // Commit expiry before validating an action so a rejected late join cannot roll it back.
    this.expireWaitingGames(Date.now(), id);
    this.advanceMafiaGames(Date.now(), id);
    let changed = false;
    const match = this.db.transaction(() => {
      const r = this.row(id);
      const { actionId, version, ...payload } = action;
      const fingerprint = JSON.stringify(payload);
      const prior = this.db.prepare('SELECT player_id,payload FROM actions WHERE match_id=? AND action_id=?').get(id, actionId) as { player_id: string; payload: string } | undefined;
      if (prior) {
        if (prior.player_id !== playerId || prior.payload !== fingerprint) throw new AppError(409, 'This action ID was already used');
        return this.snapshot(r, playerId);
      }
      if (r.game === 'mafia') {
        let state: MafiaState = JSON.parse(r.state);
        if (action.kind === 'join' && state.players.some(member => member.id === playerId)) return this.snapshot(r, playerId);
        if (r.status === 'cancelled' || r.status === 'finished') throw new AppError(409, 'This game has ended. Start a new game.');
        if (action.kind === 'join') { this.player(playerId); state = joinMafia(state, playerId); }
        else if (action.kind === 'start') {
          if (playerId !== r.creator_id) throw new AppError(403, 'Only the host can start Mafia');
          state = startMafia(state);
        } else if (action.kind === 'move') {
          if (action.move.kind !== 'mafia') throw new AppError(400, 'Invalid Mafia choice');
          state = playMafia(state, playerId, action.move);
        } else if (action.kind === 'leave' || action.kind === 'resign') state = leaveMafia(state, playerId, r.creator_id);
        else if (action.kind === 'cancel') {
          if (playerId !== r.creator_id || r.status !== 'waiting') throw new AppError(409, 'Only the host can cancel a waiting game');
          state = { ...state, phase: 'finished', phaseExpiresAt: null };
        } else throw new AppError(400, 'Draw offers are not available in Mafia');
        this.saveMafia(id, state, action.kind === 'cancel');
        this.db.prepare('INSERT INTO actions(match_id,action_id,player_id,kind,payload) VALUES(?,?,?,?,?)').run(id, actionId, playerId, action.kind, fingerprint);
        changed = true;
        return this.snapshot(this.row(id), playerId);
      }
      if (action.kind === 'start' || action.kind === 'leave') throw new AppError(400, 'This action is only available in Mafia');
      if (r.version !== version) throw new AppError(409, 'The game changed. Your board has been refreshed; try again.');
      const seat: Seat | null = playerId === r.creator_id ? 'first' : playerId === r.opponent_id ? 'second' : null;
      let state: GameState = JSON.parse(r.state), status = r.status, result: GameResult | null = r.result ? JSON.parse(r.result) : null;
      let opponentId = r.opponent_id, drawOffer = r.draw_offer;
      if (action.kind === 'join') {
        if (seat) return this.snapshot(r);
        if (status === 'cancelled' || status === 'finished') throw new AppError(409, 'This game has ended. Start a new game.');
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
      this.db.prepare('UPDATE matches SET opponent_id=?,status=?,state=?,result=?,draw_offer=?,version=version+1,published=1,waiting_expires_at=NULL,updated_at=? WHERE id=?').run(opponentId, status, JSON.stringify(state), result ? JSON.stringify(result) : null, drawOffer, new Date().toISOString(), id);
      this.db.prepare('INSERT INTO actions(match_id,action_id,player_id,kind,payload) VALUES(?,?,?,?,?)').run(id, actionId, playerId, action.kind, fingerprint);
      if (status !== r.status) this.db.prepare('UPDATE message_refs SET pending=1 WHERE match_id=?').run(id);
      changed = true;
      return this.snapshot(this.row(id));
    })();
    if (changed) this.emit(match);
    return match;
  }
  expireWaitingGames(now = Date.now(), id?: string): number {
    const timestamp = new Date(now).toISOString();
    const expired = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id,game,state FROM matches WHERE status='waiting' AND opponent_id IS NULL AND waiting_expires_at<=?${id ? ' AND id=?' : ''}`).all(...(id ? [timestamp, id] : [timestamp])) as Pick<MatchRow, 'id' | 'game' | 'state'>[];
      for (const { id, game, state: saved } of rows) {
        if (game === 'mafia') {
          const state: MafiaState = JSON.parse(saved);
          if (state.players.length >= MAFIA_MIN_PLAYERS) { this.saveMafia(id, startMafia(state, now), false, now); continue; }
          this.db.prepare('UPDATE matches SET state=? WHERE id=?').run(JSON.stringify({ ...state, phase: 'finished' }), id);
        }
        this.db.prepare("UPDATE matches SET status='cancelled',result=?,draw_offer=NULL,waiting_expires_at=NULL,version=version+1,updated_at=? WHERE id=?").run(JSON.stringify({ winner: null, reason: game === 'mafia' ? `Not enough players joined in time. Mafia needs at least ${MAFIA_MIN_PLAYERS} players.` : 'No second player joined in time.' }), timestamp, id);
        this.db.prepare('UPDATE message_refs SET pending=1 WHERE match_id=?').run(id);
      }
      return rows.map(({ id }) => this.snapshot(this.row(id)));
    })();
    for (const match of expired) this.emit(match);
    return expired.length;
  }
  private saveMafia(id: string, state: MafiaState, cancelled = false, now = Date.now()) {
    const result = mafiaResult(state), status = cancelled ? 'cancelled' : state.phase === 'lobby' ? 'waiting' : state.phase === 'finished' ? 'finished' : 'active';
    this.db.prepare("UPDATE matches SET state=?,status=?,result=?,version=version+1,published=1,phase_expires_at=?,waiting_expires_at=CASE WHEN ?='waiting' THEN COALESCE(waiting_expires_at,?) ELSE NULL END,updated_at=? WHERE id=?").run(JSON.stringify(state), status, result ? JSON.stringify(result) : null, state.phaseExpiresAt, status, new Date(now + WAITING_TIMEOUT_MS).toISOString(), new Date(now).toISOString(), id);
    this.db.prepare('DELETE FROM match_members WHERE match_id=?').run(id);
    for (const player of state.players) this.db.prepare('INSERT INTO match_members(match_id,player_id) VALUES(?,?)').run(id, player.id);
    this.db.prepare('UPDATE message_refs SET pending=1 WHERE match_id=?').run(id);
  }
  advanceMafiaGames(now = Date.now(), id?: string): number {
    const matches = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id,state FROM matches WHERE game='mafia' AND status='active' AND phase_expires_at<=?${id ? ' AND id=?' : ''}`).all(...(id ? [new Date(now).toISOString(), id] : [new Date(now).toISOString()])) as Pick<MatchRow, 'id' | 'state'>[];
      for (const row of rows) this.saveMafia(row.id, advanceMafia(JSON.parse(row.state), now), false, now);
      return rows.map(row => this.snapshot(this.row(row.id)));
    })();
    for (const match of matches) this.emit(match);
    return matches.length;
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
