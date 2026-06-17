import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import type { CalEvent } from './types.js'

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
  if (opts.from && opts.to) {
    where.push('starts_at < ? AND ends_at > ?')
    args.push(opts.to, opts.from)
  }
  if (p.sql) {
    where.push(p.sql)
    args.push(...p.args)
  }
  return db
    .prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY all_day DESC, starts_at`)
    .all(...args) as CalEvent[]
}

/** Events overlapping a given calendar day (local date string YYYY-MM-DD). */
export function listDayEvents(dayISO: string, personId?: string): CalEvent[] {
  const start = `${dayISO}T00:00:00`
  const end = `${dayISO}T23:59:59`
  const p = personFilter(personId)
  const extra = p.sql ? ` AND ${p.sql}` : ''
  return getDb()
    .prepare(
      `SELECT * FROM events
       WHERE ${NOT_TEMPLATE} AND (
         (all_day = 1 AND date(starts_at) = date(?))
         OR (all_day = 0 AND starts_at <= ? AND ends_at >= ?)
       )${extra}
       ORDER BY all_day DESC, starts_at`
    )
    .all(dayISO, end, start, ...p.args) as CalEvent[]
}

export function getEvent(id: string): CalEvent | undefined {
  return getDb().prepare('SELECT * FROM events WHERE id = ?').get(id) as CalEvent | undefined
}

export function listEventTemplates(): CalEvent[] {
  return getDb()
    .prepare('SELECT * FROM events WHERE recurrence IS NOT NULL ORDER BY created_at')
    .all() as CalEvent[]
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
  recurrence?: string | null
  recur_parent?: string | null
  source?: 'local' | 'caldav'
}): CalEvent {
  const db = getDb()
  const id = uuid()
  db.prepare(
    `INSERT INTO events
     (id, person_id, title, location, notes, starts_at, ends_at, all_day, color, shared, attendees,
      caldav_uid, caldav_etag, caldav_url, recurrence, recur_parent, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.person_id || primaryPersonId(),
    input.title.trim(),
    input.location ?? null,
    input.notes ?? null,
    input.starts_at,
    input.ends_at,
    input.all_day ? 1 : 0,
    input.color || '#2f7a4d',
    input.shared ? 1 : 0,
    input.attendees ?? null,
    input.caldav_uid ?? null,
    input.caldav_etag ?? null,
    input.caldav_url ?? null,
    input.recurrence ?? null,
    input.recur_parent ?? null,
    input.source || 'local'
  )
  return getEvent(id)!
}

export function updateEvent(
  id: string,
  patch: Partial<Omit<CalEvent, 'id' | 'created_at'>>
): CalEvent | undefined {
  const cur = getEvent(id)
  if (!cur) return undefined
  const m = { ...cur, ...patch }
  getDb()
    .prepare(
      `UPDATE events SET
        person_id = ?, title = ?, location = ?, notes = ?, starts_at = ?, ends_at = ?,
        all_day = ?, color = ?, shared = ?, attendees = ?, caldav_uid = ?, caldav_etag = ?, caldav_url = ?,
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
      m.recurrence,
      m.recur_parent,
      m.source,
      id
    )
  return getEvent(id)
}

export function deleteEvent(id: string): void {
  // Deleting a template removes its generated instances too.
  getDb().prepare('DELETE FROM events WHERE id = ? OR recur_parent = ?').run(id, id)
}

/** Find a synced event by its CalDAV UID, scoped to one person's calendar. */
export function findByUid(uid: string, personId: string): CalEvent | undefined {
  return getDb()
    .prepare('SELECT * FROM events WHERE caldav_uid = ? AND person_id = ?')
    .get(uid, personId) as CalEvent | undefined
}
