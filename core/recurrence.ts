import { getDb } from './db.js'
import { v5 as uuidv5 } from 'uuid'
import { effectiveRuleExclusions } from './exclusions.js'
import { listTodoTemplates, createTodo, archiveDoneBefore, purgeArchivedOlderThan } from './todos.js'
import { listEventTemplates, createEvent } from './events.js'
import {
  calendarDayDifference,
  assertCalendarRange,
  localCalendarDate,
  localDateKey,
  occurrenceTimes,
  parseRecurrence,
  recurrenceMatchesDate
} from './recurrenceRules.js'

export * from './recurrenceRules.js'

const ARCHIVE_KEEP_DAYS = 14
const EVENT_HORIZON_DAYS = 60

export function recurringInstanceId(kind: 'todo' | 'event', parentId: string, day: string): string {
  return uuidv5(JSON.stringify(['doneline', 'recurrence', kind, parentId, day]), uuidv5.URL)
}

function nextDay(date: Date): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + 1)
  return next
}

/** SQLite's default created_at timestamps are UTC, without an explicit zone. */
function createdDate(createdAt: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(createdAt)
    ? `${createdAt.replace(' ', 'T')}Z`
    : createdAt
  return new Date(normalized)
}

/** Materialize only an explicit range; ordinary maintenance generates today. */
export function ensureTodoInstancesForRange(from: string | Date, to: string | Date): number {
  const first = localCalendarDate(from)
  const last = localCalendarDate(to)
  if (last.getTime() < first.getTime()) throw new Error('Task range end must follow its start.')
  assertCalendarRange(first, last)
  const db = getDb()
  const exists = db.prepare('SELECT 1 FROM todos WHERE recur_parent = ? AND due_at >= ? AND due_at < ? LIMIT 1')
  const occupied = db.prepare('SELECT 1 FROM todos WHERE id = ?')
  let generated = 0
  const generate = () => {
    for (const template of listTodoTemplates()) {
      const anchor = template.due_at ? new Date(template.due_at) : createdDate(template.created_at)
      if (!Number.isFinite(anchor.getTime())) continue
      const parsed = parseRecurrence(template.recurrence, localDateKey(anchor))
      if (!parsed) continue
      const rule = effectiveRuleExclusions('todos', template.id, parsed)
      const lower = rule.startDate && rule.startDate > localDateKey(first) ? localCalendarDate(rule.startDate) : first
      const upper = rule.endDate && rule.endDate < localDateKey(last) ? localCalendarDate(rule.endDate) : last
      for (let day = new Date(lower); day.getTime() <= upper.getTime(); day = nextDay(day)) {
        if (!recurrenceMatchesDate(rule, day) || exists.get(template.id, day.toISOString(), nextDay(day).toISOString())) continue
        const instanceId = recurringInstanceId('todo', template.id, localDateKey(day))
        if (occupied.get(instanceId)) continue // A detached or restored exception owns this identity.
        const due = new Date(day)
        if (template.due_at) {
          due.setHours(anchor.getHours(), anchor.getMinutes(), anchor.getSeconds(), anchor.getMilliseconds())
        } else {
          due.setHours(23, 59, 0, 0)
        }
        createTodo({
          title: template.title,
          person_id: template.person_id,
          goal_id: template.goal_id,
          notes: template.notes,
          due_at: due.toISOString(),
          recur_parent: template.id
        }, { id: instanceId })
        generated++
      }
    }
  }
  // The desktop and MCP may both generate the same day; lock before checking.
  if (db.inTransaction) generate()
  else db.transaction(generate).immediate()
  return generated
}

export function ensureTodoInstancesForDate(value: string | Date): number {
  return ensureTodoInstancesForRange(value, value)
}

/** Materialize occurrences for any requested inclusive local-calendar range.
 * Includes earlier starts needed by multi-day events overlapping that range. */
export function ensureEventInstancesForRange(from: string | Date, to: string | Date, templateId?: string): number {
  const requestedStart = localCalendarDate(from)
  const requestedEnd = localCalendarDate(to)
  if (requestedEnd.getTime() < requestedStart.getTime()) throw new Error('Calendar range end must follow its start.')
  assertCalendarRange(requestedStart, requestedEnd)
  const db = getDb()
  const exists = db.prepare('SELECT 1 FROM events WHERE recur_parent = ? AND starts_at >= ? AND starts_at < ? LIMIT 1')
  const occupied = db.prepare('SELECT 1 FROM events WHERE id = ?')
  let generated = 0
  const generate = () => {
    for (const template of listEventTemplates()) {
      if (templateId && template.id !== templateId) continue
      const templateStart = new Date(template.starts_at)
      const templateEnd = new Date(template.ends_at)
      if (!Number.isFinite(templateStart.getTime()) || !Number.isFinite(templateEnd.getTime()) ||
          templateEnd.getTime() <= templateStart.getTime()) continue
      const parsed = parseRecurrence(template.recurrence, localDateKey(templateStart))
      if (!parsed) continue
      const rule = effectiveRuleExclusions('events', template.id, parsed)
      const first = new Date(requestedStart)
      first.setDate(first.getDate() - Math.max(0, calendarDayDifference(templateStart, templateEnd)))
      const last = new Date(requestedEnd)
      if (rule.startDate && rule.startDate > localDateKey(first)) first.setTime(localCalendarDate(rule.startDate).getTime())
      if (rule.endDate && rule.endDate < localDateKey(last)) last.setTime(localCalendarDate(rule.endDate).getTime())
      for (let day = first; day.getTime() <= last.getTime(); day = nextDay(day)) {
        if (!recurrenceMatchesDate(rule, day)) continue
        if (exists.get(template.id, day.toISOString(), nextDay(day).toISOString())) continue
        const instanceId = recurringInstanceId('event', template.id, localDateKey(day))
        if (occupied.get(instanceId)) continue
        const { start, end } = occurrenceTimes(templateStart, templateEnd, day)
        createEvent({
          title: template.title,
          person_id: template.person_id,
          location: template.location,
          notes: template.notes,
          starts_at: start.toISOString(),
          ends_at: end.toISOString(),
          all_day: template.all_day === 1,
          color: template.color,
          shared: template.shared === 1,
          attendees: template.attendees,
          recur_parent: template.id
        }, { id: instanceId })
        generated++
      }
    }
  }
  if (db.inTransaction) generate()
  else db.transaction(generate).immediate()
  return generated
}

/** Run at startup and hourly; explicit ranges also support deterministic checks. */
export function runMaintenance(options: {
  now?: Date
  eventFrom?: string | Date
  eventTo?: string | Date
} = {}): { archived: number; purged: number } {
  const today = localCalendarDate(options.now ?? new Date())
  const horizon = new Date(today)
  horizon.setDate(horizon.getDate() + EVENT_HORIZON_DAYS - 1)
  ensureTodoInstancesForDate(today)
  ensureEventInstancesForRange(options.eventFrom ?? today, options.eventTo ?? horizon)
  const archived = archiveDoneBefore(localDateKey(today))
  const purged = purgeArchivedOlderThan(ARCHIVE_KEEP_DAYS)
  return { archived, purged }
}
