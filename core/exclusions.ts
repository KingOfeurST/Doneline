import { getDb } from './db.js'
import { localDateKey, normalizeRecurrenceJson, parseRecurrence } from './recurrenceRules.js'

/** Save skipped days in the rule so maintenance cannot resurrect removed work. */
export function excludeOccurrence(kind: 'todos' | 'events', parentId: string, iso: string): void {
  const row = getDb().prepare(`SELECT recurrence FROM ${kind} WHERE id = ?`).get(parentId) as { recurrence: string | null } | undefined
  const rule = parseRecurrence(row?.recurrence ?? null)
  if (!rule) return
  const day = localDateKey(new Date(iso))
  rule.excludedDates = [...new Set([...(rule.excludedDates ?? []), day])]
  getDb().prepare(`UPDATE ${kind} SET recurrence = ? WHERE id = ?`).run(normalizeRecurrenceJson(JSON.stringify(rule)), parentId)
}
