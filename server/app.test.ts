import { afterEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { openDatabase } from './db.js';
import { GameService } from './service.js';
import { buildApp } from './app.js';
import { issueSession, validateTelegramData, verifySession } from './auth.js';
import { readConfig, type Config } from './config.js';

const config: Config = { mode: 'demo', port: 3001, host: '127.0.0.1', dbPath: ':memory:', publicUrl: 'http://localhost:5173', botToken: '123:fake', botUsername: 'tablemate_test_bot', sessionSecret: 'test-secret-with-more-than-32-characters', production: false };
let app: Awaited<ReturnType<typeof buildApp>> | undefined, service: GameService;
afterEach(async () => { if (app) await app.close(); app = undefined; service?.db.close(); });
async function setup(cfg = config) { service = new GameService(openDatabase(':memory:')); app = await buildApp(cfg, service, false); return app; }
function telegramData(age = 0) {
  const entries = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify({ id: 12345, first_name: 'Ada' }), start_param: 'match' });
  const check = [...entries.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  entries.set('hash', createHmac('sha256', secret).update(check).digest('hex')); return entries.toString();
}
const auth = (id: string) => ({ authorization: `Bearer ${issueSession(id, config.sessionSecret)}` });
function waitMessage(socket: WebSocket, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', listen); reject(new Error(`Timed out waiting for ${type}`)); }, 3000);
    const listen = (raw: Buffer) => { const data = JSON.parse(raw.toString()); if (data.type === type) { clearTimeout(timer); socket.off('message', listen); resolve(data); } };
    socket.on('message', listen);
  });
}

