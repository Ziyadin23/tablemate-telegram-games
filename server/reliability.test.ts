import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import { GameService } from './service.js';
import { createTelegramBot } from './telegram.js';
import { buildApp } from './app.js';
import { issueSession } from './auth.js';
import type { Config } from './config.js';
const config: Config = { mode: 'demo', production: false, host: '127.0.0.1', port: 0, dbPath: ':memory:', publicUrl: 'http://localhost', botToken: '123:fake', botUsername: 'qa_bot', sessionSecret: 'test-secret' };
let service: GameService;
beforeEach(() => { service = new GameService(openDatabase(':memory:')); for (const id of ['alice', 'bob']) service.upsertPlayer({ id, name: id }); });
afterEach(() => { vi.useRealTimers(); service.db.close(); });
it('lobby contains summaries and never generates board moves or history', () => {
  const match = service.create('chess', 'alice'); service.open(match.id, 'bob');
  const snapshot = vi.spyOn(service, 'get');
  const rows = service.list('alice');
  expect(rows[0]).toMatchObject({ id: match.id, turn: 'first', status: 'active' });
  expect(rows[0]).not.toHaveProperty('state'); expect(rows[0]).not.toHaveProperty('history'); expect(rows[0]).not.toHaveProperty('legalMoves');
  expect(snapshot).not.toHaveBeenCalled();
});
it('creation requests recover one durable match and reject changed intent', async () => {
  const app = await buildApp(config, service, false);
  try {
    const requestId = randomUUID(), headers = { authorization: `Bearer ${issueSession('alice', config.sessionSecret)}` };
    const create = (game = 'chess') => app.inject({ method: 'POST', url: '/api/matches', headers, payload: { game, requestId } });
    const first = await create(), second = await create();
    expect(first.statusCode).toBe(200); expect(second.json().match.id).toBe(first.json().match.id);
    expect(service.list('alice')).toHaveLength(1); expect((await create('checkers')).statusCode).toBe(409);
  } finally { await app.close(); }
});
it('health bypasses quotas and player buckets are independent through the trusted proxy', async () => {
  const app = await buildApp(config, service, false);
  try {
    const headers = { 'x-forwarded-for': '192.0.2.7', authorization: `Bearer ${issueSession('alice', config.sessionSecret)}` };
    for (let i = 0; i < 301; i++) await app.inject({ url: '/api/matches', headers, remoteAddress: '172.20.0.2' });
    expect((await app.inject({ url: '/api/matches', headers, remoteAddress: '172.20.0.2' })).statusCode).toBe(429);
    expect((await app.inject({ url: '/api/matches', headers: { ...headers, authorization: `Bearer ${issueSession('bob', config.sessionSecret)}` }, remoteAddress: '172.20.0.2' })).statusCode).toBe(200);
    for (let i = 0; i < 301; i++) expect((await app.inject({ url: '/api/health', headers, remoteAddress: '172.20.0.2' })).statusCode).toBe(200);
  } finally { await app.close(); }
});
function refs(count: number) { for (let n = 1; n <= count; n++) { const match = service.create('tictactoe', 'alice'); service.addMessageRef(match.id, { chatId: '7', messageId: n }); } }
it('failing edit cohort cannot starve newer messages', async () => {
  vi.useFakeTimers(); const telegram = createTelegramBot({ ...config, mode: 'telegram' }, service), attempts: number[] = [];
  telegram.bot.api.config.use(async (_prev, _method, payload: any) => { attempts.push(payload.message_id); return payload.message_id <= 50 ? { ok: false, error_code: 500, description: 'Transient failure' } : { ok: true, result: true }; });
  refs(51);
  try { await vi.advanceTimersByTimeAsync(8000); expect(attempts).toContain(51); expect(attempts.filter(n => n === 1)).toHaveLength(1); }
  finally { await telegram.close(); }
});
it('retry_after=120 is honored across ticks and permits work after its deadline', async () => {
  vi.useFakeTimers(); const telegram = createTelegramBot({ ...config, mode: 'telegram' }, service); let attempts = 0;
  telegram.bot.api.config.use(async () => { attempts++; return attempts === 1 ? { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 120 } } : { ok: true, result: true }; });
  refs(2);
  try { await vi.advanceTimersByTimeAsync(4000); expect(attempts).toBe(1); await vi.advanceTimersByTimeAsync(119_000); expect(attempts).toBe(1); await vi.advanceTimersByTimeAsync(5000); expect(attempts).toBe(3); }
  finally { await telegram.close(); }
});
it('close waits for an outstanding edit before storage is closed', async () => {
  vi.useFakeTimers(); const telegram = createTelegramBot({ ...config, mode: 'telegram' }, service); let release!: () => void, edits = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  telegram.bot.api.config.use(async () => { edits++; await gate; return { ok: true, result: true }; }); refs(2);
  await vi.advanceTimersByTimeAsync(4000); expect(edits).toBe(1);
  let closed = false; const closing = Promise.resolve(telegram.close()).then(() => { closed = true; });
  await Promise.resolve(); const waited = !closed; release(); await closing;
  expect(waited).toBe(true); expect(edits).toBe(1);
});

it('Telegram cooldown survives worker restart and does not lose a newer state during an edit', async () => {
  vi.useFakeTimers(); let telegram = createTelegramBot({ ...config, mode: 'telegram' }, service); let attempts = 0;
  telegram.bot.api.config.use(async () => { attempts++; return { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 120 } }; });
  refs(1); await telegram.flush(); await telegram.close();
  telegram = createTelegramBot({ ...config, mode: 'telegram' }, service);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  telegram.bot.api.config.use(async () => { attempts++; await gate; return { ok: true, result: true }; });
  await vi.advanceTimersByTimeAsync(119_000); expect(attempts).toBe(1);
  // The last second releases due work, which is deliberately still in flight.
  await vi.advanceTimersByTimeAsync(1000); expect(attempts).toBe(2);
  const ref = service.pendingMessages()[0], before = service.get(ref.match_id);
  service.open(before.id, 'bob'); release(); await telegram.flush();
  expect(service.pendingMessages()).toHaveLength(1); await telegram.flush(); expect(service.pendingMessages()).toHaveLength(0); await telegram.close();
});
it('untrusted forwarded IP headers cannot create new anonymous auth buckets', async () => {
  const app = await buildApp(config, service, false);
  try {
    for (let i = 0; i < 60; i++) expect((await app.inject({ method: 'POST', url: '/api/auth/demo', payload: { player: 'Alice' }, remoteAddress: '203.0.113.3', headers: { 'x-forwarded-for': `192.0.2.${i}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/demo', payload: { player: 'Bob' }, remoteAddress: '203.0.113.3', headers: { 'x-forwarded-for': '192.0.2.61' } })).statusCode).toBe(429);
  } finally { await app.close(); }
});
it('an outstanding Telegram transport is cancelled by its edit deadline and close drains it', async () => {
  vi.useFakeTimers(); const telegram = createTelegramBot({ ...config, mode: 'telegram' }, service); let aborted = false;
  telegram.bot.api.config.use(async (_prev, _method, _payload, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => { aborted = true; reject(new Error('Cancelled edit')); }, { once: true });
  }));
  refs(1); await vi.advanceTimersByTimeAsync(4000); const closing = telegram.close();
  await vi.advanceTimersByTimeAsync(15_000); await closing;
  expect(aborted).toBe(true); expect(service.db.prepare('SELECT pending,attempts FROM message_refs').get()).toEqual({ pending: 1, attempts: 1 });
});
