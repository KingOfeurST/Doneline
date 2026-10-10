import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { localDateKey, normalizeRecurrenceJson, parseRecurrence } from './recurrenceRules.js'
import { prepareRestoredRemoteOccurrence } from './calendarResourceChanges.js'
import { effectiveRuleExclusions, setOccurrenceExclusion } from './exclusions.js'
import type { CalEvent, Todo } from './types.js'

type Row = Record<string, string | number | null>
export interface TrashItem {
  id: string
  kind: 'task' | 'event'
  item_id: string
  person_id: string
  title: string
  deleted_at: string
  item_count: number
}
export interface RestoreTrashResult {
  kind: 'task' | 'event'
  itemIds: string[]
  personId: string
}
interface Exclusion {
  table: 'todos' | 'events'
  parentId: string
  before: string
  after: string
  day: string
}
interface TrashPayload {
  version: 1
  rows: Row[]
  completions: Row[]
  reactions: Row[]
  detached: { id: string; parentId: string; content?: string }[]
  exclusion?: Exclusion
}

function taskContent(row: Row): string {
  return JSON.stringify(['title', 'person_id', 'goal_id', 'notes', 'due_at', 'recurrence'].map(key => row[key] ?? null))
}

function exclusionFor(table: 'todos' | 'events', parentId: string | null, iso: string | null): Exclusion | undefined {
  if (!parentId || !iso) return
  const parent = getDb().prepare(`SELECT recurrence FROM ${table} WHERE id = ?`).get(parentId) as { recurrence: string | null } | undefined
  const parsed = parseRecurrence(parent?.recurrence ?? null)
  if (!parsed || !parent?.recurrence) return
  const rule = effectiveRuleExclusions(table, parentId, parsed)
  const day = localDateKey(new Date(iso))
  if (rule.excludedDates?.includes(day)) return
  const after = normalizeRecurrenceJson(JSON.stringify({ ...rule, excludedDates: [...(rule.excludedDates ?? []), day] }))!
  return { table, parentId, before: parent.recurrence, after, day }
}

/** Called inside the deletion transaction, before dependent rows are removed. */
export function captureDeletedItem(kind: 'task' | 'event', id: string): string | null {
  const db = getDb()
  const table = kind === 'task' ? 'todos' : 'events'
  const original = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as (Todo | CalEvent) | undefined
  if (!original) return null
  const payload: TrashPayload = { version: 1, rows: [], completions: [], reactions: [], detached: [] }
  if (kind === 'task') {
    const task = original as Todo
    payload.rows = db.prepare(`SELECT * FROM todos WHERE id = ? OR (recur_parent = ? AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM todo_completions c WHERE c.todo_id = todos.id))`).all(id, id) as Row[]
    payload.detached = (db.prepare(`SELECT * FROM todos WHERE recur_parent = ? AND
      (completed_at IS NOT NULL OR EXISTS (SELECT 1 FROM todo_completions c WHERE c.todo_id = todos.id))`).all(id) as Row[])
      .map(row => ({ id: String(row.id), parentId: id, content: taskContent(row) }))
    for (const row of payload.rows) {
      payload.completions.push(...db.prepare('SELECT * FROM todo_completions WHERE todo_id = ?').all(row.id) as Row[])
      payload.reactions.push(...db.prepare('SELECT * FROM reactions WHERE todo_id = ?').all(row.id) as Row[])
    }
    payload.exclusion = exclusionFor('todos', task.recur_parent, task.due_at)
  } else {
    const event = original as CalEvent
    payload.rows = db.prepare('SELECT * FROM events WHERE id = ? OR recur_parent = ?').all(id, id) as Row[]
    payload.exclusion = exclusionFor('events', event.recur_parent, event.starts_at)
  }
  const trashId = uuid()
  db.prepare(`INSERT INTO trash_items (id,kind,item_id,person_id,title,deleted_at,payload)
    VALUES (?,?,?,?,?,?,?)`).run(trashId, kind, id, original.person_id, original.title, new Date().toISOString(), JSON.stringify(payload))
  return trashId
}

/** Retain manual deletions for thirty days; removed profiles cannot leave orphan entries. */
export function purgeTrash(now = new Date()): number {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString()
  return getDb().prepare('DELETE FROM trash_items WHERE deleted_at <= ? OR person_id NOT IN (SELECT id FROM people)').run(cutoff).changes as number
}

export function listTrash(personId?: string): TrashItem[] {
  purgeTrash()
  const rows = getDb().prepare(`SELECT * FROM trash_items${personId && personId !== 'all' ? ' WHERE person_id = ?' : ''} ORDER BY deleted_at DESC`)
    .all(...(personId && personId !== 'all' ? [personId] : [])) as (Omit<TrashItem, 'item_count'> & { payload: string })[]
  return rows.map(({ payload, ...item }) => ({ ...item, item_count: (JSON.parse(payload) as TrashPayload).rows.length }))
}

