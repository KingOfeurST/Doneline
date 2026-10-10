import { getDb } from './db.js'
import { v5 as uuidv5 } from 'uuid'
import { createEvent, updateEvent } from './events.js'
import { parseICSOccurrences } from './ics.js'
import { getCalDavConfig } from './settings.js'
import type { CalEvent } from './types.js'
import { assertCalendarRange, localCalendarDate } from './recurrenceRules.js'
import { applyResourceChanges } from './calendarResourceChanges.js'

export interface CalendarResource {
  person_id: string
  uid: string
  url: string | null
  etag: string | null
  ics: string
}

export function remoteCalendarInstanceId(personId: string, uid: string, recurrenceId?: string | null): string {
  return uuidv5(JSON.stringify(['doneline', 'caldav', personId, uid, recurrenceId ?? '']), uuidv5.URL)
}

export function calendarUrlContains(calendarUrl: string, objectUrl: string | null): boolean {
  if (!objectUrl) return false
  try {
    const calendar = new URL(calendarUrl)
    const object = new URL(objectUrl, calendarUrl)
    const base = calendar.pathname.endsWith('/') ? calendar.pathname : `${calendar.pathname}/`
    return calendar.origin === object.origin && object.pathname.startsWith(base)
  } catch { return false }
}

/** Cached remote resources let calendar navigation expand any date without network access. */
export function ensureRemoteCalendarInstancesForRange(from: string | Date, to: string | Date, personId?: string): number {
  const start = new Date(from)
  const end = new Date(to)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('Invalid calendar range.')
  assertCalendarRange(localCalendarDate(start), localCalendarDate(new Date(end.getTime() - 1)))
  const db = getDb()
  const resources = db.prepare(`SELECT r.* FROM calendar_resources r JOIN people p ON p.id = r.person_id
    ${personId && personId !== 'all' ? 'WHERE r.person_id = ? OR EXISTS (SELECT 1 FROM events e WHERE e.person_id = r.person_id AND e.caldav_uid = r.uid AND e.shared = 1)' : ''}`)
    .all(...(personId && personId !== 'all' ? [personId] : [])) as CalendarResource[]
  let changed = 0
  const generate = () => {
    for (const resource of resources) {
      const config = getCalDavConfig(resource.person_id)
      if (config?.calendarUrl && !calendarUrlContains(config.calendarUrl, resource.url)) continue
      const tombstones = db.prepare('SELECT recurrence_id FROM calendar_tombstones WHERE person_id = ? AND uid = ?').all(resource.person_id, resource.uid) as { recurrence_id: string }[]
      if (tombstones.some((row) => !row.recurrence_id)) continue
      const excluded = new Set(tombstones.map((row) => row.recurrence_id))
      let occurrences
      try { occurrences = parseICSOccurrences(applyResourceChanges(resource), from, to) } catch { continue }
      const keys = new Set<string>()
      for (const event of occurrences) {
        const key = event.recurrenceId ?? ''
        keys.add(key)
        if (excluded.has(key)) continue
        const existing = db.prepare(`SELECT * FROM events WHERE person_id = ? AND caldav_uid = ?
          AND COALESCE(caldav_recurrence_id, '') = ?`).get(resource.person_id, event.uid, key) as CalEvent | undefined
        if (existing?.calendar_dirty) continue
        const fields = {
          person_id: resource.person_id, title: event.summary, location: event.location ?? null, notes: event.description ?? null,
          starts_at: event.start, ends_at: event.end, caldav_uid: event.uid, caldav_recurrence_id: event.recurrenceId ?? null,
          caldav_url: resource.url, caldav_etag: resource.etag, source: 'caldav' as const,
          ...(event.attendees !== undefined ? { attendees: event.attendees || null } : {}),
          ...(event.color !== undefined ? { color: event.color } : {})
        }
        if (existing) {
          if (existing.caldav_etag !== resource.etag || existing.starts_at !== event.start || existing.ends_at !== event.end ||
              existing.title !== event.summary || existing.location !== fields.location || existing.notes !== fields.notes || existing.all_day !== Number(event.allDay) ||
              (event.attendees !== undefined && existing.attendees !== fields.attendees) || (event.color !== undefined && existing.color !== event.color) ||
              (event.shared !== undefined && existing.shared !== Number(event.shared))) {
            updateEvent(existing.id, { ...fields, all_day: event.allDay ? 1 : 0, ...(event.shared !== undefined ? { shared: Number(event.shared) } : {}) })
            changed++
          }
        } else {
          const instanceId = remoteCalendarInstanceId(resource.person_id, event.uid, event.recurrenceId)
          if (db.prepare('SELECT 1 FROM events WHERE id = ?').get(instanceId)) continue
          createEvent({ ...fields, all_day: event.allDay, shared: event.shared }, { id: instanceId })
          changed++
        }
      }
      // A remote EXDATE or moved occurrence must remove its previously cached row.
      const cached = db.prepare(`SELECT * FROM events WHERE person_id = ? AND caldav_uid = ?
        AND starts_at < ? AND ends_at > ? AND calendar_dirty = 0`).all(resource.person_id, resource.uid,
          new Date(to).toISOString(), new Date(from).toISOString()) as CalEvent[]
      for (const event of cached) {
        if (!keys.has(event.caldav_recurrence_id ?? '')) {
          db.prepare('DELETE FROM events WHERE id = ?').run(event.id)
          changed++
        }
      }
    }
  }
  if (db.inTransaction) generate()
  else db.transaction(generate).immediate()
  return changed
}