describe('authentication', () => {
  it('validates Telegram signatures, rejects tampering, duplicate fields, and stale data', () => {
    const raw = telegramData(); expect(validateTelegramData(raw, config.botToken).name).toBe('Ada');
    expect(() => validateTelegramData(raw.replace('Ada', 'Eve'), config.botToken)).toThrow();
    expect(() => validateTelegramData(raw + '&auth_date=1', config.botToken)).toThrow();
    expect(() => validateTelegramData(telegramData(601), config.botToken)).toThrow('expired');
  });
  it('validates session signatures and expiration', () => {
    const token = issueSession('alice', config.sessionSecret); expect(verifySession(token, config.sessionSecret)).toBe('alice');
    expect(() => verifySession(token + 'x', config.sessionSecret)).toThrow();
    expect(() => verifySession(issueSession('alice', config.sessionSecret, Date.now() - 25 * 60 * 60_000), config.sessionSecret)).toThrow('expired');
  });
  it('rejects demo authentication in Telegram mode and production', async () => {
    const api = await setup({ ...config, mode: 'telegram', production: true });
    expect((await api.inject({ method: 'POST', url: '/api/auth/demo', payload: { player: 'Alice' } })).statusCode).toBe(404);
    const result = await api.inject({ method: 'POST', url: '/api/auth/telegram', payload: { initData: telegramData() } });
    expect(result.statusCode).toBe(200); expect(result.json().player.id).toBe('12345');
  });
  it('refuses production demo configuration', () => {
    const prevMode = process.env.APP_MODE, prevEnv = process.env.NODE_ENV;
    try { process.env.APP_MODE = 'demo'; process.env.NODE_ENV = 'production'; expect(() => readConfig()).toThrow('disabled in production'); }
    finally { if (prevMode === undefined) delete process.env.APP_MODE; else process.env.APP_MODE = prevMode; if (prevEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prevEnv; }
  });
});

describe('HTTP and websocket integration', () => {
  it('requires authentication, validates inputs and rejects foreign origins', async () => {
    const api = await setup(); service.upsertPlayer({ id: 'alice', name: 'Alice' });
    expect((await api.inject('/api/matches')).statusCode).toBe(401);
    expect((await api.inject({ method: 'POST', url: '/api/matches', headers: auth('alice'), payload: { game: 'poker' } })).statusCode).toBe(400);
    expect((await api.inject({ method: 'POST', url: '/api/matches', headers: { ...auth('alice'), origin: 'https://unrelated.example' }, payload: { game: 'chess' } })).statusCode).toBe(403);
    expect((await api.inject('/api/health')).json()).toEqual({ status: 'ok' });
  });
  it('supports creation, opening, atomic joining and move retries through HTTP', async () => {
    const api = await setup(); for (const id of ['alice', 'bob']) service.upsertPlayer({ id, name: id });
    const created = await api.inject({ method: 'POST', url: '/api/matches', headers: auth('alice'), payload: { game: 'tictactoe' } });
    const m = created.json().match;
    const joined = await api.inject({ method: 'POST', url: `/api/matches/${m.id}/actions`, headers: auth('bob'), payload: { kind: 'join', actionId: randomUUID(), version: m.version } });
    const payload = { kind: 'move', move: { kind: 'tictactoe', cell: 0 }, actionId: randomUUID(), version: joined.json().match.version };
    const request = { method: 'POST' as const, url: `/api/matches/${m.id}/actions`, headers: auth('alice'), payload };
    expect((await api.inject(request)).json().match.history).toHaveLength(1);
    expect((await api.inject(request)).json().match.history).toHaveLength(1);
    const malformed = await api.inject({ ...request, payload: { ...payload, actionId: randomUUID(), move: { kind: 'tictactoe', cell: 999 } } });
    expect(malformed.statusCode).toBe(400);
    expect((await api.inject({ url: `/api/matches/${m.id}`, headers: auth('bob') })).json().match.history).toHaveLength(1);
  });
  it('accepts only one of two concurrent join requests', async () => {
    const api = await setup(); for (const id of ['alice', 'bob', 'eve']) service.upsertPlayer({ id, name: id });
    const match = service.create('chess', 'alice');
    const replies = await Promise.all(['bob', 'eve'].map(id => api.inject({ method: 'POST', url: `/api/matches/${match.id}/actions`, headers: auth(id), payload: { kind: 'join', version: 0, actionId: randomUUID() } })));
    expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]); expect(service.get(match.id).version).toBe(1);
  });
  it('opens the board directly and assigns only one opponent for concurrent opens', async () => {
    const api = await setup(); for (const id of ['alice', 'bob', 'eve']) service.upsertPlayer({ id, name: id });
    const match = service.create('chess', 'alice', false);
    const request = (id: string) => api.inject({ method: 'POST', url: `/api/matches/${match.id}/open`, headers: auth(id), payload: {} });
    expect((await request('alice')).json().match.status).toBe('waiting');
    const replies = await Promise.all(['bob', 'eve'].map(request));
    expect(replies.map(r => r.statusCode)).toEqual([200, 200]);
    const current = service.get(match.id);
    expect(current.status).toBe('active'); expect(current.version).toBe(1);
    expect(replies.map(r => r.json().match.opponent.id)).toEqual([current.opponent!.id, current.opponent!.id]);
    expect((await request(current.opponent!.id)).json().match.version).toBe(1);
  });
  it('broadcasts a joined match and resends current state after reconnect', async () => {
    const api = await setup(); for (const id of ['alice', 'bob']) service.upsertPlayer({ id, name: id });
    const match = service.create('chess', 'alice'), address = await api.listen({ host: '127.0.0.1', port: 0 });
    async function open() {
      const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws');
      await new Promise<void>(resolve => ws.once('open', resolve));
      const ready = waitMessage(ws, 'ready'); ws.send(JSON.stringify({ type: 'auth', token: issueSession('alice', config.sessionSecret) })); await ready;
      const current = waitMessage(ws, 'match'); ws.send(JSON.stringify({ type: 'subscribe', matchId: match.id })); return { ws, match: (await current).match };
    }
    const first = await open(); expect(first.match.status).toBe('waiting');
    const changed = waitMessage(first.ws, 'match'); service.act(match.id, 'bob', { kind: 'join', version: 0, actionId: randomUUID() });
    expect((await changed).match.status).toBe('active'); first.ws.close();
    const second = await open(); expect(second.match.version).toBe(1); second.ws.close();
  });
  it('automatically disbands waiting games and broadcasts the result without a client action', async () => {
    const api = await setup(); service.upsertPlayer({ id: 'alice', name: 'Alice' });
    const match = service.create('chess', 'alice'), address = await api.listen({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws');
    try {
      await new Promise<void>(resolve => ws.once('open', resolve));
      const ready = waitMessage(ws, 'ready'); ws.send(JSON.stringify({ type: 'auth', token: issueSession('alice', config.sessionSecret) })); await ready;
      const initial = waitMessage(ws, 'match'); ws.send(JSON.stringify({ type: 'subscribe', matchId: match.id })); await initial;
      const changed = waitMessage(ws, 'match'), listChanged = waitMessage(ws, 'list-changed');
      service.db.prepare('UPDATE matches SET waiting_expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), match.id);
      expect((await changed).match).toMatchObject({ status: 'cancelled', version: 1, opponent: null, result: { reason: 'No second player joined in time.' } });
      await listChanged;
      const stored = service.db.prepare('SELECT status FROM matches WHERE id=?').get(match.id);
      expect(stored).toEqual({ status: 'cancelled' });
    } finally { ws.close(); }
  });
  it('does not allow unauthenticated websocket subscriptions', async () => {
    const api = await setup(), address = await api.listen({ host: '127.0.0.1', port: 0 });
    const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws'); await new Promise<void>(resolve => ws.once('open', resolve));
    const failed = waitMessage(ws, 'error'); ws.send(JSON.stringify({ type: 'subscribe', matchId: 'abcdefghijklmnop' }));
    expect((await failed).error).toBe('Authentication required'); ws.close();
  });
});