function insertRow(table: string, row: Row): void {
  const db = getDb()
  const allowed = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => column.name))
  const columns = Object.keys(row).filter(key => allowed.has(key))
  db.prepare(`INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => row[column]))
}

export function restoreTrash(id: string): RestoreTrashResult {
  const db = getDb()
  const restore = () => restoreInTransaction(id)
  return db.inTransaction ? restore() : db.transaction(restore).immediate()
}

function restoreInTransaction(id: string): RestoreTrashResult {
  const db = getDb()
  const item = db.prepare('SELECT * FROM trash_items WHERE id = ?').get(id) as Omit<TrashItem, 'item_count'> & { payload: string } | undefined
  if (!item) throw new Error('This item is no longer in Trash.')
  if (new Date(item.deleted_at).getTime() <= Date.now() - 30 * 86_400_000) throw new Error('This item has passed the 30-day Trash retention period.')
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(item.person_id)) throw new Error('The original profile no longer exists.')
  const payload = JSON.parse(item.payload) as TrashPayload
  if (payload.version !== 1 || !Array.isArray(payload.rows) || payload.rows.length === 0) throw new Error('This Trash entry is invalid.')
  const table = item.kind === 'task' ? 'todos' : 'events'
  // Refuse to overwrite an existing row, even after another device restored it.
  for (const row of payload.rows) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row.id)) throw new Error('An item with this identity already exists. Nothing was overwritten.')
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(row.person_id)) throw new Error('An item’s original profile no longer exists.')
  }
  let reattachOccurrence = true
  if (payload.exclusion) {
    const exclusion = payload.exclusion
    const current = db.prepare(`SELECT recurrence FROM ${exclusion.table} WHERE id = ?`).get(exclusion.parentId) as { recurrence: string | null } | undefined
    const before = parseRecurrence(exclusion.before)
    const rule = parseRecurrence(current?.recurrence ?? null)
    const sameRule = before && rule && normalizeRecurrenceJson(JSON.stringify({ ...before, excludedDates: [] })) ===
      normalizeRecurrenceJson(JSON.stringify({ ...rule, excludedDates: [] }))
    if (sameRule && rule) {
      // Undo only our excluded day; preserve exclusions added by other deletions.
      setOccurrenceExclusion(exclusion.table, exclusion.parentId, exclusion.day, false)
    } else reattachOccurrence = false
  }
  // Rules before their children, regardless of SQLite's select order.
  const rows = [...payload.rows].sort((a, b) => Number(!!b.recurrence) - Number(!!a.recurrence))
  for (const stored of rows) {
    const row = { ...stored }
    if (row.recur_parent && !rows.some(candidate => candidate.id === row.recur_parent)) {
      if (!reattachOccurrence || !db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND recurrence IS NOT NULL`).get(row.recur_parent)) row.recur_parent = null
      else {
        const due = item.kind === 'task' ? row.due_at : row.starts_at
        const exists = db.prepare(`SELECT 1 FROM ${table} WHERE recur_parent = ? AND ${item.kind === 'task' ? 'due_at' : 'starts_at'} = ?`).get(row.recur_parent, due)
        if (exists) throw new Error('This repeating occurrence already exists. Nothing was overwritten.')
      }
    }
    if (item.kind === 'task') {
      if (row.goal_id && !db.prepare('SELECT 1 FROM goals WHERE id = ?').get(row.goal_id)) row.goal_id = null
    } else if (row.caldav_uid) {
      const belongsToSeries = !row.caldav_recurrence_id || prepareRestoredRemoteOccurrence(String(row.person_id), String(row.caldav_uid), String(row.caldav_recurrence_id))
      if (!belongsToSeries) {
        // Keep the old exclusion when a changed/disappeared series no longer owns this date.
        row.caldav_uid = null; row.caldav_recurrence_id = null; row.caldav_url = null; row.caldav_etag = null
        row.source = 'local'
      } else {
        // Cancel our remote deletion; dirty restored rows survive an in-flight fetch.
        db.prepare('DELETE FROM calendar_tombstones WHERE person_id = ? AND uid = ? AND recurrence_id = ?')
          .run(row.person_id, row.caldav_uid, row.caldav_recurrence_id ?? '')
      }
      row.calendar_dirty = row.caldav_uid ? 1 : 0
      row.calendar_restore = row.caldav_uid ? 1 : 0
    }
    insertRow(table, row)
  }
  if (item.kind === 'task') {
    for (const row of payload.completions) if (db.prepare('SELECT 1 FROM people WHERE id = ?').get(row.person_id)) insertRow('todo_completions', row)
    for (const row of payload.reactions) if (db.prepare('SELECT 1 FROM people WHERE id = ?').get(row.person_id)) insertRow('reactions', row)
    for (const detached of payload.detached) {
      const current = db.prepare('SELECT * FROM todos WHERE id = ? AND recur_parent IS NULL').get(detached.id) as Row | undefined
      // Preserve edits made to retained history while the rule was in Trash.
      if (current && (!detached.content || taskContent(current) === detached.content)) {
        db.prepare('UPDATE todos SET recur_parent = ? WHERE id = ? AND recur_parent IS NULL').run(detached.parentId, detached.id)
      }
    }
    for (const row of rows) db.prepare(`UPDATE todos SET completed_at = CASE
      WHEN (SELECT COUNT(*) FROM todo_completions c JOIN people p ON p.id = c.person_id WHERE c.todo_id = todos.id)
        >= (SELECT COUNT(*) FROM people)
      THEN COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE NULL END
      WHERE id = ? AND archived = 0 AND recurrence IS NULL AND goal_id IN (SELECT id FROM goals WHERE shared = 1)`).run(row.id)
  }
  db.prepare('DELETE FROM trash_items WHERE id = ?').run(id)
  return { kind: item.kind, itemIds: rows.map(row => String(row.id)), personId: item.person_id }
}
