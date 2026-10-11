import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { openDatabase } from './db.js';
import { GameService, type Action } from './service.js';
import { buildApp } from './app.js';
import { issueSession } from './auth.js';
import type { Config } from './config.js';
import type { MafiaState } from './mafia.js';
import type { GameSnapshot } from '../shared/types.js';

const config: Config = { mode: 'demo', production: false, host: '127.0.0.1', port: 0, dbPath: ':memory:', publicUrl: 'http://localhost', botToken: '', botUsername: '', sessionSecret: 'test-secret' };
let service: GameService, app: Awaited<ReturnType<typeof buildApp>> | undefined;
beforeEach(() => { service = new GameService(openDatabase(':memory:')); for (let i = 0; i < 12; i++) service.upsertPlayer({ id: `p${i}`, name: `Player ${i}` }); });
afterEach(async () => { await app?.close(); app = undefined; service.db.close(); vi.useRealTimers(); });
const action = (match: GameSnapshot, kind: Exclude<Action['kind'], 'move'>): Action => ({ kind, version: match.version, actionId: randomUUID() });
function lobby(count = 5) { let match = service.create('mafia', 'p0'); for (let i = 1; i < count; i++) match = service.open(match.id, `p${i}`); return match; }
const stored = (id: string): MafiaState => JSON.parse((service.db.prepare('SELECT state FROM matches WHERE id=?').get(id) as { state: string }).state);
const headers = (id: string) => ({ authorization: `Bearer ${issueSession(id, config.sessionSecret)}` });
function waitMessage(ws: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const listen = (raw: Buffer) => { const message = JSON.parse(raw.toString()); if (message.type === type) { clearTimeout(timer); ws.off('message', listen); resolve(message); } };
    const timer = setTimeout(() => { ws.off('message', listen); reject(new Error(`Missing ${type}`)); }, 3000);
    ws.on('message', listen);
  });
}
describe('Mafia service and transport', () => {
  it('tracks every participant, limits the lobby, and lets only the host start', () => {
    const first = service.create('mafia', 'p0'); expect(() => service.act(first.id, 'p0', action(first, 'start'))).toThrow('at least 5');
    let match = service.open(first.id, 'p1'); expect(match.status).toBe('waiting'); expect(match.waitingExpiresAt).toBe(first.waitingExpiresAt);
    for (let i = 2; i < 10; i++) match = service.open(first.id, `p${i}`);
    expect(match.participants).toHaveLength(10); expect(service.open(first.id, 'p10').participants).toHaveLength(10);
    expect(service.list('p9')[0].id).toBe(first.id); expect(service.list('p10')).toEqual([]);
    expect(() => service.act(first.id, 'p1', action(match, 'start'))).toThrow('Only the host');
    const active = service.act(first.id, 'p0', action(first, 'start'));
    expect(active).toMatchObject({ status: 'active', waitingExpiresAt: null, state: { phase: 'night' } });
    expect(service.open(first.id, 'p10').state).toMatchObject({ yourRole: null, canAct: false });
  });
  it('removes a departing lobby member and does not revive cancelled rooms', () => {
    const match = lobby(); service.act(match.id, 'p1', action(match, 'leave'));
    expect(service.list('p1')).toEqual([]); expect(service.get(match.id).participants).toHaveLength(4);
    const cancelled = service.act(match.id, 'p0', action(match, 'cancel'));
    expect(service.act(match.id, 'p0', action(cancelled, 'join')).status).toBe('cancelled');
    expect(() => service.act(match.id, 'p1', action(cancelled, 'join'))).toThrow('game has ended');
  });
  it('starts a sufficiently populated lobby at its deadline and disbands a smaller one', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const enough = lobby(), insufficient = lobby(4);
    vi.setSystemTime(new Date('2026-10-11T12:03:00Z')); service.expireWaitingGames();
    expect(service.get(enough.id).status).toBe('active');
    expect(service.get(insufficient.id)).toMatchObject({ status: 'cancelled', state: { phase: 'finished' }, result: { reason: 'Not enough players joined in time. Mafia needs at least 5 players.' } });
  });
  it('accepts simultaneous choices with the same version, deduplicates retries, and isolates HTTP views', async () => {
    app = await buildApp(config, service, false);
    const match = lobby(), active = service.act(match.id, 'p0', action(match, 'start')), raw = stored(match.id);
    const mafia = raw.players.find(player => player.role === 'mafia')!.id;
    const doctor = raw.players.find(player => player.role === 'doctor')!.id;
    const detective = raw.players.find(player => player.role === 'detective')!.id;
    const target = raw.players.find(player => player.role === 'villager')!.id;
    const changes: GameSnapshot[] = []; service.onChange(match => changes.push(match));
    const requests = [[mafia, target], [doctor, target], [detective, mafia]].map(([id, target]) => ({ method: 'POST' as const, url: `/api/matches/${match.id}/actions`, headers: headers(id), payload: { kind: 'move', actionId: randomUUID(), version: active.version, move: { kind: 'mafia', phase: 'night', round: 1, target } } }));
    const replies = await Promise.all(requests.map(request => app!.inject(request)));
    expect(replies.map(reply => reply.statusCode)).toEqual([200, 200, 200]);
    expect(stored(match.id).phase).toBe('day'); expect((await app.inject(requests[0])).statusCode).toBe(200);
    expect(changes.every(match => match.state.kind === 'mafia' && match.state.yourRole === null && match.state.investigations.length === 0)).toBe(true);
    for (const id of raw.players.map(player => player.id).concat('p10')) {
      const response = await app.inject({ url: `/api/matches/${match.id}`, headers: headers(id) }), view = response.json().match;
      expect(view.state.yourRole).toBe(raw.players.find(player => player.id === id)?.role ?? null);
      expect(view.state.players.every((player: any) => player.revealedRole === null)).toBe(true);
      expect(view.state).not.toHaveProperty('nightActions');
      expect(view.state.investigations).toHaveLength(id === detective ? 1 : 0);
      if (id === 'p10') expect(view.legalMoves).toEqual([]);
    }
    const stale = await app.inject({ ...requests[0], payload: { ...requests[0].payload, actionId: randomUUID() } });
    expect(stale.statusCode).toBe(409); expect(service.summary(match.id)).not.toHaveProperty('state');
  });
  it('sends each subscriber their own role, including reconnects, without exposing it to spectators', async () => {
    app = await buildApp(config, service, false); const match = lobby(), address = await app.listen({ host: '127.0.0.1', port: 0 });
    async function connect(id: string) {
      const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws'); await new Promise<void>(resolve => ws.once('open', resolve));
      const ready = waitMessage(ws, 'ready'); ws.send(JSON.stringify({ type: 'auth', token: issueSession(id, config.sessionSecret) })); await ready;
      const current = waitMessage(ws, 'match'); ws.send(JSON.stringify({ type: 'subscribe', matchId: match.id })); return { ws, match: (await current).match };
    }
    const first = await connect('p0'), spectator = await connect('p10');
    try {
      const mine = waitMessage(first.ws, 'match'), watching = waitMessage(spectator.ws, 'match');
      service.act(match.id, 'p0', action(match, 'start'));
      expect((await mine).match.state.yourRole).toBe(stored(match.id).players[0].role);
      const view = (await watching).match; expect(view.state.yourRole).toBeNull(); expect(view.legalMoves).toEqual([]);
      expect(view.state.players.every((player: any) => player.revealedRole === null)).toBe(true);
      const restored = await connect('p0'); expect(restored.match.state.yourRole).toBe(stored(match.id).players[0].role); restored.ws.close();
    } finally { first.ws.close(); spectator.ws.close(); }
  });
  it('advances timed phases without requests and skips missing actions', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    app = await buildApp(config, service, false); const match = lobby(); service.act(match.id, 'p0', action(match, 'start'));
    await vi.advanceTimersByTimeAsync(60_000); expect(stored(match.id).phase).toBe('day');
    await vi.advanceTimersByTimeAsync(120_000); expect(stored(match.id)).toMatchObject({ phase: 'night', round: 2 });
  });
  it('restores roles, submitted actions, and phase deadlines from persistent storage', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tablemate-mafia-')), path = join(dir, 'games.sqlite'); let saved = new GameService(openDatabase(path));
    try {
      for (let i = 0; i < 5; i++) saved.upsertPlayer({ id: `p${i}`, name: `Player ${i}` });
      let match = saved.create('mafia', 'p0'); for (let i = 1; i < 5; i++) match = saved.open(match.id, `p${i}`);
      saved.act(match.id, 'p0', action(match, 'start'));
      const raw: MafiaState = JSON.parse((saved.db.prepare('SELECT state FROM matches WHERE id=?').get(match.id) as { state: string }).state), mafia = raw.players.find(player => player.role === 'mafia')!.id;
      const mine = saved.get(match.id, mafia), move = mine.legalMoves[0];
      saved.act(match.id, mafia, { kind: 'move', move, actionId: randomUUID(), version: mine.version });
      const before = saved.get(match.id, mafia); saved.db.close(); saved = new GameService(openDatabase(path));
      expect(saved.get(match.id, mafia)).toEqual(before); expect(saved.list('p4')[0].id).toBe(match.id);
    } finally { if (saved.db.open) saved.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
