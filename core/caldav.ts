import { v4 as uuid } from 'uuid'
import { createDAVClient, type DAVCalendar } from 'tsdav'

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>
import { getDb } from './db.js'
import { getCalDavConfig, setCalDavConfig, type CalDavConfig } from './settings.js'
import { listEvents, createEvent, updateEvent, findByUid, getEvent } from './events.js'
import { parseICS, buildICS } from './ics.js'

const ICLOUD_URL = 'https://caldav.icloud.com'

async function connect(cfg: CalDavConfig): Promise<DAVClient> {
  const client = await createDAVClient({
    serverUrl: cfg.serverUrl || ICLOUD_URL,
    credentials: { username: cfg.username, password: cfg.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  })
  return client
}

async function pickCalendar(client: DAVClient, cfg: CalDavConfig): Promise<DAVCalendar> {
  const calendars = await client.fetchCalendars()
  const usable = calendars.filter((c) =>
    Array.isArray(c.components) ? c.components.includes('VEVENT') : true
  )
  let chosen: DAVCalendar | undefined
  if (cfg.calendarUrl) chosen = usable.find((c) => c.url === cfg.calendarUrl)
  if (!chosen && cfg.calendarName) {
    chosen = usable.find((c) => displayName(c) === cfg.calendarName)
  }
  chosen = chosen || usable[0]
  if (!chosen) throw new Error('No writable calendar found on this account.')
  return chosen
}

function displayName(c: DAVCalendar): string {
  const dn = c.displayName
  return typeof dn === 'string' ? dn : (c.url ?? 'Calendar')
}

export interface CalendarInfo {
  url: string
  name: string
}

/** Verify credentials and return the list of calendars on the account. */
export async function testConnection(cfg: CalDavConfig): Promise<CalendarInfo[]> {
  const client = await connect(cfg)
  const calendars = await client.fetchCalendars()
  return calendars
    .filter((c) => (Array.isArray(c.components) ? c.components.includes('VEVENT') : true))
    .map((c) => ({ url: c.url ?? '', name: displayName(c) }))
}

export interface SyncResult {
  pulled: number
  pushed: number
  calendar: string
  person: string
}

/**
 * Two-way sync for one person's configured CalDAV calendar.
 * - Pulls remote events into the local DB (upsert by UID, scoped to the person).
 * - Pushes that person's local-only events up to their calendar.
 */
export async function syncCalendar(personId: string): Promise<SyncResult> {
  const cfg = getCalDavConfig(personId)
  if (!cfg) throw new Error('CalDAV is not configured for this profile. Connect a calendar first.')

  const client = await connect(cfg)
  const calendar = await pickCalendar(client, cfg)

  // Persist the resolved calendar so future syncs are deterministic.
  if (calendar.url && calendar.url !== cfg.calendarUrl) {
    setCalDavConfig(personId, { ...cfg, calendarUrl: calendar.url, calendarName: displayName(calendar) })
  }

  // --- PULL ---
  const objects = await client.fetchCalendarObjects({ calendar })
  let pulled = 0
  for (const obj of objects) {
    if (!obj.data) continue
    const parsed = parseICS(obj.data)
    if (!parsed) continue
    const existing = findByUid(parsed.uid, personId)
    const fields = {
      person_id: personId,
      title: parsed.summary,
      location: parsed.location ?? null,
      notes: parsed.description ?? null,
      starts_at: parsed.start,
      ends_at: parsed.end,
      all_day: parsed.allDay,
      caldav_uid: parsed.uid,
      caldav_etag: obj.etag ?? null,
      caldav_url: obj.url ?? null,
      source: 'caldav' as const
    }
    if (existing) {
      if (existing.caldav_etag !== (obj.etag ?? null)) {
        updateEvent(existing.id, { ...fields, all_day: fields.all_day ? 1 : 0 })
        pulled++
      }
    } else {
      createEvent(fields)
      pulled++
    }
  }

  // Cross-check: events the DB thinks are on the server but aren't in the pull results.
  // This happens after a failed push (server rejected silently). Reset them so they get re-pushed.
  const remoteUids = new Set(
    objects
      .map((o) => { try { return parseICS(o.data ?? '')?.uid } catch { return undefined } })
      .filter(Boolean)
  )
  const db = getDb()
  const RESET = `UPDATE events SET caldav_uid = NULL, caldav_url = NULL, caldav_etag = NULL,
                        source = 'local'
                 WHERE person_id = ? AND source = 'caldav'`
  if (remoteUids.size > 0) {
    const ph = [...remoteUids].map(() => '?').join(',')
    db.prepare(`${RESET} AND caldav_uid NOT IN (${ph})`).run(personId, ...remoteUids)
  } else {
    // Remote calendar is empty: everything local still marked 'caldav' is an
    // orphan. `NOT IN (SELECT NULL)` evaluates to NULL and would match no rows,
    // so this case needs its own statement.
    db.prepare(RESET).run(personId)
  }

  // --- PUSH ---
  const locals = listEvents({ personId }).filter((e) => e.source === 'local' && !e.caldav_uid)
  let pushed = 0
  for (const ev of locals) {
    const uid = `doneline-${uuid()}`
    const ics = buildICS({
      uid,
      summary: ev.title,
      location: ev.location,
      description: ev.notes,
      start: ev.starts_at,
      end: ev.ends_at,
      allDay: ev.all_day === 1
    })
    const filename = `${uid}.ics`
    const res = await client.createCalendarObject({ calendar, filename, iCalString: ics })
    const url = (calendar.url ?? '') + filename
    updateEvent(ev.id, {
      caldav_uid: uid,
      caldav_url: url,
      caldav_etag: typeof res?.headers?.get === 'function' ? res.headers.get('etag') : null,
      source: 'caldav'
    })
    pushed++
  }

  return { pulled, pushed, calendar: displayName(calendar), person: personId }
}

/**
 * Remove an event from the remote calendar. Must run BEFORE the local row is
 * deleted (it reads the row for its UID/URL). Without this the next sync pulls
 * the event straight back from iCloud and it appears to un-delete itself.
 *
 * Best effort: a failure here shouldn't block the local delete.
 */
export async function deleteRemoteEvent(eventId: string): Promise<void> {
  const ev = getEvent(eventId)
  if (!ev || !ev.caldav_uid) return // never synced — nothing remote to remove
  const cfg = getCalDavConfig(ev.person_id)
  if (!cfg) return

  const client = await connect(cfg)
  const calendar = await pickCalendar(client, cfg)
  const url = ev.caldav_url || (calendar.url ?? '') + `${ev.caldav_uid}.ics`
  await client.deleteCalendarObject({
    calendarObject: { url, etag: ev.caldav_etag ?? undefined }
  })
}

/** Push a single local event immediately (used when adding from the app). */
export async function pushEvent(eventId: string): Promise<void> {
  const ev = getEvent(eventId)
  if (!ev || ev.caldav_uid) return
  const cfg = getCalDavConfig(ev.person_id)
  if (!cfg) return // this person has no calendar configured — stay local-only

  const client = await connect(cfg)
  const calendar = await pickCalendar(client, cfg)
  const uid = `doneline-${uuid()}`
  const ics = buildICS({
    uid,
    summary: ev.title,
    location: ev.location,
    description: ev.notes,
    start: ev.starts_at,
    end: ev.ends_at,
    allDay: ev.all_day === 1
  })
  const filename = `${uid}.ics`
  await client.createCalendarObject({ calendar, filename, iCalString: ics })
  updateEvent(ev.id, {
    caldav_uid: uid,
    caldav_url: (calendar.url ?? '') + filename,
    source: 'caldav'
  })
}
