/** Always equals MIGRATIONS.length; migrations are append-only and never destructive. */
export const SCHEMA_VERSION = 2;

export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     title TEXT NOT NULL,
     cwd TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     session_id TEXT NOT NULL REFERENCES sessions(id),
     ts TEXT NOT NULL,
     node_id TEXT,
     provider TEXT,
     model TEXT,
     type TEXT NOT NULL CHECK (type IN ('routing','call','response','tool','intervention','error')),
     payload TEXT NOT NULL,
     cost_usd REAL,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);`,
  // v2 (phase 1): indexes for budget spend queries (by month and by project).
  `CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
   CREATE INDEX IF NOT EXISTS sessions_cwd ON sessions(cwd);`,
];
