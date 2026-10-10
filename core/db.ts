import fs from 'node:fs'
import path from 'node:path'
import Database from 'libsql'
import { v4 as uuid, v5 as stableUuid } from 'uuid'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { dataDir, dbPath } from './paths.js'
import { getSyncConfig, type SyncConfig } from './config.js'
import { installSyncJournal, pendingSyncChanges, remoteTransaction, syncOfflineWorkspace } from './offlineSync.js'
import { backfillRecurrenceExclusions } from './exclusions.js'

type DB = InstanceType<typeof Database>

let _db: DB | null = null
let _cloud = false
let _openedPath: string | null = null
let _openedSyncConfig: SyncConfig | null = null
let _syncInFlight: Promise<boolean> | null = null
let _initInFlight: Promise<void> | null = null
let _initialized = false
let _syncRequested = false
let _lastSyncError: string | null = null
let _syncing = false
const syncListeners = new Set<(status: WorkspaceSyncStatus) => void>()

export interface WorkspaceSyncStatus {
  state: 'local' | 'pending' | 'syncing' | 'synced' | 'offline' | 'error'
  cloud: boolean
  pending: number
  lastSyncedAt: string | null
  message?: string
}

/** Cloud mode uses a separate replica file so it never clashes with a plain
 *  local database created during offline use. */
const replicaPath = () => path.join(dataDir(), 'doneline-replica.db')
function defaultProfileIds(): [string, string] {
  const cfg = _cloud ? _openedSyncConfig : null
  if (!cfg) return [uuid(), uuid()]
  const workspace = cfg.syncUrl.replace(/\/$/, '').toLowerCase()
  return [stableUuid(`doneline:${workspace}:me`, stableUuid.URL), stableUuid(`doneline:${workspace}:friend`, stableUuid.URL)]
}
function configuredDbPath(cfg = getSyncConfig()): string {
  if (!cfg) return dbPath()
  const hash = createHash('sha256').update(cfg.syncUrl.replace(/\/$/, '').toLowerCase()).digest('hex').slice(0, 20)
  return path.join(dataDir(), `doneline-workspace-${hash}.db`)
}
/** Config changes precede async reopening; backups must still name the open DB. */
export const activeDbPath = () => _db && _openedPath ? _openedPath : configuredDbPath()

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
  kind        TEXT NOT NULL DEFAULT 'message',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  seen        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_notes (
  day        TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, person_id)
);

