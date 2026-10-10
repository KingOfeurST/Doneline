import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { createEvent, getEvent, updateEvent } from './events.js'
import { ensureEventInstancesForRange } from './recurrence.js'
import { calendarDayDifference, localCalendarDate, localDateKey, normalizeRecurrence, occurrenceTimes, parseRecurrence, recurrenceMatchesDate } from './recurrenceRules.js'
import { applyResourceChanges, type CalendarResourcePatch } from './calendarResourceChanges.js'
import type { CalendarResource } from './calendarResources.js'
import { ensureRemoteCalendarInstancesForRange } from './calendarResources.js'
import { parseICS, parseICSOccurrences } from './ics.js'
import type { CalEvent, Recurrence } from './types.js'
import { effectiveRuleExclusions } from './exclusions.js'

export type EventEditScope = 'occurrence' | 'future' | 'series'
export type EventEditPatch = Partial<Omit<CalEvent, 'id' | 'created_at'>>
export interface EventSeriesContext {
  event: CalEvent
  template: CalEvent | null
  recurrence: Recurrence | null
  scopes: EventEditScope[]
  remote: boolean
  remoteDates?: string[]
  limitation?: string
}

function remoteResource(event: CalEvent): CalendarResource | undefined {
  return getDb().prepare('SELECT * FROM calendar_resources WHERE person_id = ? AND uid = ?').get(event.person_id, event.caldav_uid) as CalendarResource | undefined
}

export function getEventSeriesContext(id: string): EventSeriesContext | undefined {
  const event = getEvent(id)
  if (!event) return undefined
  const template = event.recurrence ? event : event.recur_parent ? getEvent(event.recur_parent) : undefined
  if (template?.recurrence) {
    const parsed = parseRecurrence(template.recurrence, localDateKey(new Date(template.starts_at)))
    const recurrence = parsed ? effectiveRuleExclusions('events', template.id, parsed) : null
    return { event, template: { ...template, recurrence: recurrence ? JSON.stringify(recurrence) : template.recurrence }, recurrence,
      scopes: event.recurrence ? ['series'] : ['occurrence', 'future', 'series'], remote: false }
  }
  if (event.caldav_recurrence_id) {
    const resource = remoteResource(event)
    if (resource) {
      const ics = applyResourceChanges(resource)
      const master = parseICS(ics)
      if (master) {
        const from = localCalendarDate(new Date(event.starts_at)); const to = new Date(from); to.setFullYear(to.getFullYear() + 1)
        const dates = parseICSOccurrences(ics, from, to).slice(0, 12).map((row) => localDateKey(new Date(row.start)))
        return { event, template: { ...event, title: master.summary, starts_at: master.start, ends_at: master.end, all_day: Number(master.allDay),
          location: master.location ?? null, notes: master.description ?? null, caldav_recurrence_id: null }, recurrence: null,
          scopes: ['occurrence', 'future', 'series'], remote: true, remoteDates: dates,
          limitation: 'Event details and times can change here. Change Apple Calendar repeat weekdays or date bounds in Apple Calendar.' }
      }
    }
    return { event, template: null, recurrence: null, scopes: ['occurrence'], remote: true,
      limitation: 'Sync this calendar before editing its whole repeating series.' }
  }
  return { event, template: null, recurrence: null, scopes: ['occurrence'], remote: false }
}

function generatedFields(template: CalEvent, day: Date): EventEditPatch {
  const times = occurrenceTimes(new Date(template.starts_at), new Date(template.ends_at), day)
  return { person_id: template.person_id, title: template.title, location: template.location, notes: template.notes,
    starts_at: times.start.toISOString(), ends_at: times.end.toISOString(), all_day: template.all_day,
    color: template.color, shared: template.shared, attendees: template.attendees }
}

