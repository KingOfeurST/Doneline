import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { v4 as uuid } from 'uuid'
import { getDb, activeDbPath } from './db.js'
import { dataDir } from './paths.js'

type Value = string | number | null
interface TableSnapshot { columns: string[]; rows: Value[][] }
interface BackupDocument {
  format: 'doneline-backup'
  version: 1
  id: string
  createdAt: string
  reason: 'daily' | 'manual' | 'before-restore'
  tables: Record<string, TableSnapshot>
}
export interface BackupInfo {
  id: string
  createdAt: string
  reason: BackupDocument['reason']
  sizeBytes: number
}

const MAX_BACKUP_BYTES = 128 * 1024 * 1024
const CALENDAR_STATE = new Set(['calendar_tombstones', 'calendar_resources', 'calendar_resource_changes'])
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`
const backupDirectory = () => path.join(dataDir(), 'backups', createHash('sha256').update(path.resolve(activeDbPath())).digest('hex').slice(0, 20))
function filename(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('Choose an existing Doneline backup.')
  return path.join(backupDirectory(), `${id}.doneline-backup.json`)
}
function applicationTables(): string[] {
  return (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
    .map(table => table.name).filter(name => !name.startsWith('sqlite_') && !name.startsWith('__sync_'))
}
function columnsFor(table: string): string[] {
  return (getDb().prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map(column => column.name)
}

function readDocument(id: string): { document: BackupDocument; bytes: number } {
  const file = filename(id)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BACKUP_BYTES) throw new Error('This backup is not a supported Doneline data file.')
  const document = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupDocument
  if (document.format !== 'doneline-backup' || document.version !== 1 || document.id !== id ||
    !Number.isFinite(new Date(document.createdAt).getTime()) || !['daily', 'manual', 'before-restore'].includes(document.reason) ||
    !document.tables || typeof document.tables !== 'object' || Array.isArray(document.tables)) throw new Error('This backup is invalid or from an unsupported version.')
  return { document, bytes: stat.size }
}

/** Backups are local snapshots; device sync identity and queued replication are never imported. */
export function createBackup(reason: BackupDocument['reason'] = 'manual', now = new Date()): BackupInfo {
  const db = getDb()
  if (db.inTransaction) throw new Error('Finish the current change before creating a backup.')
  const createdAt = now.toISOString()
  const id = `${createdAt.replaceAll(':', '-').replace('.', '-')}-${uuid().slice(0, 8)}`
  const tables = db.transaction(() => Object.fromEntries(applicationTables().filter(table => !CALENDAR_STATE.has(table)).map(table => {
    const columns = columnsFor(table)
    const rows = db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)}${table === 'settings' ? " WHERE key NOT LIKE 'caldav:%'" : ''}`).raw().all() as Value[][]
    return [table, { columns, rows }]
  }))).deferred()
  const document: BackupDocument = { format: 'doneline-backup', version: 1, id, createdAt, reason, tables }
  const content = JSON.stringify(document)
  const sizeBytes = Buffer.byteLength(content)
  if (sizeBytes > MAX_BACKUP_BYTES) throw new Error('This workspace is too large for the current backup format.')
  const directory = backupDirectory()
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = filename(id)
  const temporary = `${file}.partial`
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, content, 'utf8')
      fs.fsyncSync(descriptor)
    } finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, file)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
  return { id, createdAt, reason, sizeBytes }
}