CREATE TABLE IF NOT EXISTS todo_completions (
  todo_id      TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (todo_id, person_id)
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL,
  task_id     TEXT,
  duration_seconds INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS reactions (
  id         TEXT PRIMARY KEY,
  todo_id    TEXT NOT NULL,
  person_id  TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(todo_id, person_id, emoji)
);

CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(due_at);
CREATE INDEX IF NOT EXISTS idx_todos_completed ON todos(completed_at);
CREATE INDEX IF NOT EXISTS idx_todos_goal ON todos(goal_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_reactions_todo ON reactions(todo_id);
CREATE INDEX IF NOT EXISTS idx_nudges_to ON nudges(to_person, seen);

CREATE TABLE IF NOT EXISTS calendar_tombstones (
  person_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  recurrence_id TEXT NOT NULL DEFAULT '',
  url TEXT,
  etag TEXT,
  PRIMARY KEY (person_id, uid, recurrence_id)
);
CREATE TABLE IF NOT EXISTS calendar_resources (
  person_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  url TEXT,
  etag TEXT,
  ics TEXT NOT NULL,
  PRIMARY KEY (person_id, uid)
);
CREATE TABLE IF NOT EXISTS calendar_resource_changes (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  url TEXT,
  patch TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trash_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('task','event')),
  item_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  title TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash_items(deleted_at);

CREATE TABLE IF NOT EXISTS recurrence_exclusions (
  kind TEXT NOT NULL CHECK(kind IN ('task','event')),
  parent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  excluded INTEGER NOT NULL CHECK(excluded IN (0,1)),
  PRIMARY KEY(kind,parent_id,day)
);
`

/** Add a column if it isn't already present (idempotent migration helper). */
function ensureColumn(db: DB, table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

function migrate(db: DB, seed = true): void {
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

  // v3: events shared with everyone (show for both people).
  ensureColumn(db, 'events', 'shared', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'events', 'calendar_dirty', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'events', 'caldav_recurrence_id', 'TEXT')
  ensureColumn(db, 'events', 'calendar_restore', 'INTEGER NOT NULL DEFAULT 0')

  // v4: nudge kind — 'message' (text) or 'buzz' (window shake).
  ensureColumn(db, 'nudges', 'kind', "TEXT NOT NULL DEFAULT 'message'")

  // Seed the two default people if the table is empty.
  const count = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
  if (count === 0 && seed) {
    const [me, friend] = defaultProfileIds()
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
  db.exec('CREATE INDEX IF NOT EXISTS idx_events_recur_start ON events(recur_parent, starts_at)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_todos_recur_due ON todos(recur_parent, due_at)')
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'migration:calendar-boundaries-v1'").get()) {
    // Older generated rows omitted the template's shared flag.
    db.exec(`UPDATE events SET shared = (SELECT shared FROM events template WHERE template.id = events.recur_parent)
      WHERE recur_parent IS NOT NULL AND EXISTS (SELECT 1 FROM events template WHERE template.id = events.recur_parent)`)

    // All-day rows used to end at 23:59. Store exclusive midnight boundaries so
    // local views and iCloud agree about the last covered day, including DST.
    const legacy = db.prepare('SELECT id, ends_at FROM events WHERE all_day = 1').all() as { id: string; ends_at: string }[]
    for (const row of legacy) {
      const end = new Date(row.ends_at)
      if (Number.isFinite(end.getTime()) && (end.getHours() || end.getMinutes() || end.getSeconds() || end.getMilliseconds())) {
        end.setDate(end.getDate() + 1)
        end.setHours(0, 0, 0, 0)
        db.prepare('UPDATE events SET ends_at = ? WHERE id = ?').run(end.toISOString(), row.id)
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('migration:calendar-boundaries-v1', 'done')").run()
  }
}

function openConnection(): DB {
  const cfg = getSyncConfig()
  _cloud = !!cfg
  const target = configuredDbPath(cfg)
  // Import the previous read replica without changing it. VACUUM reads a
  // consistent SQLite snapshot, including committed WAL data, into our new file.
  if (cfg && !fs.existsSync(target) && fs.existsSync(replicaPath()) && !fs.readdirSync(dataDir()).some((name) => /^doneline-workspace-.*\.db$/.test(name))) {
    const importing = `${target}.importing-${uuid()}`
    // libsql's JS constructor ignores its declared `readonly` option. SQLite's
    // URI mode is enforced by the native driver and prevents close-time WAL
    // checkpointing from modifying the legacy source on macOS.
    const source = pathToFileURL(replicaPath())
    source.searchParams.set('mode', 'ro')
    const cached = new Database(source.href)
    try {
      cached.prepare('VACUUM INTO ?').run(importing)
      // Publish a fully committed snapshot atomically without replacing a file
      // that another desktop/MCP process has already opened and edited.
      try { fs.linkSync(importing, target) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
    } finally { cached.close(); fs.rmSync(importing, { force: true }) }
  }
  const connection = new Database(target)
  _openedPath = target
  _openedSyncConfig = cfg ? { ...cfg } : null
  return connection
}

function applySchema(db: DB, seed = true): void {
  try { db.pragma('busy_timeout = 5000') } catch { /* replica may not support it */ }
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
  // Desktop and MCP can initialize together; migration/seeding is one write.
  db.transaction(() => migrate(db, seed)).immediate()
}

/**
 * Open the database and prepare the schema. In cloud mode this pulls the latest
 * remote state BEFORE creating/seeding tables (so a second device doesn't
 * re-seed people that already exist), then pushes any local changes back.
 */
async function initialize(): Promise<void> {
  if (!_db) _db = openConnection()
  applySchema(_db, !_cloud)
  if (_cloud) {
    installSyncJournal(_db)
    backfillRecurrenceExclusions(_db)
    const cached = !!_db.prepare('SELECT 1 FROM people LIMIT 1').get()
    if (!cached) {
      // First connection needs a workspace snapshot. Established workspaces
      // reopen entirely from disk and never wait on the network to launch.
      let synchronized = await cloudSync()
      const waitDeadline = Date.now() + 30_000
      while (!synchronized && !_db.prepare('SELECT 1 FROM people LIMIT 1').get()) {
        if (Date.now() >= waitDeadline) throw new Error('Another Doneline process is setting up this workspace. Try again shortly.')
        await new Promise(resolve => setTimeout(resolve, 100))
        synchronized = await cloudSync()
      }
      if (!_db.prepare('SELECT 1 FROM people LIMIT 1').get()) {
        // Bootstrap on the server with deterministic IDs and INSERT OR IGNORE.
        // Two first devices share the same profiles, and a delayed bootstrap
        // cannot replace the other device's freshly edited name/color.
        const [me, friend] = defaultProfileIds()
        const cfg = _openedSyncConfig!
        await remoteTransaction(cfg, [
          { sql: 'INSERT OR IGNORE INTO people(id,name,color,emoji,position) VALUES (?,?,?,?,?)', args: [me, 'Me', '#2f7a4d', '🙂', 0] },
          { sql: 'INSERT OR IGNORE INTO people(id,name,color,emoji,position) VALUES (?,?,?,?,?)', args: [friend, 'Friend', '#9c4a4a', '🧑', 1] }
        ])
        await cloudSync()
      }
      applySchema(_db)
    } else {
      void cloudSync().catch(() => {})
    }
  }
  _initialized = true
}

export function initDb(): Promise<void> {
  if (_initialized) return Promise.resolve()
  if (!_initInFlight) {
    _initInFlight = initialize().finally(() => { _initInFlight = null })
  }
  return _initInFlight
}

export function getDb(): DB {
  if (_db) return _db
  // Lazy fallback (e.g. local-only contexts that never called initDb).
  _db = openConnection()
  applySchema(_db)
  if (_cloud) { installSyncJournal(_db); backfillRecurrenceExclusions(_db) }
  _initialized = true
  return _db
}

/** Pull + push with the shared workspace. No-op (returns false) in local mode. */
export function cloudSync(): Promise<boolean> {
  if (!_db || !_cloud) return Promise.resolve(false)
  if (_syncInFlight) {
    _syncRequested = true
    return _syncInFlight
  }
  const connection = _db
  const cfg = _openedSyncConfig
  if (!cfg) return Promise.resolve(false)
  _syncInFlight = Promise.resolve().then(async () => {
    // Desktop and MCP share one file. A lease prevents an older remote snapshot
    // from another process overwriting a newly acknowledged local edit.
    const leaseOwner = uuid()
    let lease = `${leaseOwner}:${Date.now() + 120_000}`
    const acquired = connection.transaction(() => {
      const current = connection.prepare("SELECT value FROM __sync_meta WHERE key='lease'").get() as { value: string } | undefined
      if (current && Number(current.value.slice(current.value.lastIndexOf(':') + 1)) > Date.now()) return false
      connection.prepare('INSERT OR REPLACE INTO __sync_meta VALUES (?,?)').run('lease', lease)
      return true
    }).immediate()
    if (!acquired) return false
    const verifyLease = () => {
      if (_db !== connection) throw new Error('The workspace changed while syncing. Pending changes remain saved locally.')
      const renewed = `${leaseOwner}:${Date.now() + 120_000}`
      const result = connection.prepare("UPDATE __sync_meta SET value=? WHERE key='lease' AND value=?").run(renewed, lease)
      if (result.changes !== 1) throw new Error('Another process took over workspace sync. Pending changes remain saved locally.')
      lease = renewed
    }
    _syncing = true
    emitSyncStatus()
    try {
      let loops = 0
      do {
        _syncRequested = false
        await syncOfflineWorkspace(connection, cfg, verifyLease)
        const pendingBeforeBackfill = pendingSyncChanges(connection)
        // A fresh device can receive old JSON exclusions in its first pull.
        // Promote those dates only when no independent date record exists.
        backfillRecurrenceExclusions(connection)
        if (pendingSyncChanges(connection) > pendingBeforeBackfill) _syncRequested = true
        loops++
        // Include writes made while the previous pull/push was running.
        // Ongoing typing/focus heartbeats must not keep one sync alive forever.
      } while (_syncRequested && _db === connection && loops < 2)
      _lastSyncError = null
      return _db === connection
    } catch (error) {
      _lastSyncError = error instanceof Error ? error.message : 'Workspace unavailable.'
      throw error
    } finally {
      if (_db === connection) connection.prepare("DELETE FROM __sync_meta WHERE key='lease' AND value=?").run(lease)
      _syncing = false
      emitSyncStatus()
    }
  }).finally(() => { _syncInFlight = null })
  return _syncInFlight
}

export function isCloud(): boolean {
  return _cloud
}

export function getWorkspaceSyncStatus(): WorkspaceSyncStatus {
  if (!_db || !_cloud) return { state: 'local', cloud: false, pending: 0, lastSyncedAt: null }
  const pending = pendingSyncChanges(_db)
  const last = _db.prepare("SELECT value FROM __sync_meta WHERE key='lastSyncedAt'").get() as { value: string } | undefined
  return {
    state: _syncing ? 'syncing' : _lastSyncError ? (/access was rejected|sync failed|Invalid workspace/.test(_lastSyncError) ? 'error' : 'offline') : pending ? 'pending' : last ? 'synced' : 'pending',
    cloud: true, pending, lastSyncedAt: last?.value ?? null,
    ...(_lastSyncError ? { message: _lastSyncError } : {})
  }
}

function emitSyncStatus(): void {
  const status = getWorkspaceSyncStatus()
  for (const listener of syncListeners) listener(status)
}

export function onWorkspaceSyncStatus(listener: (status: WorkspaceSyncStatus) => void): () => void {
  syncListeners.add(listener)
  return () => { syncListeners.delete(listener) }
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
    _cloud = false
    _initialized = false
    _lastSyncError = null
    _syncing = false
  }
  _openedPath = null
  _openedSyncConfig = null
}

/** Re-open after the workspace connection changed (connect / disconnect). */
export async function reopenDb(): Promise<void> {
  await _initInFlight?.catch(() => {})
  await _syncInFlight?.catch(() => {})
  closeDb()
  await initDb()
}

/** Validate workspace credentials by opening a throwaway replica and syncing. */
export async function testWorkspace(cfg: { syncUrl: string; authToken: string }): Promise<void> {
  await remoteTransaction(cfg, [{ sql: 'SELECT 1 AS connected' }], false)
}
