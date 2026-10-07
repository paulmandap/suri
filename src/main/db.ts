import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// Suri's history database (ADR-020). node:sqlite is built into Electron's Node
// and into the Node that runs the tests, so there's no native module to build
// twice (better-sqlite3 would need one build per Node ABI). Main only.

/**
 * One entry per schema version, applied in order. Never edit a shipped one:
 * add a new entry, so a database from any older Suri catches up.
 */
export const MIGRATIONS: readonly string[] = [
  `
  -- A turn runs from a prompt to Stop. Claude Code's prompt_id names it when sent.
  CREATE TABLE turns (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    prompt_id TEXT,
    cwd TEXT NOT NULL,
    project TEXT NOT NULL,
    day TEXT NOT NULL,
    prompt TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    last_message TEXT,
    error TEXT,
    facts TEXT,
    recap TEXT,
    recap_state TEXT,
    recap_note TEXT
  );
  CREATE UNIQUE INDEX turns_by_prompt ON turns (session_id, prompt_id);
  CREATE INDEX turns_by_session ON turns (session_id, started_at);
  CREATE INDEX turns_by_day ON turns (day);

  -- One row per tool call: PreToolUse adds it, PostToolUse settles it.
  CREATE TABLE steps (
    id INTEGER PRIMARY KEY,
    turn_id INTEGER NOT NULL REFERENCES turns (id) ON DELETE CASCADE,
    tool_use_id TEXT,
    tool TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    added INTEGER,
    removed INTEGER,
    error TEXT
  );
  CREATE INDEX steps_by_turn ON steps (turn_id);
  CREATE INDEX steps_by_tool_use ON steps (tool_use_id);
  CREATE INDEX steps_by_start ON steps (started_at);

  -- How each request Suri held ended: Paul's click, a time-out, or Claude Code leaving.
  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_id INTEGER REFERENCES turns (id) ON DELETE SET NULL,
    day TEXT NOT NULL,
    tool TEXT NOT NULL,
    detail TEXT NOT NULL,
    level TEXT,
    outcome TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    answered_at INTEGER NOT NULL
  );
  CREATE INDEX decisions_by_turn ON decisions (turn_id);
  CREATE INDEX decisions_by_day ON decisions (day);

  CREATE TABLE digests (
    day TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `
]

/** The database was written by a newer Suri; this one leaves it alone. */
export class NewerDatabaseError extends Error {
  constructor(version: number) {
    super(`The history was saved by a newer Suri (schema ${version}).`)
    this.name = 'NewerDatabaseError'
  }
}

/** Opens (or creates) the database and brings its schema up to date. */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  // Suri is the only writer, so a wait only happens when another program (a
  // database viewer) holds the file. Recording runs before a hook's answer, so
  // it gives up quickly: a missed event beats a slow Claude Code.
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, timeout: 250 })
  try {
    // WAL + NORMAL: a write doesn't wait for the disk on every event, and a
    // crash loses at most the last moments, never the file.
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    migrate(db)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

/** Applies the migrations this database hasn't seen. Returns the schema version. */
export function migrate(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  const version = row.user_version
  if (version > MIGRATIONS.length) throw new NewerDatabaseError(version)
  for (let next = version; next < MIGRATIONS.length; next++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[next] ?? '')
      db.exec(`PRAGMA user_version = ${next + 1}`)
    })
  }
  return MIGRATIONS.length
}

/** Runs `fn` in one transaction, or inside the one already open. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

/** SQLite's own codes for a file that isn't a database (26) or is damaged (11). */
export function isDamaged(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode
  return code === 11 || code === 26
}
