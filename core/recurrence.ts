import { getDb } from './db.js'
import {
  listTodoTemplates,
  createTodo,
  archiveDoneBefore,
  purgeArchivedOlderThan
} from './todos.js'
import { listEventTemplates, createEvent } from './events.js'
import type { Recurrence } from './types.js'

const ARCHIVE_KEEP_DAYS = 14
const EVENT_HORIZON_DAYS = 60

function parseRec(json: string | null): Recurrence | null {
  if (!json) return null
  try {
    const r = JSON.parse(json) as Recurrence
    return r.freq ? r : null
  } catch {
    return null
  }
}

function matches(rec: Recurrence, d: Date): boolean {
  if (rec.freq === 'daily') return true
  if (rec.freq === 'weekly') return (rec.days ?? []).includes(d.getDay())
  return false
}

function dayStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Ensure each matching recurring-todo template has an instance for `day`. */
function ensureTodoInstances(day: Date): void {
  const db = getDb()
  const ds = dayStr(day)
  for (const tpl of listTodoTemplates()) {
    const rec = parseRec(tpl.recurrence)
    if (!rec || !matches(rec, day)) continue
    const exists = db
      .prepare('SELECT 1 FROM todos WHERE recur_parent = ? AND date(due_at) = date(?) LIMIT 1')
      .get(tpl.id, ds)
    if (exists) continue
    createTodo({
      title: tpl.title,
      person_id: tpl.person_id,
      goal_id: tpl.goal_id,
      notes: tpl.notes,
      due_at: `${ds}T23:59:00`, // due end of that day
      recur_parent: tpl.id
    })
  }
}

/** Generate event instances for the next EVENT_HORIZON_DAYS so they show on the calendar. */
function ensureEventInstances(): void {
  const db = getDb()
  for (const tpl of listEventTemplates()) {
    const rec = parseRec(tpl.recurrence)
    if (!rec) continue
    const tplStart = new Date(tpl.starts_at)
    const durMs = Math.max(0, new Date(tpl.ends_at).getTime() - tplStart.getTime())
    for (let i = 0; i < EVENT_HORIZON_DAYS; i++) {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      d.setDate(d.getDate() + i)
      if (!matches(rec, d)) continue
      const ds = dayStr(d)
      const exists = db
        .prepare('SELECT 1 FROM events WHERE recur_parent = ? AND date(starts_at) = date(?) LIMIT 1')
        .get(tpl.id, ds)
      if (exists) continue
      const start = new Date(d)
      start.setHours(tplStart.getHours(), tplStart.getMinutes(), 0, 0)
      const end = new Date(start.getTime() + durMs)
      createEvent({
        title: tpl.title,
        person_id: tpl.person_id,
        location: tpl.location,
        notes: tpl.notes,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        all_day: tpl.all_day === 1,
        color: tpl.color,
        attendees: tpl.attendees,
        recur_parent: tpl.id
      })
    }
  }
}

/**
 * Run on app start, after creating a recurring item, and hourly: generate due
 * instances, archive yesterday's finished todos, purge old archived ones.
 */
export function runMaintenance(): { archived: number; purged: number } {
  const today = new Date()
  ensureTodoInstances(today)
  ensureEventInstances()
  const archived = archiveDoneBefore(dayStr(today))
  const purged = purgeArchivedOlderThan(ARCHIVE_KEEP_DAYS)
  return { archived, purged }
}
