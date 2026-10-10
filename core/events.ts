import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import type { CalEvent } from './types.js'
import { ensureEventInstancesForRange } from './recurrence.js'
import { normalizeRecurrenceJson, localDateKey, parseLocalDate, calendarDayDifference } from './recurrenceRules.js'
import { excludeOccurrence } from './exclusions.js'
import { eventTimes, itemTitle, timestamp } from './validation.js'
import { ensureRemoteCalendarInstancesForRange } from './calendarResources.js'

function recordRemoteDelete(event: CalEvent): void {
  if (!event.caldav_uid) return
  getDb().prepare(`INSERT OR REPLACE INTO calendar_tombstones
    (person_id, uid, recurrence_id, url, etag) VALUES (?, ?, ?, ?, ?)`).run(
    event.person_id, event.caldav_uid, event.caldav_recurrence_id ?? '', event.caldav_url, event.caldav_etag
  )
}

function personFilter(personId?: string): { sql: string; args: string[] } {
  if (!personId || personId === 'all') return { sql: '', args: [] }
  // A person sees their own events plus any shared-with-everyone events.
  return { sql: '(person_id = ? OR shared = 1)', args: [personId] }
}

// Templates (recurrence set) are rules, not dated events — exclude from listings.
const NOT_TEMPLATE = 'recurrence IS NULL'

export function listEvents(opts: { from?: string; to?: string; personId?: string } = {}): CalEvent[] {
  const db = getDb()
  const p = personFilter(opts.personId)
  const where: string[] = [NOT_TEMPLATE]
  const args: string[] = []
  const from = opts.from ? timestamp(opts.from, 'Range start') : undefined
  const to = opts.to ? timestamp(opts.to, 'Range end') : undefined
  if (from && to) {
    if (from >= to) throw new Error('The range must end after it starts.')
    ensureEventInstancesForRange(new Date(from), new Date(new Date(to).getTime() - 1))
    ensureRemoteCalendarInstancesForRange(from, to, opts.personId)
  }
  if (from) {
    where.push('ends_at > ?')
    args.push(from)
  }
  if (to) {
    where.push('starts_at < ?')
    args.push(to)
  }
  if (p.sql) {
    where.push(p.sql)
    args.push(...p.args)
  }
  return db
    .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY all_day DESC, starts_at`)
    .all(...args) as CalEvent[]
}

/** Events overlapping a given calendar day (local date string YYYY-MM-DD).
 *
 *  Timestamps are stored as UTC, so they're converted with 'localtime' before
 *  being matched against the local day. Comparing the raw UTC values against
 *  local day bounds made events near midnight land on the wrong day, or show up
 *  on two days at once. SQLite's datetime() renders "YYYY-MM-DD HH:MM:SS", so
 *  the bounds use a space separator to match. */
export function listDayEvents(dayISO: string, personId?: string): CalEvent[] {
  const start = parseLocalDate(dayISO)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return listEvents({ from: start.toISOString(), to: end.toISOString(), personId })
}

export function getEvent(id: string): CalEvent | undefined {
  return getDb().prepare('SELECT * FROM events WHERE id = ?').get(id) as CalEvent | undefined
}

export function listEventTemplates(opts: { personId?: string } = {}): CalEvent[] {
  return getDb()
    .prepare(`SELECT * FROM events WHERE recurrence IS NOT NULL${opts.personId && opts.personId !== 'all' ? ' AND (person_id = ? OR shared = 1)' : ''} ORDER BY created_at`)
    .all(...(opts.personId && opts.personId !== 'all' ? [opts.personId] : [])) as CalEvent[]
}

export function createEvent(input: {
  title: string
  starts_at: string
  ends_at: string
  person_id?: string
  all_day?: boolean
  shared?: boolean
  location?: string | null
  notes?: string | null
  color?: string
  attendees?: string | null
  caldav_uid?: string | null
  caldav_etag?: string | null
  caldav_url?: string | null
  caldav_recurrence_id?: string | null
  recurrence?: string | null
  recur_parent?: string | null
  source?: 'local' | 'caldav'
}): CalEvent {
  const db = getDb()
  const id = uuid()
  const owner = input.person_id || primaryPersonId()
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(owner)) throw new Error('This profile no longer exists.')
  const times = eventTimes(input.starts_at, input.ends_at, !!input.all_day)
  const recurrence = normalizeRecurrenceJson(input.recurrence ?? null, localDateKey(new Date(times.start)))
  db.prepare(
    `INSERT INTO events
     (id, person_id, title, location, notes, starts_at, ends_at, all_day, color, shared, attendees,
      caldav_uid, caldav_etag, caldav_url, caldav_recurrence_id, recurrence, recur_parent, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    owner,
    itemTitle(input.title),
    input.location ?? null,
    input.notes ?? null,
    times.start,
    times.end,
    input.all_day ? 1 : 0,
    input.color || '#2f7a4d',
    input.shared ? 1 : 0,
    input.attendees ?? null,
    input.caldav_uid ?? null,
    input.caldav_etag ?? null,
    input.caldav_url ?? null,
    input.caldav_recurrence_id ?? null,
    recurrence,
    input.recur_parent ?? null,
    input.source || 'local'
  )
  return getEvent(id)!
}