/** Internal regeneration is not a user deletion and must never fill Trash. */
function removeGenerated(event: CalEvent): void {
  const db = getDb()
  if (event.caldav_uid) db.prepare(`INSERT OR REPLACE INTO calendar_tombstones (person_id,uid,recurrence_id,url,etag) VALUES (?,?,?,?,?)`)
    .run(event.person_id, event.caldav_uid, event.caldav_recurrence_id ?? '', event.caldav_url, event.caldav_etag)
  db.prepare('DELETE FROM events WHERE id = ?').run(event.id)
}

function refreshExisting(template: CalEvent, children: CalEvent[], dayOffset = 0): void {
  const parsed = parseRecurrence(template.recurrence, localDateKey(new Date(template.starts_at)))
  const rule = parsed ? effectiveRuleExclusions('events', template.id, parsed) : null
  for (const child of children) {
    // A changed date has a different deterministic identity. Reusing its old ID
    // would collide when that original date is materialized on another device.
    if (dayOffset) { removeGenerated(child); continue }
    const day = localCalendarDate(new Date(child.starts_at)); day.setDate(day.getDate() + dayOffset)
    if (!rule || !recurrenceMatchesDate(rule, day)) { removeGenerated(child); continue }
    updateEvent(child.id, { ...generatedFields(template, day), recur_parent: template.id }, { detachOccurrence: false })
  }
}

function generationRange(template: CalEvent, children: CalEvent[]): void {
  const first = localCalendarDate(new Date(template.starts_at)); const last = new Date(first); last.setDate(last.getDate() + 59)
  const ranges = [{ from: first, to: last }]
  for (const child of children) {
    const from = localCalendarDate(new Date(child.starts_at)); const to = new Date(from)
    from.setDate(from.getDate() - 6); to.setDate(to.getDate() + 6)
    ranges.push({ from, to })
  }
  ranges.sort((a, b) => a.from.getTime() - b.from.getTime())
  const merged: typeof ranges = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to) { if (range.to > previous.to) previous.to = range.to }
    else merged.push(range)
  }
  // Refresh only this rule and the already visited date windows. Editing a
  // decades-old series must not materialize every intervening day or other rules.
  for (const range of merged) ensureEventInstancesForRange(range.from, range.to, template.id)
}

function updateLocalSeries(event: CalEvent, template: CalEvent, patch: EventEditPatch, scope: EventEditScope): CalEvent | undefined {
  if (scope === 'occurrence' && !event.recurrence) return updateEvent(event.id, patch)
  const db = getDb()
  const parsed = parseRecurrence(template.recurrence, localDateKey(new Date(template.starts_at)))
  const rule = parsed ? effectiveRuleExclusions('events', template.id, parsed) : null
  const children = db.prepare('SELECT * FROM events WHERE recur_parent = ? ORDER BY starts_at').all(template.id) as CalEvent[]
  if (scope === 'series' || event.recurrence) {
    const before = localCalendarDate(new Date(template.starts_at))
    const updated = updateEvent(template.id, patch, { regenerateChildren: false })!
    const offset = calendarDayDifference(before, new Date(updated.starts_at))
    refreshExisting(updated, children, offset)
    if (updated.recurrence) generationRange(updated, children)
    return updated
  }
  if (!rule) throw new Error('Repair the saved repeat rule before changing its series.')
  const cut = localDateKey(new Date(event.starts_at))
  const future = children.filter((child) => localDateKey(new Date(child.starts_at)) >= cut)
  const dayBefore = localCalendarDate(cut); dayBefore.setDate(dayBefore.getDate() - 1)
  const newStart = patch.starts_at ?? event.starts_at
  const startDay = localDateKey(new Date(newStart))
  if (startDay < cut) throw new Error('This and future events must start on or after the selected occurrence. Choose Entire series to move the whole schedule earlier.')
  let nextRule: Recurrence | null = null
  if (patch.recurrence !== null) {
    const submitted = patch.recurrence !== undefined ? parseRecurrence(patch.recurrence, startDay) : { ...rule, startDate: startDay }
    if (!submitted) throw new Error('Choose a valid repeat schedule.')
    const exclusions = [...new Set([...(submitted.excludedDates ?? []), ...(rule.excludedDates ?? []).filter((day) => day >= cut)])]
    nextRule = normalizeRecurrence({ ...submitted, startDate: submitted.startDate && submitted.startDate > startDay ? submitted.startDate : startDay,
      excludedDates: exclusions }, startDay)
  }
  const owner = patch.person_id ?? event.person_id
  const { recurrence: _recurrence, ...datedPatch } = patch
  const merged = updateEvent(event.id, datedPatch, { detachOccurrence: false })!
  const replacement = createEvent({ title: merged.title, person_id: owner, starts_at: newStart, ends_at: merged.ends_at,
    all_day: !!merged.all_day, shared: !!merged.shared, color: merged.color, location: merged.location, notes: merged.notes,
    attendees: merged.attendees, recurrence: nextRule ? JSON.stringify(nextRule) : null })
  if (rule.startDate && localDateKey(dayBefore) < rule.startDate) {
    // Splitting at the first date has no earlier rule to retain.
    db.prepare('DELETE FROM events WHERE id = ?').run(template.id)
  } else {
    updateEvent(template.id, { recurrence: JSON.stringify({ ...rule, endDate: localDateKey(dayBefore) }) }, { regenerateChildren: false })
  }
  if (nextRule) {
    // The new parent gives these dates a new deterministic identity on every
    // device. Earlier rows retain their IDs; future rows are regenerated.
    for (const child of future) removeGenerated(child)
    generationRange(replacement, future)
  } else for (const child of future) removeGenerated(child)
  // Earlier children retain their IDs, attributes and original parent unchanged.
  return replacement
}

