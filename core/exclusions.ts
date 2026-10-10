import { getDb } from './db.js'
import { localDateKey, normalizeRecurrenceJson, parseLocalDate, parseRecurrence } from './recurrenceRules.js'
import type Database from 'libsql'
import type { Recurrence } from './types.js'

type ItemKind = 'todos' | 'events'
function storedKind(kind: ItemKind): 'task' | 'event' { return kind === 'todos' ? 'task' : 'event' }

/** Independent date records merge across devices; explicit Undo overrides old JSON. */
export function effectiveRuleExclusions(kind: ItemKind, parentId: string, rule: Recurrence): Recurrence {
  const excluded = new Set(rule.excludedDates ?? [])
  const rows = getDb().prepare('SELECT day,excluded FROM recurrence_exclusions WHERE kind = ? AND parent_id = ?')
    .all(storedKind(kind), parentId) as { day: string; excluded: number }[]
  for (const row of rows) { if (row.excluded) excluded.add(row.day); else excluded.delete(row.day) }
  const effective = { ...rule }
  delete effective.excludedDates
  if (excluded.size) effective.excludedDates = [...excluded].sort()
  return effective
}

export function withEffectiveRecurrence<T extends { id: string; recurrence: string | null }>(kind: ItemKind, row: T): T {
  const rule = parseRecurrence(row.recurrence)
  return rule ? { ...row, recurrence: JSON.stringify(effectiveRuleExclusions(kind, row.id, rule)) } : row
}

export function setOccurrenceExclusion(kind: ItemKind, parentId: string, day: string, excluded: boolean): void {
  parseLocalDate(day)
  const db = getDb()
  const write = () => {
    const row = db.prepare(`SELECT recurrence FROM ${kind} WHERE id = ?`).get(parentId) as { recurrence: string | null } | undefined
    const parsed = parseRecurrence(row?.recurrence ?? null)
    if (!parsed) return
    db.prepare(`INSERT INTO recurrence_exclusions (kind,parent_id,day,excluded) VALUES (?,?,?,?)
      ON CONFLICT(kind,parent_id,day) DO UPDATE SET excluded=excluded.excluded`).run(storedKind(kind), parentId, day, Number(excluded))
    const rule = effectiveRuleExclusions(kind, parentId, parsed)
    db.prepare(`UPDATE ${kind} SET recurrence = ? WHERE id = ?`).run(normalizeRecurrenceJson(JSON.stringify(rule)), parentId)
  }
  if (db.inTransaction) write()
  else db.transaction(write).immediate()
}

/** Run after the replication journal is installed, using the initializing DB directly. */
export function backfillRecurrenceExclusions(db: InstanceType<typeof Database>): void {
  const insert = db.prepare('INSERT OR IGNORE INTO recurrence_exclusions (kind,parent_id,day,excluded) VALUES (?,?,?,1)')
  for (const kind of ['todos', 'events'] as const) {
    const rows = db.prepare(`SELECT id,recurrence FROM ${kind} WHERE recurrence IS NOT NULL`).all() as { id: string; recurrence: string }[]
    for (const row of rows) for (const day of parseRecurrence(row.recurrence)?.excludedDates ?? []) insert.run(storedKind(kind), row.id, day)
  }
}

/** Save skipped days in the rule so maintenance cannot resurrect removed work. */
export function excludeOccurrence(kind: ItemKind, parentId: string, iso: string): void {
  setOccurrenceExclusion(kind, parentId, localDateKey(new Date(iso)), true)
}
