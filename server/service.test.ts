import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import { GameService } from './service.js';
import type { GameSnapshot } from '../shared/types.js';

let service: GameService;
beforeEach(() => { service = new GameService(openDatabase(':memory:')); for (const id of ['alice', 'bob', 'eve']) service.upsertPlayer({ id, name: id }); });
afterEach(() => { service.db.close(); vi.useRealTimers(); });
const action = (m: GameSnapshot, kind: 'join' | 'resign' | 'cancel' | 'offer-draw' | 'accept-draw' | 'decline-draw') => ({ kind, version: m.version, actionId: randomUUID() });
const started = (game: 'chess' | 'checkers' | 'tictactoe' = 'tictactoe') => { const m = service.create(game, 'alice'); return service.act(m.id, 'bob', action(m, 'join')); };

describe('saved match lifecycle', () => {
  it('starts when the second player opens the board and keeps later visitors as spectators', () => {
    const draft = service.create('chess', 'alice', false);
    const changes: GameSnapshot[] = []; service.onChange(m => changes.push(m));
    expect(service.open(draft.id, 'alice').status).toBe('waiting');
    expect(service.list('alice')).toHaveLength(1);
    const active = service.open(draft.id, 'bob');
    expect(active.opponent?.id).toBe('bob'); expect(active.status).toBe('active');
    expect(active.legalMoves.length).toBeGreaterThan(0); expect(service.list('bob')).toHaveLength(1);
    expect(service.open(draft.id, 'bob')).toEqual(active);
    expect(service.open(draft.id, 'eve')).toEqual(active);
    expect(changes).toHaveLength(1); expect(service.list('eve')).toHaveLength(0);
  });
  it('does not reopen cancelled or finished games', () => {
    const waiting = service.create('chess', 'alice');
    const cancelled = service.act(waiting.id, 'alice', action(waiting, 'cancel'));
    expect(service.open(cancelled.id, 'bob')).toEqual(cancelled);
    const active = started('chess');
    const finished = service.act(active.id, 'alice', action(active, 'resign'));
    expect(service.open(finished.id, 'eve')).toEqual(finished);
  });
  it('reserves the creator’s seat and accepts only one opponent', () => {
    let m = service.create('chess', 'alice');
    expect(service.act(m.id, 'alice', action(m, 'join')).status).toBe('waiting');
    const original = m; m = service.act(m.id, 'bob', action(m, 'join'));
    expect(m.opponent?.id).toBe('bob'); expect(m.status).toBe('active');
    expect(() => service.act(m.id, 'eve', action(original, 'join'))).toThrow('game changed');
    expect(() => service.act(m.id, 'eve', action(m, 'join'))).toThrow('Both seats');
  });
  it('rejects spectators, out-of-turn moves, and illegal moves without changing state', () => {
    const m = started();
    const move = { kind: 'move' as const, move: { kind: 'tictactoe' as const, cell: 0 }, version: m.version, actionId: randomUUID() };
    expect(() => service.act(m.id, 'eve', move)).toThrow('Only the players');
    expect(() => service.act(m.id, 'bob', move)).toThrow('Wait for your turn');
    expect(() => service.act(m.id, 'alice', { ...move, move: { kind: 'tictactoe', cell: 99 } })).toThrow('not legal');
    expect(service.get(m.id).version).toBe(m.version); expect(service.get(m.id).history).toHaveLength(0);
  });
  it('deduplicates a retry even with an old version and rejects reused IDs', () => {
    const m = started();
    const request = { kind: 'move' as const, move: { kind: 'tictactoe' as const, cell: 0 }, version: m.version, actionId: randomUUID() };
    const after = service.act(m.id, 'alice', request);
    expect(service.act(m.id, 'alice', request).version).toBe(after.version);
    expect(service.get(m.id).history).toHaveLength(1);
    expect(() => service.act(m.id, 'alice', { ...request, move: { kind: 'tictactoe', cell: 1 } })).toThrow('already used');
  });
  it('finishes a game with a result and prevents moves afterward', () => {
    let m = started();
    for (const [i, cell] of [0, 3, 1, 4, 2].entries()) m = service.act(m.id, i % 2 ? 'bob' : 'alice', { kind: 'move', move: { kind: 'tictactoe', cell }, version: m.version, actionId: randomUUID() });
    expect(m.status).toBe('finished'); expect(m.result?.winner).toBe('first'); expect(m.legalMoves).toEqual([]);
    expect(() => service.act(m.id, 'bob', { kind: 'move', move: { kind: 'tictactoe', cell: 8 }, version: m.version, actionId: randomUUID() })).toThrow('not in progress');
  });
  it('allows creator cancellation, resignation, and a mutually accepted draw', () => {
    const waiting = service.create('chess', 'alice');
    expect(() => service.act(waiting.id, 'eve', action(waiting, 'cancel'))).toThrow();
    expect(service.act(waiting.id, 'alice', action(waiting, 'cancel')).status).toBe('cancelled');
    const resign = started('chess'); expect(service.act(resign.id, 'bob', action(resign, 'resign')).result?.winner).toBe('first');
    let draw = started('checkers'); draw = service.act(draw.id, 'alice', action(draw, 'offer-draw'));
    expect(() => service.act(draw.id, 'alice', action(draw, 'accept-draw'))).toThrow('no opponent');
    expect(service.act(draw.id, 'bob', action(draw, 'accept-draw')).result).toEqual({ winner: null, reason: 'Draw by agreement' });
  });
  it('declines a draw and automatically clears it when the opponent moves', () => {
    let m = started('chess'); m = service.act(m.id, 'bob', action(m, 'offer-draw'));
    m = service.act(m.id, 'alice', action(m, 'decline-draw')); expect(m.drawOffer).toBeNull();
    m = service.act(m.id, 'bob', action(m, 'offer-draw'));
    m = service.act(m.id, 'alice', { kind: 'move', move: { kind: 'chess', from: 'e2', to: 'e4' }, version: m.version, actionId: randomUUID() });
    expect(m.drawOffer).toBeNull();
  });
  it('keeps unsent inline drafts out of the list and survives missing feedback', () => {
    const draft = service.create('chess', 'alice', false); expect(service.list('alice')).toEqual([]);
    service.publish(draft.id); expect(service.list('alice')).toHaveLength(1);
    const old = service.create('checkers', 'alice', false);
    service.db.prepare('UPDATE matches SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', old.id);
    service.clearOldDrafts(); expect(() => service.get(old.id)).toThrow('not found'); expect(service.get(draft.id).status).toBe('waiting');
  });
  it('records message references and marks edits only when status changes', () => {
    let m = service.create('chess', 'alice'); service.addMessageRef(m.id, { inlineMessageId: 'inline-1' }); service.messageUpdated('inline-1');
    m = service.act(m.id, 'bob', action(m, 'join')); expect(service.pendingMessages()).toHaveLength(1); service.messageUpdated('inline-1');
    service.act(m.id, 'alice', { kind: 'move', move: { kind: 'chess', from: 'e2', to: 'e4' }, version: m.version, actionId: randomUUID() });
    expect(service.pendingMessages()).toHaveLength(0);
  });
  it('restores the board, history, and idempotency ledger after restarting SQLite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tablemate-'));
    try {
      const path = join(dir, 'games.sqlite'); let saved = new GameService(openDatabase(path));
      saved.upsertPlayer({ id: 'alice', name: 'Alice' }); saved.upsertPlayer({ id: 'bob', name: 'Bob' });
      let m = saved.create('chess', 'alice'); m = saved.act(m.id, 'bob', action(m, 'join'));
      const request = { kind: 'move' as const, move: { kind: 'chess' as const, from: 'e2', to: 'e4' }, version: m.version, actionId: randomUUID() };
      m = saved.act(m.id, 'alice', request); saved.db.close(); saved = new GameService(openDatabase(path));
      expect(saved.get(m.id)).toEqual(m); expect(saved.act(m.id, 'alice', request).history).toHaveLength(1); saved.db.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('waiting game deadlines', () => {
  const start = Date.parse('2026-10-11T12:00:00.000Z');
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start); });
  it.each(['chess', 'checkers', 'tictactoe'] as const)('disbands an unjoined %s game at three minutes and notifies observers once', game => {
    const requestId = randomUUID(), waiting = service.create(game, 'alice', true, requestId);
    expect(waiting.waitingExpiresAt).toBe(new Date(start + 180_000).toISOString());
    service.addMessageRef(waiting.id, { inlineMessageId: 'waiting' }); service.messageUpdated('waiting');
    const changes: GameSnapshot[] = []; service.onChange(match => changes.push(match));
    vi.setSystemTime(start + 179_999);
    expect(service.expireWaitingGames()).toBe(0); expect(service.get(waiting.id).status).toBe('waiting');
    vi.setSystemTime(start + 180_000);
    expect(service.expireWaitingGames()).toBe(1);
    const expired = service.get(waiting.id);
    expect(expired).toMatchObject({ status: 'cancelled', version: 1, opponent: null, waitingExpiresAt: null, legalMoves: [], history: [], result: { winner: null, reason: 'No second player joined in time.' } });
    expect(service.list('alice')[0]).toMatchObject({ status: 'cancelled', version: 1 });
    expect(service.pendingMessages()[0].ref).toBe('waiting');
    expect(service.expireWaitingGames()).toBe(0); expect(changes).toEqual([expired]);
    expect(service.create(game, 'alice', true, requestId)).toEqual(expired);
  });
  it.each(['open', 'join'] as const)('rejects a late opponent through %s even before the expiry worker runs', method => {
    const waiting = service.create('chess', 'alice');
    vi.setSystemTime(start + 180_000);
    if (method === 'open') expect(service.open(waiting.id, 'bob').status).toBe('cancelled');
    else expect(() => service.act(waiting.id, 'bob', action(waiting, 'join'))).toThrow('game changed');
    const expired = service.get(waiting.id);
    expect(expired).toMatchObject({ status: 'cancelled', opponent: null, version: 1 });
    expect(() => service.act(waiting.id, 'bob', action(expired, 'join'))).toThrow('game has ended');
    expect(service.open(waiting.id, 'eve')).toEqual(expired);
  });
  it.each(['open', 'join'] as const)('keeps a game active when its opponent arrives just before expiry through %s', method => {
    const waiting = service.create('checkers', 'alice');
    vi.setSystemTime(start + 179_999);
    const active = method === 'open' ? service.open(waiting.id, 'bob') : service.act(waiting.id, 'bob', action(waiting, 'join'));
    expect(active).toMatchObject({ status: 'active', waitingExpiresAt: null, opponent: { id: 'bob' } });
    vi.setSystemTime(start + 600_000);
    expect(service.expireWaitingGames()).toBe(0); expect(service.get(waiting.id)).toEqual(active);
  });
  it('starts drafts on publication and never extends the deadline when reopening or publishing again', () => {
    const draft = service.create('chess', 'alice', false);
    expect(draft.waitingExpiresAt).toBeNull();
    vi.setSystemTime(start + 600_000); expect(service.expireWaitingGames()).toBe(0);
    const published = service.publish(draft.id);
    expect(published.waitingExpiresAt).toBe(new Date(start + 780_000).toISOString());
    vi.setSystemTime(start + 660_000);
    expect(service.open(draft.id, 'alice').waitingExpiresAt).toBe(published.waitingExpiresAt);
    expect(service.publish(draft.id).waitingExpiresAt).toBe(published.waitingExpiresAt);
    const openedDraft = service.create('tictactoe', 'alice', false);
    expect(service.open(openedDraft.id, 'alice').waitingExpiresAt).toBe(new Date(start + 840_000).toISOString());
  });
  it('preserves manual cancellation and finished games after the waiting window', () => {
    const waiting = service.create('chess', 'alice');
    const cancelled = service.act(waiting.id, 'alice', action(waiting, 'cancel'));
    const active = started('chess'), finished = service.act(active.id, 'bob', action(active, 'resign'));
    vi.setSystemTime(start + 600_000);
    expect(service.expireWaitingGames()).toBe(0);
    expect(service.get(waiting.id)).toEqual(cancelled); expect(cancelled.result).toBeNull();
    expect(service.get(finished.id)).toEqual(finished);
  });
  it('preserves the original deadline across database restarts and expires after downtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tablemate-expiry-')), path = join(dir, 'games.sqlite');
    let saved = new GameService(openDatabase(path));
    try {
      saved.upsertPlayer({ id: 'alice', name: 'Alice' });
      const waiting = saved.create('tictactoe', 'alice'); saved.db.close();
      vi.setSystemTime(start + 120_000); saved = new GameService(openDatabase(path));
      expect(saved.get(waiting.id)).toEqual(waiting); saved.db.close();
      vi.setSystemTime(start + 180_000); saved = new GameService(openDatabase(path));
      expect(saved.get(waiting.id)).toMatchObject({ status: 'cancelled', version: 1, opponent: null });
    } finally { if (saved.db.open) saved.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
