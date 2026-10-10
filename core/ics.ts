import ICAL from 'ical.js'
import { assertCalendarRange, localCalendarDate, localDateKey, parseLocalDate } from './recurrenceRules.js'

export interface ParsedEvent {
  uid: string
  summary: string
  location?: string
  description?: string
  start: string
  end: string
  allDay: boolean
  recurrenceId?: string
  attendees?: string
  color?: string
  shared?: boolean
}

export interface ICSInput {
  uid: string
  summary: string
  location?: string | null
  description?: string | null
  start: string
  end: string
  allDay: boolean
  attendees?: string | null
  color?: string
  shared?: boolean
}

type CalendarTime = InstanceType<typeof ICAL.Time>
type CalendarEvent = InstanceType<typeof ICAL.Event>
type CalendarComponent = InstanceType<typeof ICAL.Component>
const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

/** Resolve IANA TZIDs when a server omits the matching VTIMEZONE component. */
function zonedDate(time: CalendarTime, zoneId: string): Date {
  const zone = zoneId.replace(/^.*\/Tzfile\//, '')
  let formatter = zoneFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    })
    if (zoneFormatters.size >= 128) zoneFormatters.clear()
    zoneFormatters.set(zone, formatter)
  }
  const format = formatter
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)
  function representedAt(instant: number): number {
    const parts = Object.fromEntries(format.formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  }
  // Sample both offsets around a transition. RFC 5545 chooses the first
  // repeated clock time, and uses the preceding offset for a missing one.
  const candidates = [...new Set([-2, -1, 0, 1, 2].map((days) => {
    const probe = wall + days * 86_400_000
    return wall - (representedAt(probe) - probe)
  }))]
  const exact = candidates.filter((instant) => representedAt(instant) === wall).sort((a, b) => a - b)
  if (exact.length) return new Date(exact[0])
  const afterGap = candidates.filter((instant) => representedAt(instant) > wall)
    .sort((a, b) => representedAt(a) - representedAt(b) || a - b)
  if (afterGap.length) return new Date(afterGap[0])
  throw new Error(`Cannot resolve calendar timezone ${zoneId}.`)
}

function dateFor(time: CalendarTime, event: CalendarEvent, property = 'dtstart'): Date {
  if (time.isDate) return parseLocalDate(`${String(time.year).padStart(4, '0')}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`)
  if (time.zone && time.zone.tzid !== 'floating') return time.toJSDate()
  const parameter = event.component.getFirstProperty(property)?.getParameter('tzid') ??
    event.component.getFirstProperty('dtstart')?.getParameter('tzid')
  if (typeof parameter === 'string' && parameter) return zonedDate(time, parameter)
  return new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)
}

function parsedEvent(event: CalendarEvent, start = event.startDate, end = event.endDate, recurrenceId?: string): ParsedEvent {
  if (!event.uid || !start) throw new Error('Calendar event has no UID or start date.')
  const startDate = dateFor(start, event)
  let endDate = end ? dateFor(end, event, 'dtend') : new Date(startDate)
  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) throw new Error('Calendar event contains an invalid date.')
  if (endDate <= startDate) {
    endDate = new Date(startDate)
    if (start.isDate) endDate.setDate(endDate.getDate() + 1)
    else endDate.setMinutes(endDate.getMinutes() + 1)
  }
  return {
    uid: event.uid, summary: event.summary?.trim() || '(Untitled event)',
    location: event.location || undefined, description: event.description || undefined,
    start: startDate.toISOString(), end: endDate.toISOString(), allDay: start.isDate,
    ...(event.component.hasProperty('x-doneline-attendees') ? { attendees: String(event.component.getFirstPropertyValue('x-doneline-attendees') ?? '') } : {}),
    ...(event.component.hasProperty('x-doneline-color') ? { color: String(event.component.getFirstPropertyValue('x-doneline-color')) } : {}),
    ...(event.component.hasProperty('x-doneline-shared') ? { shared: String(event.component.getFirstPropertyValue('x-doneline-shared')) === '1' } : {}),
    ...(recurrenceId ? { recurrenceId } : {})
  }
}

