import fs from 'node:fs'
import path from 'node:path'
import Database from 'libsql'
import { v4 as uuid } from 'uuid'
import { dataDir, dbPath } from './paths.js'
import { getSyncConfig } from './config.js'

type DB = InstanceType<typeof Database>

// libsql's bundled types know `syncUrl` but omit `authToken` (valid at runtime
// for embedded replicas), so widen the options type here.
type ReplicaOptions = Database.Options & { authToken?: string }

let _db: DB | null = null
let _cloud = false

/** Cloud mode uses a separate replica file so it never clashes with a plain
 *  local database created during offline use. */
const replicaPath = () => path.join(dataDir(), 'doneline-replica.db')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#2f7a4d',
  emoji       TEXT NOT NULL DEFAULT '🙂',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  color       TEXT NOT NULL DEFAULT '#2f7a4d',
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS todos (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  goal_id      TEXT REFERENCES goals(id) ON DELETE SET NULL,
  notes        TEXT,
  due_at       TEXT,
  completed_at TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  location    TEXT,
  notes       TEXT,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  all_day     INTEGER NOT NULL DEFAULT 0,
  color       TEXT NOT NULL DEFAULT '#2f7a4d',
  attendees   TEXT,
  caldav_uid  TEXT,
  caldav_etag TEXT,
  caldav_url  TEXT,
  source      TEXT NOT NULL DEFAULT 'local',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS presence (
  person_id  TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'idle',
  phase      TEXT,
  task_title TEXT,
  ends_at    TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nudges (
  id          TEXT PRIMARY KEY,
  from_person TEXT NOT NULL,
  to_person   TEXT NOT NULL,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  seen        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS todo_completions (
  todo_id      TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (todo_id, person_id)
);

CREATE TABLE IF NOT EXISTS focus_invites (
  id          TEXT PRIMARY KEY,
  from_person TEXT NOT NULL,
  to_person   TEXT NOT NULL,
  focus_min   INTEGER NOT NULL,
  break_min   INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  seen        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);
CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed_at);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at);
`

/** Add a column if it isn't already present (idempotent migration helper). */
function ensureColumn(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function migrate(db: DB): void {
  // person_id was added after the first release — backfill existing rows.
  ensureColumn(db, 'todos', 'person_id', 'TEXT')
  ensureColumn(db, 'goals', 'person_id', 'TEXT')
  ensureColumn(db, 'events', 'person_id', 'TEXT')

  // v2: archiving + recurrence.
  ensureColumn(db, 'todos', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'todos', 'recurrence', 'TEXT')
  ensureColumn(db, 'todos', 'recur_parent', 'TEXT')
  ensureColumn(db, 'events', 'recurrence', 'TEXT')
  ensureColumn(db, 'events', 'recur_parent', 'TEXT')

  // v3: shared goals (todos under them require every person to complete).
  ensureColumn(db, 'goals', 'shared', 'INTEGER NOT NULL DEFAULT 0')

  // v3: co-focus — invite acceptance + a shared start anchor for simultaneous start.
  ensureColumn(db, 'focus_invites', 'accepted', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'focus_invites', 'started_at', 'TEXT')

  // Seed the two default people if the table is empty.
  const count = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
  if (count === 0) {
    const me = uuid()
    const friend = uuid()
    const insert = db.prepare(
      'INSERT INTO people (id, name, color, emoji, position) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run(me, 'Me', '#2f7a4d', '🙂', 0)
    insert.run(friend, 'Friend', '#9c4a4a', '🧑', 1)
  }

  // Attach any orphan rows to the primary person.
  const primary = db.prepare('SELECT id FROM people ORDER BY position, created_at LIMIT 1').get() as
    | { id: string }
    | undefined
  if (primary) {
    db.prepare('UPDATE todos SET person_id = ? WHERE person_id IS NULL').run(primary.id)
    db.prepare('UPDATE goals SET person_id = ? WHERE person_id IS NULL').run(primary.id)
    db.prepare('UPDATE events SET person_id = ? WHERE person_id IS NULL').run(primary.id)
  }

  // UID uniqueness is per person (two profiles may sync the same shared calendar),
  // so drop any old global-unique index and index by (person_id, uid) instead.
  db.exec('DROP INDEX IF EXISTS idx_events_uid')
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_person_uid ON events(person_id, caldav_uid)')
}

function openConnection(): DB {
  const cfg = getSyncConfig()
  if (cfg) {
    _cloud = true
    // Embedded replica: local file kept in sync with the shared Turso database.
    const opts: ReplicaOptions = { syncUrl: cfg.syncUrl, authToken: cfg.authToken }
    return new Database(replicaPath(), opts)
  }
  _cloud = false
  return new Database(dbPath())
}

function applySchema(db: DB): void {
  // Pragmas can be rejected by replica connections — never let that be fatal.
  try {
    db.pragma('journal_mode = WAL')
  } catch {
    /* not supported in this mode */
  }
  try {
    db.pragma('foreign_keys = ON')
  } catch {
    /* ignore */
  }
  db.exec(SCHEMA)
  migrate(db)
}

/**
 * Open the database and prepare the schema. In cloud mode this pulls the latest
 * remote state BEFORE creating/seeding tables (so a second device doesn't
 * re-seed people that already exist), then pushes any local changes back.
 */
export async function initDb(): Promise<void> {
  if (!_db) _db = openConnection()
  if (_cloud) {
    try {
      await _db.sync()
    } catch (err) {
      console.error('[doneline] initial cloud sync failed:', err)
    }
  }
  applySchema(_db)
  if (_cloud) {
    try {
      await _db.sync()
    } catch (err) {
      console.error('[doneline] post-setup cloud sync failed:', err)
    }
  }
}

export function getDb(): DB {
  if (_db) return _db
  // Lazy fallback (e.g. local-only contexts that never called initDb).
  _db = openConnection()
  applySchema(_db)
  return _db
}

/** Pull + push with the shared workspace. No-op (returns false) in local mode. */
export async function cloudSync(): Promise<boolean> {
  if (!_db || !_cloud) return false
  await _db.sync()
  return true
}

export function isCloud(): boolean {
  return _cloud
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
    _cloud = false
  }
}

/** Re-open after the workspace connection changed (connect / disconnect). */
export async function reopenDb(): Promise<void> {
  closeDb()
  await initDb()
}

/** Validate workspace credentials by opening a throwaway replica and syncing. */
export async function testWorkspace(cfg: { syncUrl: string; authToken: string }): Promise<void> {
  const testPath = path.join(dataDir(), 'doneline-conntest.db')
  const opts: ReplicaOptions = { syncUrl: cfg.syncUrl, authToken: cfg.authToken }
  const tmp = new Database(testPath, opts)
  try {
    await tmp.sync()
  } finally {
    tmp.close()
    for (const suffix of ['', '-wal', '-shm', '-client_wal_index']) {
      try {
        fs.unlinkSync(testPath + suffix)
      } catch {
        /* ignore */
      }
    }
  }
}
