import { createDAVClient, type DAVCalendar } from 'tsdav'
import { getDb } from './db.js'
import { getPerson, listPeople } from './people.js'
import { getCalDavConfig, setCalDavConfig, type CalDavConfig } from './settings.js'
import { getEvent } from './events.js'
import { buildICS, editICSScoped, excludeICSOccurrence, icsResourceUid, parseICSOccurrences, type ICSInput } from './ics.js'
import { calendarUrlContains, ensureRemoteCalendarInstancesForRange, type CalendarResource } from './calendarResources.js'
import type { CalEvent } from './types.js'
import { applyResourceChanges, resourceChanges } from './calendarResourceChanges.js'

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>
type Tombstone = { person_id: string; uid: string; recurrence_id: string; url: string | null; etag: string | null }
const ICLOUD_URL = 'https://caldav.icloud.com'
const flights = new Map<string, Promise<SyncResult>>()
const queued = new Set<string>()
const completionCallbacks = new Map<string, Set<() => void>>()
let syncPauseDepth = 0
let resumeSync: (() => void) | undefined
let syncResumed: Promise<void> | undefined

/** Restore waits for writers, and blocks new calendar requests until its DB is ready. */
export async function withCalendarSyncPaused<T>(operation: () => T | Promise<T>): Promise<T> {
  if (syncPauseDepth++ === 0) syncResumed = new Promise<void>((resolve) => { resumeSync = resolve })
  try {
    await Promise.allSettled([...flights.values()])
    return await operation()
  } finally {
    if (--syncPauseDepth === 0) {
      const release = resumeSync
      resumeSync = undefined
      syncResumed = undefined
      release?.()
      for (const personId of [...queued]) {
        queued.delete(personId)
        queueCalendarSync(personId)
      }
    }
  }
}

const networkFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })
const checkedFetch: typeof fetch = async (input, init) => {
  const response = await networkFetch(input, init)
  if (!response.ok) throw new Error(`Calendar request failed (HTTP ${response.status}).`)
  return response
}

async function connect(config: CalDavConfig): Promise<DAVClient> {
  return createDAVClient({ serverUrl: config.serverUrl || ICLOUD_URL,
    credentials: { username: config.username, password: config.password },
    authMethod: 'Basic', defaultAccountType: 'caldav', fetch: networkFetch })
}

function displayName(calendar: DAVCalendar): string {
  return typeof calendar.displayName === 'string' ? calendar.displayName : calendar.url ?? 'Calendar'
}

async function pickCalendar(client: DAVClient, config: CalDavConfig): Promise<DAVCalendar> {
  const calendars = (await client.fetchCalendars()).filter((calendar) => !Array.isArray(calendar.components) || calendar.components.includes('VEVENT'))
  const selected = config.calendarUrl ? calendars.find((calendar) => calendar.url === config.calendarUrl)
    : config.calendarName ? calendars.find((calendar) => displayName(calendar) === config.calendarName) : calendars[0]
  if (!selected?.url) throw new Error('The selected calendar is unavailable. Select a calendar again in Settings.')
  return selected
}

export interface CalendarInfo { url: string; name: string }
export async function testConnection(config: CalDavConfig): Promise<CalendarInfo[]> {
  const calendars = await (await connect(config)).fetchCalendars()
  return calendars.filter((calendar) => !Array.isArray(calendar.components) || calendar.components.includes('VEVENT'))
    .map((calendar) => ({ url: calendar.url ?? '', name: displayName(calendar) }))
}

export interface SyncResult { pulled: number; pushed: number; calendar: string; person: string }

function configurationMatches(personId: string, expected: CalDavConfig): boolean {
  const current = getCalDavConfig(personId)
  return !!getPerson(personId) && !!current && current.serverUrl === expected.serverUrl &&
    current.username === expected.username && current.password === expected.password && current.calendarUrl === expected.calendarUrl &&
    current.calendarName === expected.calendarName
}

function checkConfiguration(personId: string, expected: CalDavConfig): void {
  if (!configurationMatches(personId, expected)) throw new Error('The calendar connection changed during sync. Try syncing again.')
}

function checkResponse(response: Response, operation: string, allowMissing = false): void {
  if (!response?.ok && !(allowMissing && response?.status === 404)) {
    throw new Error(`${operation} failed (HTTP ${response?.status ?? 'unknown'}). Your local change is saved and will retry.`)
  }
}

function eventInput(event: CalEvent, uid: string): ICSInput {
  return { uid, summary: event.title, location: event.location, description: event.notes,
    start: event.starts_at, end: event.ends_at, allDay: event.all_day === 1,
    attendees: event.attendees, color: event.color, shared: event.shared === 1 }
}

