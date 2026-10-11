import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { WAITING_TIMEOUT_MS } from '../shared/types.js';

export function openDatabase(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Additive migration 1. Keep future migrations numbered with user_version.
  if (Number(db.pragma('user_version', { simple: true })) < 1) db.transaction(() => {
    db.exec(`
      CREATE TABLE players (id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT);
      CREATE TABLE matches (
        id TEXT PRIMARY KEY, game TEXT NOT NULL, creator_id TEXT NOT NULL REFERENCES players(id),
        opponent_id TEXT REFERENCES players(id), status TEXT NOT NULL, state TEXT NOT NULL,
        result TEXT, draw_offer TEXT, version INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX matches_creator ON matches(creator_id, updated_at);
      CREATE INDEX matches_opponent ON matches(opponent_id, updated_at);
      CREATE TABLE moves (
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, number INTEGER NOT NULL,
        seat TEXT NOT NULL, label TEXT NOT NULL, move TEXT NOT NULL, PRIMARY KEY(match_id, number)
      );
      CREATE TABLE actions (
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE, action_id TEXT NOT NULL,
        player_id TEXT NOT NULL REFERENCES players(id), kind TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(match_id, action_id)
      );
      CREATE TABLE message_refs (
        ref TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        chat_id TEXT, message_id INTEGER, inline_message_id TEXT,
        pending INTEGER NOT NULL DEFAULT 1
      );
      PRAGMA user_version = 1;
    `);
  })();
  if (Number(db.pragma('user_version', { simple: true })) < 2) db.transaction(() => {
    db.exec(`
      CREATE TABLE creations (
        player_id TEXT NOT NULL REFERENCES players(id), request_id TEXT NOT NULL,
        game TEXT NOT NULL, match_id TEXT NOT NULL REFERENCES matches(id),
        PRIMARY KEY(player_id, request_id)
      );
      ALTER TABLE message_refs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE message_refs ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX message_refs_due ON message_refs(pending, next_attempt_at, ref);
      CREATE TABLE worker_state (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
      PRAGMA user_version = 2;
    `);
  })();
  if (Number(db.pragma('user_version', { simple: true })) < 3) db.transaction(() => {
    // Draft cleanup must not scan the entire durable creation ledger per deletion.
    db.exec('CREATE INDEX creations_match ON creations(match_id); PRAGMA user_version = 3;');
  })();
  if (Number(db.pragma('user_version', { simple: true })) < 4) db.transaction(() => {
    db.exec(`
      ALTER TABLE matches ADD COLUMN waiting_expires_at TEXT;
      CREATE INDEX matches_waiting_expiry ON matches(waiting_expires_at) WHERE status='waiting' AND opponent_id IS NULL;
      PRAGMA user_version = 4;
    `);
    // Give existing invitations a full joining window when upgrading.
    db.prepare("UPDATE matches SET waiting_expires_at=? WHERE published=1 AND status='waiting' AND opponent_id IS NULL").run(new Date(Date.now() + WAITING_TIMEOUT_MS).toISOString());
  })();
  if (Number(db.pragma('user_version', { simple: true })) < 5) db.transaction(() => {
    db.exec(`
      ALTER TABLE matches ADD COLUMN phase_expires_at TEXT;
      CREATE INDEX matches_mafia_phase ON matches(phase_expires_at) WHERE game='mafia' AND status='active';
      CREATE TABLE match_members (
        match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        player_id TEXT NOT NULL REFERENCES players(id),
        PRIMARY KEY(match_id, player_id)
      );
      CREATE INDEX match_members_player ON match_members(player_id, match_id);
      PRAGMA user_version = 5;
    `);
  })();
  return db;
}
