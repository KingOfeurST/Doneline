import type Database from 'libsql'
import type { SyncConfig } from './config.js'
import { randomUUID } from 'node:crypto'

type DB = InstanceType<typeof Database>
type Row = Record<string, string | number | null>
export type SyncStatement = { sql: string; args?: (string | number | null)[] }
type Column = { name: string; type: string; pk: number; notnull: number; dflt_value: string | null }
type Table = { name: string; sql: string; columns: Column[]; keys: string[] }
type Change = { seq: number; operation_id: string; table_name: string; key_json: string; row_json: string | null }

// Device journals and Trash are local. Calendar credentials are stored in settings
// by the existing app; the sync table list preserves the existing workspace surface.
export const SYNC_TABLES = ['people', 'goals', 'todos', 'events', 'settings', 'presence', 'nudges', 'daily_notes', 'todo_completions', 'focus_sessions', 'focus_invites', 'reactions', 'calendar_tombstones', 'calendar_resources', 'calendar_resource_changes', 'recurrence_exclusions'] as const
const ident = (name: string) => `"${name.replaceAll('"', '""')}"`
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

function tables(db: DB): Table[] {
  return SYNC_TABLES.map((name) => {
    const columns = db.prepare(`PRAGMA table_info(${ident(name)})`).all() as Column[]
    const definition = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', name) as { sql: string }
    // Reactions have random display IDs but one logical row per author/emoji.
    // Matching only the ID breaks when two offline clients add the same reaction.
    const keys = name === 'reactions' ? ['todo_id', 'person_id', 'emoji'] : columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name)
    return { name, sql: definition.sql, columns, keys }
  })
}

/** Triggers capture desktop, MCP and background writes in the SAME transaction.
 * An outage or process exit therefore cannot lose an acknowledged mutation. */
export function installSyncJournal(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS __sync_control (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL);
    INSERT OR IGNORE INTO __sync_control VALUES (1,1);
    CREATE TABLE IF NOT EXISTS __sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS __sync_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, table_name TEXT NOT NULL, key_json TEXT NOT NULL, row_json TEXT);
    CREATE INDEX IF NOT EXISTS __sync_pending_key ON __sync_outbox(table_name,key_json);`)
  if (!db.prepare("SELECT 1 FROM __sync_meta WHERE key='device'").get()) {
    db.prepare('INSERT OR IGNORE INTO __sync_meta VALUES (?,?)').run('device', randomUUID())
  }
  for (const table of tables(db)) {
    const json = (names: string[], prefix: string) => `json_object(${names.map((name) => `${literal(name)},${prefix}.${ident(name)}`).join(',')})`
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const prefix = action === 'DELETE' ? 'OLD' : 'NEW'
      const row = action === 'DELETE' ? 'NULL' : json(table.columns.map((c) => c.name), prefix)
      const name = `__sync_${table.name}_${action.toLowerCase()}`
      db.exec(`DROP TRIGGER IF EXISTS ${ident(name)};
        CREATE TRIGGER ${ident(name)} AFTER ${action} ON ${ident(table.name)}
        WHEN (SELECT enabled FROM __sync_control WHERE id=1)=1 BEGIN
          INSERT INTO __sync_outbox(operation_id,table_name,key_json,row_json)
          VALUES ((SELECT value FROM __sync_meta WHERE key='device') || ':' || lower(hex(randomblob(16))),${literal(table.name)},${json(table.keys, prefix)},${row});
        END;`)
    }
  }
}

export function pendingSyncChanges(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM __sync_outbox').get() as { n: number }).n
}

export function syncEndpoint(syncUrl: string): string {
  const url = new URL(syncUrl.replace(/^libsql:/, 'https:'))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid workspace URL.')
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v2/pipeline`
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Minimal official Hrana HTTP batch: dependent steps + conditional rollback
 * ensure that a failed statement never leaves a partially committed write. */