function updateRemoteSeries(event: CalEvent, patch: EventEditPatch, scope: EventEditScope): CalEvent | undefined {
  if (scope === 'occurrence') return updateEvent(event.id, patch)
  const resource = remoteResource(event)
  if (!resource || !event.caldav_recurrence_id) throw new Error('Sync this repeating calendar before changing its series.')
  if ('recurrence' in patch) throw new Error('Change Apple Calendar repeat weekdays or date bounds in Apple Calendar.')
  if (patch.person_id !== undefined && patch.person_id !== event.person_id) throw new Error('Move a repeating Apple Calendar series to another owner in Apple Calendar.')
  const db = getDb()
  const pendingDeletes = db.prepare('SELECT recurrence_id FROM calendar_tombstones WHERE person_id = ? AND uid = ? AND recurrence_id <> ?')
    .all(event.person_id, event.caldav_uid, '') as { recurrence_id: string }[]
  for (const deletion of pendingDeletes) {
    const exclusion: CalendarResourcePatch = { scope: 'exclude', uid: event.caldav_uid!, recurrenceId: deletion.recurrence_id }
    db.prepare('INSERT INTO calendar_resource_changes (id,person_id,uid,url,patch) VALUES (?,?,?,?,?)')
      .run(uuid(), event.person_id, event.caldav_uid, resource.url, JSON.stringify(exclusion))
    db.prepare('DELETE FROM calendar_tombstones WHERE person_id = ? AND uid = ? AND recurrence_id = ?')
      .run(event.person_id, event.caldav_uid, deletion.recurrence_id)
  }
  // Earlier offline single-date edits must be composed before changing the
  // master clock/identities. Otherwise their old recurrence IDs could duplicate
  // a date when the background writer eventually retries them.
  const pendingOccurrences = db.prepare('SELECT * FROM events WHERE person_id = ? AND caldav_uid = ? AND calendar_dirty = 1')
    .all(event.person_id, event.caldav_uid) as CalEvent[]
  for (const pending of pendingOccurrences) {
    const occurrence: CalendarResourcePatch = { scope: 'occurrence', recurrenceId: pending.caldav_recurrence_id, input: {
      uid: event.caldav_uid!, summary: pending.title, start: pending.starts_at, end: pending.ends_at, allDay: !!pending.all_day,
      location: pending.location, description: pending.notes, attendees: pending.attendees, color: pending.color, shared: !!pending.shared } }
    db.prepare('INSERT INTO calendar_resource_changes (id,person_id,uid,url,patch) VALUES (?,?,?,?,?)')
      .run(uuid(), event.person_id, event.caldav_uid, resource.url, JSON.stringify(occurrence))
    db.prepare('UPDATE events SET calendar_dirty = 0 WHERE id = ?').run(pending.id)
  }
  const context = getEventSeriesContext(event.id)!
  const basis = scope === 'series' ? context.template! : event
  const from = localCalendarDate(new Date(basis.starts_at)); const to = new Date(from); to.setFullYear(to.getFullYear() + 1)
  const original = parseICSOccurrences(applyResourceChanges(resource), from, to)
  const ordinal = original.findIndex((row) => row.recurrenceId === event.caldav_recurrence_id)
  // Validate with the ordinary writer, but roll back its occurrence detachment:
  // scoped remote edits live as ordered durable resource commands instead.
  const updated = updateEvent(event.id, { ...patch, source: 'caldav' })!
  const inputEvent = { ...basis, ...patch, starts_at: updated.starts_at, ends_at: updated.ends_at }
  const change: CalendarResourcePatch = { scope, recurrenceId: event.caldav_recurrence_id, input: {
    uid: event.caldav_uid!, summary: inputEvent.title, start: inputEvent.starts_at, end: inputEvent.ends_at,
    allDay: !!inputEvent.all_day, location: inputEvent.location, description: inputEvent.notes,
    attendees: inputEvent.attendees, color: inputEvent.color, shared: !!inputEvent.shared } }
  const id = uuid()
  db.prepare('INSERT INTO calendar_resource_changes (id,person_id,uid,url,patch) VALUES (?,?,?,?,?)')
    .run(id, event.person_id, event.caldav_uid, resource.url, JSON.stringify(change))
  // Reject unsupported remote time/type changes before acknowledging the edit.
  applyResourceChanges(resource)
  db.prepare('UPDATE events SET calendar_dirty = 0 WHERE id = ?').run(event.id)
  // Expansion overlays the new command, so all affected visible dates update now.
  const rows = parseICSOccurrences(applyResourceChanges(resource), from, to)
  ensureRemoteCalendarInstancesForRange(from, to, event.person_id)
  const identity = scope === 'series' && ordinal >= 0 ? rows[ordinal]?.recurrenceId : event.caldav_recurrence_id
  return db.prepare(`SELECT * FROM events WHERE person_id = ? AND caldav_uid = ? AND caldav_recurrence_id = ?`)
    .get(event.person_id, event.caldav_uid, identity) as CalEvent | undefined
}

/** Every scope is atomic in the local database; failed validation leaves history intact. */
export function updateEventSeries(id: string, patch: EventEditPatch, scope: EventEditScope): CalEvent | undefined {
  if (!['occurrence', 'future', 'series'].includes(scope)) throw new Error('Choose an editing scope.')
  const db = getDb()
  const operation = () => {
    const context = getEventSeriesContext(id)
    if (!context) return undefined
    if (!context.scopes.includes(scope)) throw new Error('This event does not support the selected editing scope.')
    // Remote identity, rule parent and source are managed by the backend.
    const editable = Object.fromEntries(Object.entries(patch).filter(([key]) => ['title', 'person_id', 'starts_at', 'ends_at', 'all_day', 'shared', 'location', 'notes', 'color', 'attendees', 'recurrence'].includes(key))) as EventEditPatch
    if (context.remote) return updateRemoteSeries(context.event, editable, scope)
    return context.template ? updateLocalSeries(context.event, context.template, editable, scope) : updateEvent(id, editable)
  }
  return db.inTransaction ? operation() : db.transaction(operation).immediate()
}