export function updateEvent(
  id: string,
  patch: Partial<Omit<CalEvent, 'id' | 'created_at'>>
): CalEvent | undefined {
  const db = getDb()
  const update = () => updateEventInTransaction(id, patch)
  return db.inTransaction ? update() : db.transaction(update).immediate()
}

function updateEventInTransaction(
  id: string,
  patch: Partial<Omit<CalEvent, 'id' | 'created_at'>>
): CalEvent | undefined {
  const cur = getEvent(id)
  if (!cur) return undefined
  const m = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) }
  if (m.recurrence && (cur.recur_parent || cur.caldav_uid)) throw new Error('Edit the repeat-rule template, or create a new rule for this event.')
  if (patch.starts_at !== undefined && patch.ends_at === undefined) {
    const newStart = new Date(timestamp(patch.starts_at, 'Start'))
    if (m.all_day) {
      const end = new Date(newStart); end.setHours(0, 0, 0, 0)
      end.setDate(end.getDate() + Math.max(1, calendarDayDifference(new Date(cur.starts_at), new Date(cur.ends_at))))
      m.ends_at = end.toISOString()
    } else {
      m.ends_at = new Date(newStart.getTime() + new Date(cur.ends_at).getTime() - new Date(cur.starts_at).getTime()).toISOString()
    }
  }
  m.title = itemTitle(m.title)
  const times = eventTimes(m.starts_at, m.ends_at, !!m.all_day)
  m.starts_at = times.start
  m.ends_at = times.end
  m.recurrence = normalizeRecurrenceJson(m.recurrence, localDateKey(new Date(m.starts_at)))
  if (!getDb().prepare('SELECT 1 FROM people WHERE id = ?').get(m.person_id)) throw new Error('This profile no longer exists.')
  if (cur.person_id !== m.person_id && cur.caldav_uid && !('source' in patch)) {
    recordRemoteDelete(cur)
    m.caldav_uid = null
    m.caldav_etag = null
    m.caldav_url = null
    m.caldav_recurrence_id = null
    m.source = 'local'
  }
  const contentChanged = ['title', 'starts_at', 'ends_at', 'all_day', 'location', 'notes', 'person_id', 'attendees', 'color', 'shared'].some((key) =>
    key in patch && patch[key as keyof typeof patch] !== cur[key as keyof CalEvent]
  )
  if (cur.recur_parent && contentChanged) {
    excludeOccurrence('events', cur.recur_parent, cur.starts_at)
    m.recur_parent = null // An edited occurrence is an exception to its rule.
  }
  if (cur.recurrence && (contentChanged || 'recurrence' in patch || 'shared' in patch || 'color' in patch || 'attendees' in patch)) {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    const children = getDb().prepare('SELECT * FROM events WHERE recur_parent = ? AND starts_at >= ?').all(id, midnight.toISOString()) as CalEvent[]
    for (const child of children) recordRemoteDelete(child)
    getDb().prepare('DELETE FROM events WHERE recur_parent = ? AND starts_at >= ?').run(id, midnight.toISOString())
  }
  getDb()
    .prepare(
      `UPDATE events SET
        person_id = ?, title = ?, location = ?, notes = ?, starts_at = ?, ends_at = ?,
        all_day = ?, color = ?, shared = ?, attendees = ?, caldav_uid = ?, caldav_etag = ?, caldav_url = ?, caldav_recurrence_id = ?,
        recurrence = ?, recur_parent = ?, source = ?
       WHERE id = ?`
    )
    .run(
      m.person_id,
      m.title,
      m.location,
      m.notes,
      m.starts_at,
      m.ends_at,
      m.all_day ? 1 : 0,
      m.color,
      m.shared ? 1 : 0,
      m.attendees,
      m.caldav_uid,
      m.caldav_etag,
      m.caldav_url,
      m.caldav_recurrence_id,
      m.recurrence,
      m.recur_parent,
      m.source,
      id
    )
  if (contentChanged && m.caldav_uid && !('source' in patch)) {
    getDb().prepare('UPDATE events SET calendar_dirty = 1 WHERE id = ?').run(id)
  }
  return getEvent(id)
}

export function deleteEvent(id: string): void {
  const db = getDb()
  const remove = () => deleteEventInTransaction(id)
  if (db.inTransaction) remove()
  else db.transaction(remove).immediate()
}

function deleteEventInTransaction(id: string): void {
  const event = getEvent(id)
  if (!event) return
  if (event.recur_parent) excludeOccurrence('events', event.recur_parent, event.starts_at)
  const removed = getDb().prepare('SELECT * FROM events WHERE id = ? OR recur_parent = ?').all(id, id) as CalEvent[]
  for (const row of removed) recordRemoteDelete(row)
  // Deleting a template removes its generated instances too.
  getDb().prepare('DELETE FROM events WHERE id = ? OR recur_parent = ?').run(id, id)
}

/** Find a synced event by its CalDAV UID, scoped to one person's calendar. */
export function findByUid(uid: string, personId: string): CalEvent | undefined {
  return getDb()
    .prepare('SELECT * FROM events WHERE caldav_uid = ? AND person_id = ?')
    .get(uid, personId) as CalEvent | undefined
}