export async function remoteTransaction(cfg: SyncConfig, statements: SyncStatement[], write = true): Promise<Row[][]> {
  const encode = (value: string | number | null) => value === null ? { type: 'null' } : typeof value === 'string'
    ? { type: 'text', value } : Number.isInteger(value) ? { type: 'integer', value: String(value) } : { type: 'float', value }
  const input = [{ sql: write ? 'BEGIN IMMEDIATE' : 'BEGIN' }, ...statements, { sql: 'COMMIT' }]
  const steps: unknown[] = input.map((stmt, i) => ({
    ...(i ? { condition: { type: 'ok', step: i - 1 } } : {}),
    stmt: { sql: stmt.sql, args: ('args' in stmt ? stmt.args : undefined)?.map(encode) ?? [], want_rows: true }
  }))
  steps.push({ condition: { type: 'not', cond: { type: 'ok', step: input.length - 1 } }, stmt: { sql: 'ROLLBACK', args: [], want_rows: false } })
  const response = await fetch(syncEndpoint(cfg.syncUrl), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.authToken}` },
    body: JSON.stringify({ baton: null, requests: [{ type: 'batch', batch: { steps } }, { type: 'close' }] }),
    signal: AbortSignal.timeout(10_000), redirect: 'error'
  })
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Workspace access was rejected. Check your connect code.' : `Workspace unavailable (HTTP ${response.status}).`)
  const payload = await response.json() as {
    results?: { type: string; error?: { message: string }; response?: { result?: { step_results: ({ cols: { name: string }[]; rows: { type: string; value?: string | number }[][] } | null)[]; step_errors: ({ message: string } | null)[] } } }[]
  }
  const result = payload.results?.[0]
  if (result?.type !== 'ok' || !result.response?.result) throw new Error(result?.error?.message ?? 'Invalid workspace response.')
  const batch = result.response.result
  const error = batch.step_errors.find((value) => value)
  if (error) throw new Error(`Workspace sync failed: ${error.message}`)
  if (!batch.step_results[input.length - 1]) throw new Error('Workspace transaction did not commit.')
  return statements.map((_statement, i) => {
    const step = batch.step_results[i + 1]
    if (!step) throw new Error('Workspace statement was skipped.')
    return step.rows.map((row) => Object.fromEntries(step.cols.map((col, at) => {
      const value = row[at]
      return [col.name, value.type === 'null' ? null : value.type === 'integer' || value.type === 'float' ? Number(value.value) : String(value.value ?? '')]
    })))
  })
}

async function ensureRemoteSchema(cfg: SyncConfig, definitions: Table[]): Promise<void> {
  const existing = await remoteTransaction(cfg, definitions.map((t) => ({ sql: `PRAGMA table_info(${ident(t.name)})` })), false)
  const statements: SyncStatement[] = []
  definitions.forEach((t, i) => {
    if (!existing[i].length) statements.push({ sql: t.sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ') })
    else for (const c of t.columns) {
      if (!existing[i].some((old) => old.name === c.name)) {
        statements.push({ sql: `ALTER TABLE ${ident(t.name)} ADD COLUMN ${ident(c.name)} ${c.type}${c.notnull && c.dflt_value !== null ? ' NOT NULL' : ''}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ''}` })
      }
    }
  })
  statements.push({ sql: 'CREATE TABLE IF NOT EXISTS doneline_sync_operations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))' })
  await remoteTransaction(cfg, statements)
}

function mutation(change: Change, table: Table): SyncStatement {
  const key = JSON.parse(change.key_json) as Row
  const guard = 'NOT EXISTS (SELECT 1 FROM doneline_sync_operations WHERE id=?)'
  if (change.row_json === null) {
    return { sql: `DELETE FROM ${ident(table.name)} WHERE ${table.keys.map((name) => `${ident(name)} IS ?`).join(' AND ')} AND ${guard}`, args: [...table.keys.map((name) => key[name]), change.operation_id] }
  }
  const row = JSON.parse(change.row_json) as Row
  const columns = table.columns.map((c) => c.name)
  const nonkeys = columns.filter((c) => !table.keys.includes(c))
  return {
    sql: `INSERT INTO ${ident(table.name)} (${columns.map(ident).join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE ${guard}
      ON CONFLICT (${table.keys.map(ident).join(',')}) ${nonkeys.length ? `DO UPDATE SET ${nonkeys.map((name) => `${ident(name)}=excluded.${ident(name)}`).join(',')}` : 'DO NOTHING'}`,
    args: [...columns.map((name) => row[name]), change.operation_id]
  }
}

function pullSnapshot(db: DB, definitions: Table[], snapshot: Row[][]): void {
  db.transaction(() => {
    db.prepare('UPDATE __sync_control SET enabled=0 WHERE id=1').run()
    const pending = db.prepare('SELECT table_name,key_json,row_json FROM __sync_outbox').all() as Change[]
    const protectedKeys = new Map<string, Set<string>>()
    for (const change of pending) {
      const keys = protectedKeys.get(change.table_name) ?? new Set<string>()
      keys.add(change.key_json); protectedKeys.set(change.table_name, keys)
      // Keep local parents needed by edits made while this snapshot downloaded.
      if (change.row_json) {
        const row = JSON.parse(change.row_json) as Row
        for (const [parent, field] of [['people', 'person_id'], ['goals', 'goal_id'], ['todos', 'todo_id'], ['todos', 'task_id']] as const) {
          if (row[field]) {
            const parentKeys = protectedKeys.get(parent) ?? new Set<string>()
            parentKeys.add(JSON.stringify({ id: row[field] })); protectedKeys.set(parent, parentKeys)
          }
        }
      }
    }
    definitions.forEach((table, index) => {
      const keyFor = (row: Row) => JSON.stringify(Object.fromEntries(table.keys.map((name) => [name, row[name]])))
      const protectedSet = protectedKeys.get(table.name) ?? new Set<string>()
      const incomingKeys = new Set(snapshot[index].map(keyFor))
      // Delete children before parents below, after all incoming parents exist.
      const columns = table.columns.map((c) => c.name)
      const nonkeys = columns.filter((c) => !table.keys.includes(c))
      const insert = db.prepare(`INSERT INTO ${ident(table.name)} (${columns.map(ident).join(',')}) VALUES (${columns.map(() => '?').join(',')})
        ON CONFLICT (${table.keys.map(ident).join(',')}) ${nonkeys.length ? `DO UPDATE SET ${nonkeys.map((name) => `${ident(name)}=excluded.${ident(name)}`).join(',')}` : 'DO NOTHING'}`)
      for (const row of snapshot[index]) if (!protectedSet.has(keyFor(row))) insert.run(...columns.map((name) => row[name]))
      incomingKeys.forEach((key) => protectedSet.add(key))
      protectedKeys.set(table.name, protectedSet)
    })
    for (const table of [...definitions].reverse()) {
      const keep = protectedKeys.get(table.name)!
      const remove = db.prepare(`DELETE FROM ${ident(table.name)} WHERE ${table.keys.map((name) => `${ident(name)} IS ?`).join(' AND ')}`)
      for (const row of db.prepare(`SELECT * FROM ${ident(table.name)}`).all() as Row[]) {
        const key = JSON.stringify(Object.fromEntries(table.keys.map((name) => [name, row[name]])))
        if (!keep.has(key)) remove.run(...table.keys.map((name) => row[name]))
      }
    }
    db.prepare('UPDATE __sync_control SET enabled=1 WHERE id=1').run()
    db.prepare('INSERT OR REPLACE INTO __sync_meta VALUES (?,?)').run('lastSyncedAt', new Date().toISOString())
  }).immediate()
}

/** Flush durable operations before pulling. The server records each operation in
 * its transaction, making retries safe after a lost acknowledgement. */
export async function syncOfflineWorkspace(db: DB, cfg: SyncConfig, verifyLease: () => void = () => {}): Promise<void> {
  verifyLease()
  const definitions = tables(db)
  await ensureRemoteSchema(cfg, definitions)
  verifyLease()
  const pending = db.prepare('SELECT * FROM __sync_outbox ORDER BY seq').all() as Change[]
  // Avoid packet growth from repeatedly typing into the same note; each final row
  // includes all prior edits. Keep operation IDs for retry acknowledgement.
  const latest = new Map<string, Change>()
  for (const row of pending) latest.set(`${row.table_name}:${row.key_json}`, row)
  const ordered = [...latest.values()].sort((a, b) => {
    if ((a.row_json === null) !== (b.row_json === null)) return a.row_json === null ? 1 : -1
    const difference = definitions.findIndex((t) => t.name === a.table_name) - definitions.findIndex((t) => t.name === b.table_name)
    return a.row_json === null ? -difference : difference
  })
  if (ordered.length) {
    const latestDeletes = new Set(ordered.filter((change) => change.row_json === null).map((change) => `${change.table_name}:${change.key_json}`))
    const operationStatements = (change: Change): SyncStatement[] => {
      const table = definitions.find((t) => t.name === change.table_name)
      if (!table) throw new Error('Unknown pending workspace table.')
      const statements: SyncStatement[] = []
      const parents = new Map<string, { table: Table; row: Row }>()
      const collectParents = (row: Row) => {
        for (const [parent, field] of [['people', 'person_id'], ['goals', 'goal_id'], ['todos', 'todo_id'], ['todos', 'task_id'], ['people', 'from_person'], ['people', 'to_person']] as const) {
          if (!row[field]) continue
          const definition = definitions.find((candidate) => candidate.name === parent)!
          const key = JSON.stringify({ id: row[field] })
          const identity = `${parent}:${key}`
          if (parents.has(identity) || latestDeletes.has(identity)) continue
          const existing = db.prepare(`SELECT * FROM ${ident(parent)} WHERE id=?`).get(row[field]) as Row | undefined
          if (!existing) continue
          parents.set(identity, { table: definition, row: existing })
          collectParents(existing)
        }
      }
      if (change.row_json) collectParents(JSON.parse(change.row_json) as Row)
      for (const { table: parent, row } of [...parents.values()].sort((a, b) => definitions.indexOf(a.table) - definitions.indexOf(b.table))) {
        const columns = parent.columns.map((column) => column.name)
        // Recover a missing parent needed by a NEW local edit; never overwrite
        // another client's existing parent or resurrect one after a lost ACK.
        statements.push({ sql: `INSERT OR IGNORE INTO ${ident(parent.name)} (${columns.map(ident).join(',')})
          SELECT ${columns.map(() => '?').join(',')} WHERE NOT EXISTS (SELECT 1 FROM doneline_sync_operations WHERE id=?)`, args: [...columns.map((name) => row[name]), change.operation_id] })
      }
      statements.push(mutation(change, table))
      statements.push({ sql: 'INSERT OR IGNORE INTO doneline_sync_operations(id) VALUES (?)', args: [change.operation_id] })
      return statements
    }
    // Bound each packet while preserving parent-before-child/delete ordering.
    // A committed batch is acknowledged locally before starting the next one;
    // failed/lost replies keep exactly those operations available for retry.
    let statements: SyncStatement[] = []
    let batch: Change[] = []
    let bytes = 0
    const send = async () => {
      if (!batch.length) return
      verifyLease()
      await remoteTransaction(cfg, statements)
      verifyLease()
      const keys = new Set(batch.map((change) => `${change.table_name}:${change.key_json}`))
      db.transaction(() => {
        const remove = db.prepare('DELETE FROM __sync_outbox WHERE seq=? AND operation_id=?')
        for (const change of pending) if (keys.has(`${change.table_name}:${change.key_json}`)) remove.run(change.seq, change.operation_id)
      }).immediate()
      statements = []; batch = []; bytes = 0
    }
    for (const change of ordered) {
      const operation = operationStatements(change)
      const size = Buffer.byteLength(JSON.stringify(operation))
      if (batch.length && (batch.length >= 100 || bytes + size > 512 * 1024)) await send()
      statements.push(...operation); batch.push(change); bytes += size
    }
    await send()
  }
  verifyLease()
  const snapshot = await remoteTransaction(cfg, definitions.map((t) => ({ sql: `SELECT * FROM ${ident(t.name)}` })), false)
  verifyLease()
  pullSnapshot(db, definitions, snapshot)
}