function calendar(ics: string): CalendarComponent {
  const component = new ICAL.Component(ICAL.parse(ics))
  if (component.name !== 'vcalendar') throw new Error('Invalid iCalendar resource.')
  return component
}

export function icsResourceUid(ics: string): string | null {
  try {
    const value = calendar(ics).getFirstSubcomponent('vevent')?.getFirstPropertyValue('uid')
    return typeof value === 'string' && value ? value : null
  } catch { return null }
}

export function parseICS(ics: string): ParsedEvent | null {
  try {
    const components = calendar(ics).getAllSubcomponents('vevent')
    const component = components.find((item) => !item.hasProperty('recurrence-id')) ?? components[0]
    return component ? parsedEvent(new ICAL.Event(component)) : null
  } catch { return null }
}

/** Expand RFC recurrence, EXDATE/RDATE and detached overrides for a half-open range. */
export function parseICSOccurrences(ics: string, from: string | Date, to: string | Date): ParsedEvent[] {
  const lower = new Date(from).getTime()
  const upper = new Date(to).getTime()
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower >= upper) throw new Error('Invalid calendar expansion range.')
  assertCalendarRange(localCalendarDate(new Date(lower)), localCalendarDate(new Date(upper - 1)))
  const components = calendar(ics).getAllSubcomponents('vevent')
  const masters = components.filter((item) => !item.hasProperty('recurrence-id'))
  const result = new Map<string, ParsedEvent>()
  const include = (event: ParsedEvent) => {
    if (new Date(event.start).getTime() < upper && new Date(event.end).getTime() > lower) {
      result.set(`${event.uid}\n${event.recurrenceId ?? ''}`, event)
    }
  }
  for (const component of masters) {
    if (component.getFirstPropertyValue('status') === 'CANCELLED') continue
    const event = new ICAL.Event(component, {
      exceptions: components.filter((item) => item.hasProperty('recurrence-id') && item.getFirstPropertyValue('uid') === component.getFirstPropertyValue('uid'))
    })
    if (!event.isRecurring()) { include(parsedEvent(event)); continue }
    const iterator = event.iterator()
    let finished = false
    for (let count = 0; count < 100_000; count++) {
      const occurrence = iterator.next()
      if (!occurrence) { finished = true; break }
      const details = event.getOccurrenceDetails(occurrence)
      if (dateFor(occurrence, event).getTime() >= upper) { finished = true; break }
      if (details.item.component.getFirstPropertyValue('status') === 'CANCELLED') continue
      include(parsedEvent(details.item, details.startDate, details.endDate, details.recurrenceId.toString()))
    }
    if (!finished) throw new Error('This remote repeat rule produces too many occurrences to display safely.')
  }
  // A moved exception can enter the range even when its original date does not.
  for (const component of components.filter((item) => item.hasProperty('recurrence-id'))) {
    if (component.getFirstPropertyValue('status') === 'CANCELLED') continue
    const event = new ICAL.Event(component)
    include(parsedEvent(event, event.startDate, event.endDate, event.recurrenceId.toString()))
  }
  return [...result.values()].sort((a, b) => a.start.localeCompare(b.start))
}

function calendarTime(iso: string, allDay: boolean): CalendarTime {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid calendar date.')
  return allDay ? ICAL.Time.fromDateString(localDateKey(date)) : ICAL.Time.fromJSDate(date, true)
}