function contentKey(event: CalEvent): string {
  return JSON.stringify([event.person_id, event.title, event.location, event.notes, event.starts_at, event.ends_at, event.all_day, event.caldav_recurrence_id,
    event.attendees, event.color, event.shared])
}

function saveResource(resource: CalendarResource): void {
  getDb().prepare(`INSERT INTO calendar_resources (person_id,uid,url,etag,ics) VALUES (?,?,?,?,?)
    ON CONFLICT(person_id,uid) DO UPDATE SET url=excluded.url,etag=excluded.etag,ics=excluded.ics`)
    .run(resource.person_id, resource.uid, resource.url, resource.etag, resource.ics)
}

function hasPendingChanges(personId: string): boolean {
  const db = getDb()
  const calendarUrl = getCalDavConfig(personId)?.calendarUrl
  const pending = db.prepare(`SELECT caldav_url AS url FROM events WHERE person_id = ? AND recurrence IS NULL AND
    (calendar_dirty = 1 OR (source = 'local' AND caldav_recurrence_id IS NULL))
    UNION ALL SELECT url FROM calendar_tombstones WHERE person_id = ?
    UNION ALL SELECT url FROM calendar_resource_changes WHERE person_id = ?`).all(personId, personId, personId) as { url: string | null }[]
  return pending.some((row) => !row.url || !calendarUrl || calendarUrlContains(calendarUrl, row.url))
}

/** Serialize manual/full syncs per profile; parallel profiles keep independent calendars. */
export function syncCalendar(personId: string): Promise<SyncResult> {
  if (syncPauseDepth && syncResumed) return syncResumed.then(() => syncCalendar(personId))
  const existing = flights.get(personId)
  if (existing) return existing
  let completed = false
  const operation = performSync(personId).then((result) => { completed = true; return result }).finally(() => {
    flights.delete(personId)
    if (queued.delete(personId) && hasPendingChanges(personId)) queueCalendarSync(personId)
    else if (completed) {
      const callbacks = completionCallbacks.get(personId)
      completionCallbacks.delete(personId)
      for (const callback of callbacks ?? []) {
        try { void Promise.resolve(callback()).catch((error: unknown) => console.error('[doneline] calendar refresh failed:', error)) }
        catch (error) { console.error('[doneline] calendar refresh failed:', error) }
      }
    }
  })
  flights.set(personId, operation)
  return operation
}

/** Schedule saved edits/deletions without making renderer mutations wait for iCloud. */
export function queueCalendarSync(personId?: string, onComplete?: () => void): void {
  for (const id of personId ? [personId] : listPeople().map((person) => person.id)) {
    if (!getCalDavConfig(id) || !hasPendingChanges(id)) continue
    if (onComplete) {
      const callbacks = completionCallbacks.get(id) ?? new Set<() => void>()
      callbacks.add(onComplete)
      completionCallbacks.set(id, callbacks)
    }
    if (syncPauseDepth) { queued.add(id); continue }
    if (flights.has(id)) { queued.add(id); continue }
    void syncCalendar(id).catch((error: unknown) => {
      console.error('[doneline] calendar sync will retry:', error instanceof Error ? error.message : 'Calendar unavailable')
    })
  }
}

