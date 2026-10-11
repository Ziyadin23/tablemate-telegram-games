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
