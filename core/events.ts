import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import type { CalEvent } from './types.js'

function personFilter(personId?: string): { sql: string; args: string[] } {
  if (!personId || personId === 'all') return { sql: '', args: [] }
  return { sql: 'person_id = ?', args: [personId] }
}

export function listEvents(opts: { from?: string; to?: string; personId?: string } = {}): CalEvent[] {
  const db = getDb()
  const p = personFilter(opts.personId)
  const where: string[] = []
  const args: string[] = []
  if (opts.from && opts.to) {
    where.push('starts_at < ? AND ends_at > ?')
    args.push(opts.to, opts.from)
  }
  if (p.sql) {
    where.push(p.sql)
    args.push(...p.args)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .prepare(`SELECT * FROM events ${clause} ORDER BY all_day DESC, starts_at`)
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
       WHERE (
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

export function createEvent(input: {
  title: string
  starts_at: string
  ends_at: string
  person_id?: string
  all_day?: boolean
  location?: string | null
  notes?: string | null
  color?: string
  attendees?: string | null
  caldav_uid?: string | null
  caldav_etag?: string | null
  caldav_url?: string | null
  source?: 'local' | 'caldav'
}): CalEvent {
  const db = getDb()
  const id = uuid()
  db.prepare(
    `INSERT INTO events
     (id, person_id, title, location, notes, starts_at, ends_at, all_day, color, attendees, caldav_uid, caldav_etag, caldav_url, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    input.attendees ?? null,
    input.caldav_uid ?? null,
    input.caldav_etag ?? null,
    input.caldav_url ?? null,
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
  const merged = { ...cur, ...patch }
  getDb()
    .prepare(
      `UPDATE events SET
        person_id = ?, title = ?, location = ?, notes = ?, starts_at = ?, ends_at = ?,
        all_day = ?, color = ?, attendees = ?, caldav_uid = ?, caldav_etag = ?, caldav_url = ?, source = ?
       WHERE id = ?`
    )
    .run(
      merged.person_id,
      merged.title,
      merged.location,
      merged.notes,
      merged.starts_at,
      merged.ends_at,
      merged.all_day ? 1 : 0,
      merged.color,
      merged.attendees,
      merged.caldav_uid,
      merged.caldav_etag,
      merged.caldav_url,
      merged.source,
      id
    )
  return getEvent(id)
}

export function deleteEvent(id: string): void {
  getDb().prepare('DELETE FROM events WHERE id = ?').run(id)
}

/** Find a synced event by its CalDAV UID, scoped to one person's calendar. */
export function findByUid(uid: string, personId: string): CalEvent | undefined {
  return getDb()
    .prepare('SELECT * FROM events WHERE caldav_uid = ? AND person_id = ?')
    .get(uid, personId) as CalEvent | undefined
}