export function listBackups(): BackupInfo[] {
  const directory = backupDirectory()
  if (!fs.existsSync(directory)) return []
  const result: BackupInfo[] = []
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.doneline-backup.json')) continue
    const id = file.slice(0, -'.doneline-backup.json'.length)
    try {
      const { document, bytes } = readDocument(id)
      result.push({ id, createdAt: document.createdAt, reason: document.reason, sizeBytes: bytes })
    } catch { /* An incomplete or unrelated file is never offered for restore. */ }
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** One automatic snapshot per local day, retained for thirty days. Manual and safety copies stay. */
export function ensureDailyBackup(now = new Date()): BackupInfo {
  const localDay = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
  const existing = listBackups().find(backup => backup.reason === 'daily' && localDay(new Date(backup.createdAt)) === localDay(now))
  const backup = existing ?? createBackup('daily', now)
  const cutoff = now.getTime() - 30 * 86_400_000
  for (const item of listBackups()) if (item.reason === 'daily' && new Date(item.createdAt).getTime() < cutoff) fs.unlinkSync(filename(item.id))
  return backup
}

function validateSnapshot(document: BackupDocument): void {
  const currentTables = applicationTables().filter(table => !CALENDAR_STATE.has(table))
  const backupTables = Object.keys(document.tables)
  if (backupTables.some(table => !currentTables.includes(table)) || !['people', 'goals', 'todos', 'events', 'daily_notes', 'settings'].every(table => backupTables.includes(table))) {
    throw new Error('This backup does not match the app’s data format. No data was changed.')
  }
  for (const [table, snapshot] of Object.entries(document.tables)) {
    const allowed = columnsFor(table)
    if (!snapshot || !Array.isArray(snapshot.columns) || !Array.isArray(snapshot.rows) || snapshot.columns.length === 0 ||
      new Set(snapshot.columns).size !== snapshot.columns.length || snapshot.columns.some(column => typeof column !== 'string' || !allowed.includes(column)) ||
      snapshot.rows.some(row => !Array.isArray(row) || row.length !== snapshot.columns.length || row.some(value =>
        value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))))) {
      throw new Error('This backup contains invalid data. No data was changed.')
    }
    const schema = getDb().prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string; notnull: number; pk: number; dflt_value: unknown }[]
    for (const column of schema.filter(column => column.pk || column.notnull)) {
      const index = snapshot.columns.indexOf(column.name)
      if ((index < 0 && (column.pk || column.dflt_value === null)) ||
        (index >= 0 && snapshot.rows.some(row => row[index] === null || (column.pk && row[index] === '')))) {
        throw new Error('This backup is missing required data. No data was changed.')
      }
    }
  }
  const people = document.tables.people
  if (people.rows.length === 0) throw new Error('A backup must contain at least one profile.')
  const settings = document.tables.settings
  const keyIndex = settings.columns.indexOf('key')
  if (settings.rows.some(row => String(row[keyIndex]).startsWith('caldav:'))) {
    throw new Error('Calendar connections are managed separately from backups. No data was changed.')
  }
}

/** Atomically restore app rows in place while keeping the current device’s sync connection. */
export function restoreBackup(id: string): { safetyBackup: BackupInfo; restoredAt: string } {
  const { document } = readDocument(id)
  validateSnapshot(document)
  const db = getDb()
  if (db.inTransaction) throw new Error('Finish the current change before restoring a backup.')
  const safetyBackup = createBackup('before-restore')
  const calendarConnections = db.prepare("SELECT key,value FROM settings WHERE key LIKE 'caldav:%'").all() as { key: string; value: string }[]
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON')
    const tables = applicationTables()
    // FK checks are deferred until the complete snapshot has been installed.
    for (const table of tables) db.prepare(`DELETE FROM ${quote(table)}`).run()
    for (const [table, snapshot] of Object.entries(document.tables)) {
      const statement = db.prepare(`INSERT INTO ${quote(table)} (${snapshot.columns.map(quote).join(',')}) VALUES (${snapshot.columns.map(() => '?').join(',')})`)
      for (const row of snapshot.rows) statement.run(...row)
    }
    for (const connection of calendarConnections) if (db.prepare('SELECT 1 FROM people WHERE id = ?').get(connection.key.slice('caldav:'.length))) {
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run(connection.key, connection.value)
    }
    // Fresh calendar sync decides whether each original remote identity still exists.
    db.prepare('UPDATE events SET calendar_dirty = 1, calendar_restore = 1 WHERE caldav_uid IS NOT NULL').run()
  }).immediate()
  return { safetyBackup, restoredAt: new Date().toISOString() }
}