function setEventFields(component: CalendarComponent, input: ICSInput): void {
  if (new Date(input.end).getTime() <= new Date(input.start).getTime()) throw new Error('The calendar event must end after it starts.')
  for (const property of ['dtstart', 'dtend', 'duration']) component.removeAllProperties(property)
  component.addPropertyWithValue('dtstart', calendarTime(input.start, input.allDay))
  component.addPropertyWithValue('dtend', calendarTime(input.end, input.allDay))
  component.updatePropertyWithValue('uid', input.uid)
  component.updatePropertyWithValue('summary', input.summary)
  component.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  for (const [property, value] of [['location', input.location], ['description', input.description]] as const) {
    component.removeAllProperties(property)
    if (value) component.addPropertyWithValue(property, value)
  }
  for (const [key, property] of [['attendees', 'x-doneline-attendees'], ['color', 'x-doneline-color'], ['shared', 'x-doneline-shared']] as const) {
    if (!(key in input)) continue
    component.removeAllProperties(property)
    const value = input[key]
    if (value != null) component.addPropertyWithValue(property, key === 'shared' ? (value ? '1' : '0') : String(value))
  }
}

export function buildICS(input: ICSInput): string {
  const root = new ICAL.Component('vcalendar')
  root.addPropertyWithValue('version', '2.0')
  root.addPropertyWithValue('calscale', 'GREGORIAN')
  root.addPropertyWithValue('prodid', '-//Doneline//Doneline//EN')
  const component = new ICAL.Component('vevent')
  setEventFields(component, input)
  root.addSubcomponent(component)
  return `${root.toString()}\r\n`
}

/** Preserve the entire resource and modify one event/occurrence without erasing its series. */
export function editICS(ics: string, input: ICSInput, recurrenceId?: string | null): string {
  const root = calendar(ics)
  const master = root.getAllSubcomponents('vevent').find((item) => item.getFirstPropertyValue('uid') === input.uid && !item.hasProperty('recurrence-id'))
  if (!master) throw new Error('The original remote calendar resource is unavailable. Sync before editing this occurrence.')
  if (!recurrenceId) {
    if (master.hasProperty('rrule') || master.hasProperty('rdate')) {
      throw new Error('Sync this remote repeat rule into dated occurrences before editing it. The series is preserved.')
    }
    setEventFields(master, input)
    return `${root.toString()}\r\n`
  }
  let component = root.getAllSubcomponents('vevent').find((item) => item.getFirstPropertyValue('uid') === input.uid &&
    (item.getFirstPropertyValue('recurrence-id') as CalendarTime | null)?.toString() === recurrenceId)
  if (!component) {
    component = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())))
    for (const property of ['rrule', 'rdate', 'exdate', 'recurrence-id']) component.removeAllProperties(property)
    const property = new ICAL.Property('recurrence-id')
    property.setValue(ICAL.Time.fromString(recurrenceId, master.getFirstProperty('dtstart')))
    const zoneId = master.getFirstProperty('dtstart')?.getParameter('tzid')
    if (zoneId) property.setParameter('tzid', zoneId)
    component.addProperty(property)
    root.addSubcomponent(component)
  }
  setEventFields(component, input)
  return `${root.toString()}\r\n`
}

export function excludeICSOccurrence(ics: string, uid: string, recurrenceId: string): string {
  const root = calendar(ics)
  const master = root.getAllSubcomponents('vevent').find((item) => item.getFirstPropertyValue('uid') === uid && !item.hasProperty('recurrence-id'))
  if (!master) throw new Error('The original remote repeat rule is unavailable. Sync before removing this occurrence.')
  for (const exception of root.getAllSubcomponents('vevent')) {
    if (exception.getFirstPropertyValue('uid') === uid &&
        (exception.getFirstPropertyValue('recurrence-id') as CalendarTime | null)?.toString() === recurrenceId) root.removeSubcomponent(exception)
  }
  const exists = master.getAllProperties('exdate').some((property) => property.getValues().some((value) => (value as CalendarTime).toString() === recurrenceId))
  if (!exists) {
    const property = new ICAL.Property('exdate')
    property.setValue(ICAL.Time.fromString(recurrenceId, master.getFirstProperty('dtstart')))
    const zoneId = master.getFirstProperty('dtstart')?.getParameter('tzid')
    if (zoneId) property.setParameter('tzid', zoneId)
    master.addProperty(property)
  }
  return `${root.toString()}\r\n`
}
