import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from './db.js';
import { GameService } from './service.js';
import { Chess } from 'chess.js';
it('migrates an existing v1 database without changing matches, moves, actions, or refs; creation retries survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablemate-v1-')), path = join(dir, 'saved.sqlite');
  try {
    const old = new Database(path); old.exec(readFileSync(new URL('./fixtures/v1.sql', import.meta.url), 'utf8'));
    old.prepare('INSERT INTO players VALUES(?,?,NULL)').run('alice', 'Alice'); old.prepare('INSERT INTO players VALUES(?,?,NULL)').run('bob', 'Bob');
    const chess = new Chess(); chess.move('e4');
    const id = 'existing-match-1', state = JSON.stringify({ kind: 'chess', fen: chess.fen(), moves: chess.history() });
    old.prepare("INSERT INTO matches(id,game,creator_id,opponent_id,status,state,version,created_at,updated_at) VALUES(?,'chess','alice','bob','active',?,2,?,?)").run(id, state, '2026-01-01', '2026-01-01');
    const action = { kind: 'move' as const, actionId: randomUUID(), version: 1, move: { kind: 'chess' as const, from: 'e2', to: 'e4' } };
    old.prepare('INSERT INTO moves VALUES(?,1,?,?,?)').run(id, 'first', 'e4', JSON.stringify(action.move));
    old.prepare('INSERT INTO actions VALUES(?,?,?,?,?)').run(id, action.actionId, 'alice', 'move', JSON.stringify({ kind: 'move', move: action.move }));
    old.prepare('INSERT INTO message_refs(ref,match_id,inline_message_id) VALUES(?,?,?)').run('inline', id, 'inline'); old.close();
    let service = new GameService(openDatabase(path));
    expect(service.db.pragma('user_version', { simple: true })).toBe(3);
    expect(service.get(id)).toMatchObject({ version: 2, state: JSON.parse(state), history: [{ number: 1, seat: 'first', label: 'e4' }] });
    expect(service.act(id, 'alice', action).history).toHaveLength(1); expect(service.pendingMessages()[0]).toMatchObject({ ref: 'inline', attempts: 0, next_attempt_at: 0 });
    const requestId = randomUUID(), created = service.create('chess', 'alice', true, requestId);
    service.db.close(); service = new GameService(openDatabase(path));
    expect(service.create('chess', 'alice', true, requestId).id).toBe(created.id);
    expect(() => service.create('checkers', 'alice', true, requestId)).toThrow('already used');
    expect(service.creation('alice', requestId).id).toBe(created.id);
    expect(() => service.creation('bob', requestId)).toThrow('not been saved'); service.db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