async function performSync(personId: string): Promise<SyncResult> {
  let config = getCalDavConfig(personId)
  if (!config || !getPerson(personId)) throw new Error('CalDAV is not configured for this profile. Connect a calendar first.')
  const client = await connect(config)
  checkConfiguration(personId, config)
  const calendar = await pickCalendar(client, config)
  checkConfiguration(personId, config)
  if (calendar.url !== config.calendarUrl) {
    config = { ...config, calendarUrl: calendar.url, calendarName: displayName(calendar) }
    setCalDavConfig(personId, config)
  }
  const objects = await client.fetchCalendarObjects({ calendar, fetch: checkedFetch })
  checkConfiguration(personId, config)
  if (!Array.isArray(objects)) throw new Error('The calendar server returned an invalid response.')
  const resources = new Map<string, CalendarResource>()
  const remoteUrls = new Set(objects.map((object) => object.url).filter(Boolean))
  for (const object of objects) {
    if (!object.data) continue
    const uid = icsResourceUid(object.data)
    if (!uid) continue // An unreadable resource must not authorize removing its URL.
    resources.set(uid, { person_id: personId, uid, url: object.url ?? null, etag: object.etag ?? null, ics: object.data })
  }
  let pushed = 0
  const db = getDb()
  // Restoring a backup/Trash item never invents a partial remote repeat rule.
  // A missing UID becomes an independent local event; an existing UID keeps its
  // identity and is updated against the freshly fetched resource below.
  const restored = db.prepare('SELECT * FROM events WHERE person_id = ? AND calendar_restore = 1').all(personId) as CalEvent[]
  for (const event of restored) {
    if (event.caldav_url && !calendarUrlContains(calendar.url, event.caldav_url)) continue
    if (!event.caldav_uid || (!resources.has(event.caldav_uid) && !(event.caldav_url && remoteUrls.has(event.caldav_url)))) {
      db.prepare(`UPDATE events SET caldav_uid = NULL, caldav_url = NULL, caldav_etag = NULL, caldav_recurrence_id = NULL,
        source = 'local', calendar_dirty = 0, calendar_restore = 0 WHERE id = ?`).run(event.id)
    }
  }
  // Apply ordered, durable scoped edits to the latest remote resource, using its
  // current ETag. A command added while PUT is in flight remains queued.
  const changes = resourceChanges(personId)
  for (const uid of new Set(changes.map((change) => change.uid))) {
    checkConfiguration(personId, config)
    const pending = changes.filter((change) => change.uid === uid && (!change.url || calendarUrlContains(calendar.url, change.url)))
    if (!pending.length) continue
    const resource = resources.get(uid)
    if (!resource) throw new Error('The remote repeating event is unavailable. Its saved edit will remain pending until you reconnect or restore it.')
    const applicable = pending.filter((change) => !change.url || change.url === resource.url)
    if (!applicable.length) continue
    const ics = applyResourceChanges(resource, applicable)
    const response = await client.updateCalendarObject({ calendarObject: { url: resource.url!, etag: resource.etag ?? undefined, data: ics } })
    checkResponse(response, 'Saving the repeating calendar event')
    checkConfiguration(personId, config)
    resource.ics = ics
    resource.etag = response.headers.get('etag')
    db.transaction(() => {
      saveResource(resource)
      for (const change of applicable) db.prepare('DELETE FROM calendar_resource_changes WHERE id = ?').run(change.id)
      db.prepare('UPDATE events SET calendar_restore = 0 WHERE person_id = ? AND caldav_uid = ? AND calendar_dirty = 0').run(personId, uid)
    }).immediate()
    if (resourceChanges(personId, uid).length) queued.add(personId)
    pushed++
  }
  // Read tombstones after fetch: local deletions may happen while the request is in flight.
  const deletions = db.prepare('SELECT * FROM calendar_tombstones WHERE person_id = ?').all(personId) as Tombstone[]
  for (const deletion of deletions) {
    checkConfiguration(personId, config)
    if (deletion.url && !calendarUrlContains(calendar.url, deletion.url)) continue
    const resource = resources.get(deletion.uid)
    if (!resource) {
      // If its URL was returned but data could not be read, keep it pending.
      if (deletion.url && remoteUrls.has(deletion.url)) continue
      db.prepare('DELETE FROM calendar_tombstones WHERE person_id = ? AND uid = ? AND recurrence_id = ?').run(personId, deletion.uid, deletion.recurrence_id)
      db.prepare('DELETE FROM calendar_resources WHERE person_id = ? AND uid = ?').run(personId, deletion.uid)
      continue
    }
    if (deletion.recurrence_id) {
      const ics = excludeICSOccurrence(resource.ics, deletion.uid, deletion.recurrence_id)
      const response = await client.updateCalendarObject({ calendarObject: { url: resource.url!, etag: resource.etag ?? undefined, data: ics } })
      checkResponse(response, 'Removing this calendar occurrence')
      checkConfiguration(personId, config)
      resource.ics = ics
      resource.etag = response.headers.get('etag')
      saveResource(resource)
    } else {
      const response = await client.deleteCalendarObject({ calendarObject: { url: resource.url!, etag: resource.etag ?? undefined } })
      checkResponse(response, 'Removing the calendar event', true)
      checkConfiguration(personId, config)
      resources.delete(deletion.uid)
      remoteUrls.delete(resource.url!)
      db.prepare('DELETE FROM calendar_resources WHERE person_id = ? AND uid = ?').run(personId, deletion.uid)
    }
    db.prepare('DELETE FROM calendar_tombstones WHERE person_id = ? AND uid = ? AND recurrence_id = ?').run(personId, deletion.uid, deletion.recurrence_id)
    pushed++
  }

  // Remote removals remove clean imported rows; they must never be re-uploaded.
  const imported = db.prepare("SELECT * FROM events WHERE person_id = ? AND source = 'caldav' AND calendar_dirty = 0").all(personId) as CalEvent[]
  for (const event of imported) {
    if (event.caldav_url && !calendarUrlContains(calendar.url, event.caldav_url)) continue
    if (!resources.has(event.caldav_uid!) && !(event.caldav_url && remoteUrls.has(event.caldav_url))) {
      db.prepare('DELETE FROM events WHERE id = ?').run(event.id)
      db.prepare('DELETE FROM calendar_resources WHERE person_id = ? AND uid = ?').run(personId, event.caldav_uid)
    }
  }
  const from = new Date(); from.setDate(from.getDate() - 90); from.setHours(0, 0, 0, 0)
  const to = new Date(); to.setDate(to.getDate() + 367); to.setHours(0, 0, 0, 0)
  for (const resource of resources.values()) {
    // Validate before replacing cache so unsupported/corrupt data cannot erase existing events.
    parseICSOccurrences(resource.ics, from, to)
    saveResource(resource)
  }
  let pulled = ensureRemoteCalendarInstancesForRange(from, to, personId)

  const locals = db.prepare(`SELECT * FROM events WHERE person_id = ? AND recurrence IS NULL
    AND (calendar_dirty = 1 OR source = 'local') ORDER BY created_at`).all(personId) as CalEvent[]
  for (const snapshot of locals) {
    checkConfiguration(personId, config)
    const event = getEvent(snapshot.id)
    if (!event || event.person_id !== personId) continue
    if (event.caldav_url && !calendarUrlContains(calendar.url, event.caldav_url)) continue
    const uid = event.caldav_uid || `doneline-${event.id}`
    const resource = resources.get(uid)
    if (event.caldav_recurrence_id && !resource) throw new Error('The remote repeat rule is unavailable. Your occurrence edit is saved; sync again before retrying.')
    const input = eventInput(event, uid)
    const ics = resource ? editICSScoped(resource.ics, input, 'occurrence', event.caldav_recurrence_id) : buildICS(input)
    const url = resource?.url || event.caldav_url || new URL(`${encodeURIComponent(uid)}.ics`, calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`).href
    // Reserve metadata before the request so a delete during upload gets a tombstone.
    db.prepare('UPDATE events SET caldav_uid = ?, caldav_url = ?, calendar_dirty = 1 WHERE id = ?').run(uid, url, event.id)
    const response = resource ? await client.updateCalendarObject({ calendarObject: { url, data: ics, etag: resource.etag ?? undefined } })
      : await client.createCalendarObject({ calendar, filename: `${encodeURIComponent(uid)}.ics`, iCalString: ics })
    checkResponse(response, 'Saving the calendar event')
    checkConfiguration(personId, config)
    const saved: CalendarResource = { person_id: personId, uid, url, etag: response.headers.get('etag'), ics }
    resources.set(uid, saved)
    saveResource(saved)
    const current = getEvent(event.id)
    if (current && current.person_id === personId && current.caldav_uid === uid) {
      const dirty = contentKey(current) === contentKey(event) ? 0 : 1
      db.prepare("UPDATE events SET source = 'caldav', caldav_etag = ?, calendar_dirty = ?, calendar_restore = ? WHERE id = ?").run(saved.etag, dirty, dirty ? current.calendar_restore ?? 0 : 0, event.id)
      if (dirty) queued.add(personId)
    } else {
      queued.add(personId)
      if (current && current.person_id !== personId) queueCalendarSync(current.person_id)
    }
    pushed++
  }
  pulled += ensureRemoteCalendarInstancesForRange(from, to, personId)
  return { pulled, pushed, calendar: displayName(calendar), person: personId }
}

/** Kept for MCP callers; normal UI writes now schedule durable sync. */
export async function pushEvent(eventId: string): Promise<void> {
  const event = getEvent(eventId)
  if (event && getCalDavConfig(event.person_id)) await syncCalendar(event.person_id)
}
export async function updateRemoteEvent(eventId: string): Promise<void> { await pushEvent(eventId) }
export async function deleteRemoteEvent(eventId: string): Promise<void> {
  const event = getEvent(eventId)
  if (!event?.caldav_uid) return
  getDb().prepare(`INSERT OR REPLACE INTO calendar_tombstones (person_id,uid,recurrence_id,url,etag) VALUES (?,?,?,?,?)`)
    .run(event.person_id, event.caldav_uid, event.caldav_recurrence_id ?? '', event.caldav_url, event.caldav_etag)
  if (getCalDavConfig(event.person_id)) await syncCalendar(event.person_id)
}
