const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, beforeEach, after, mock } = require('node:test')
const { buildSync } = require('esbuild')

process.env.TZ = 'Europe/Paris'
// The initial pull horizon must cover these fixtures on future CI run dates.
// Mock only Date: real asynchronous retries and network gates keep running.
mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T10:00:00.000Z') })
const workspace = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-calendar-'))
process.env.DONELINE_DIR = temp
process.env.DONELINE_DB = ':memory:'
const stub = path.join(temp, 'tsdav.cjs')
fs.writeFileSync(stub, 'exports.createDAVClient = async () => globalThis.__calendarClient;')
const compiled = path.join(temp, 'core.cjs')
buildSync({
  stdin: { contents: `export * from './core/index'; export * from './core/ics';`, resolveDir: workspace, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', external: ['libsql'], alias: { tsdav: stub },
  banner: { js: `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});` },
  outfile: compiled, logLevel: 'silent'
})
const core = require(compiled)
const db = core.getDb()
const calendarUrl = 'https://calendar.example/alice/'
let alice, bob, client

function fakeClient() {
  const resources = new Map()
  let revision = 0
  const result = (status) => new Response(null, { status, headers: { etag: `"v${++revision}"` } })
  const instance = {
    resources, created: [], updated: [], deleted: [], status: 201,
    fetchCalendars: async () => [{ url: calendarUrl, displayName: 'Test calendar', components: ['VEVENT'] }],
    fetchCalendarObjects: async () => [...resources.values()].map((resource) => ({ ...resource })),
    createCalendarObject: async (input) => {
      instance.created.push(input)
      await instance.beforeCreate?.(input)
      const response = result(instance.status)
      if (response.ok) resources.set(core.icsResourceUid(input.iCalString), { url: calendarUrl + input.filename, etag: response.headers.get('etag'), data: input.iCalString })
      return response
    },
    updateCalendarObject: async ({ calendarObject }) => {
      instance.updated.push(calendarObject)
      const response = result(instance.status === 201 ? 204 : instance.status)
      if (response.ok) resources.set(core.icsResourceUid(calendarObject.data), { url: calendarObject.url, etag: response.headers.get('etag'), data: calendarObject.data })
      return response
    },
    deleteCalendarObject: async ({ calendarObject }) => {
      instance.deleted.push(calendarObject)
      const response = result(instance.status === 201 ? 204 : instance.status)
      if (response.ok) {
        for (const [uid, resource] of resources) if (resource.url === calendarObject.url) resources.delete(uid)
      }
      return response
    }
  }
  return instance
}

beforeEach(() => {
  for (const table of ['calendar_tombstones', 'calendar_resources', 'todo_completions', 'reactions', 'focus_sessions', 'nudges', 'focus_invites', 'presence', 'daily_notes', 'events', 'todos', 'goals', 'settings']) db.exec(`DELETE FROM ${table}`)
  const people = core.listPeople()
  alice = people[0].id
  bob = people[1].id
  core.setCalDavConfig(alice, { serverUrl: 'https://calendar.example', username: 'alice', password: 'test-only', calendarUrl })
  client = fakeClient()
  globalThis.__calendarClient = client
})
after(() => {
  core.closeDb()
  mock.timers.reset()
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()))
  fs.rmSync(temp, { recursive: true, force: true })
})

const local = (day, hour = 0) => {
  const date = core.parseLocalDate(day)
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}
const makeEvent = (title = 'New event', person = alice, extra = {}) => core.createEvent({ title, person_id: person,
  starts_at: local('2026-10-15', 9), ends_at: local('2026-10-15', 10), ...extra })
const ordinaryICS = (uid, summary = 'Remote event') => core.buildICS({ uid, summary, start: local('2026-10-15', 9), end: local('2026-10-15', 10), allDay: false })
const seriesICS = (uid = 'series') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Thursday class',
  'DTSTART;TZID=Europe/Paris:20261001T090000', 'DTEND;TZID=Europe/Paris:20261001T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261022T220000Z', 'EXDATE;TZID=Europe/Paris:20261008T090000',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'DESCRIPTION:Reminder', 'END:VALARM',
  'END:VEVENT', 'END:VCALENDAR'
].join('\r\n')

test('ICS handles TZID without embedded timezone, folded escaped text, and all-day exclusive ends', () => {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:tz', 'DTSTART;TZID=America/New_York:20260329T090000',
    'DURATION:PT1H', 'SUMMARY:Folded\\, te', ' xt', 'DESCRIPTION:line one\\nline two\\;yes', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const parsed = core.parseICS(text)
  assert.equal(parsed.start, '2026-03-29T13:00:00.000Z')
  assert.equal(parsed.end, '2026-03-29T14:00:00.000Z')
  assert.equal(parsed.summary, 'Folded, text')
  assert.equal(parsed.description, 'line one\nline two;yes')
  const allDay = core.buildICS({ uid: 'day', summary: 'All day', start: local('2026-03-29'), end: local('2026-03-30'), allDay: true })
  assert.match(allDay, /DTSTART;VALUE=DATE:20260329/)
  assert.match(allDay, /DTEND;VALUE=DATE:20260330/)
  const back = core.parseICS(allDay)
  assert.equal((new Date(back.end) - new Date(back.start)) / 3_600_000, 23)
})

test('embedded custom VTIMEZONE definitions control recurring DST conversion', () => {
  const text = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTIMEZONE', 'TZID:Custom/Paris',
    'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:custom-zone', 'SUMMARY:Across DST', 'DTSTART;TZID=Custom/Paris:20260322T090000', 'DTEND;TZID=Custom/Paris:20260322T100000',
    'RRULE:FREQ=WEEKLY;COUNT=2', 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n')
  const events = core.parseICSOccurrences(text, local('2026-03-20'), local('2026-04-01'))
  assert.deepEqual(events.map((event) => event.start), ['2026-03-22T08:00:00.000Z', '2026-03-29T07:00:00.000Z'])
})

test('IANA fallback selects RFC first repeated clock time and normalizes missing spring clocks', () => {
  const calendar = (start, end) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:dst-clock', 'SUMMARY:DST clock',
    `DTSTART;TZID=Europe/Paris:${start}`, `DTEND;TZID=Europe/Paris:${end}`, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  assert.equal(core.parseICS(calendar('20261025T023000', '20261025T033000')).start, '2026-10-25T00:30:00.000Z')
  assert.equal(core.parseICS(calendar('20260329T023000', '20260329T040000')).start, '2026-03-29T01:30:00.000Z')
})

test('RFC weekly bounds and EXDATE expand correctly, with a raw-preserving one-occurrence edit/delete', () => {
  const original = seriesICS()
  const occurrences = core.parseICSOccurrences(original, local('2026-09-01'), local('2026-11-01'))
  assert.deepEqual(occurrences.map((event) => core.localDateKey(new Date(event.start))), ['2026-10-01', '2026-10-15', '2026-10-22'])
  const edited = core.editICS(original, { uid: 'series', summary: 'Moved class', start: local('2026-10-16', 14), end: local('2026-10-16', 15), allDay: false }, occurrences[1].recurrenceId)
  assert.match(edited, /RRULE:FREQ=WEEKLY/)
  assert.match(edited, /BEGIN:VALARM/)
  assert.match(edited, /RECURRENCE-ID/)
  const after = core.parseICSOccurrences(edited, local('2026-10-01'), local('2026-11-01'))
  assert.deepEqual(after.map((event) => core.localDateKey(new Date(event.start))), ['2026-10-01', '2026-10-16', '2026-10-22'])
  const deleted = core.excludeICSOccurrence(edited, 'series', occurrences[1].recurrenceId)
  assert.deepEqual(core.parseICSOccurrences(deleted, local('2026-10-01'), local('2026-11-01')).map((event) => core.localDateKey(new Date(event.start))), ['2026-10-01', '2026-10-22'])
  assert.throws(() => core.editICS(original, { uid: 'series', summary: 'Unsafe master edit', start: local('2026-10-01', 11), end: local('2026-10-01', 12), allDay: false }), /series is preserved/)
})

test('push rejects HTTP failures, saves pending state, retries a stable UID, and only uploads the exact owner', async () => {
  const event = makeEvent()
  makeEvent('Someone else shared this', bob, { shared: true })
  client.status = 500
  await assert.rejects(core.syncCalendar(alice), /HTTP 500/)
  const pending = core.getEvent(event.id)
  assert.equal(pending.source, 'local')
  assert.equal(pending.calendar_dirty, 1)
  assert.equal(pending.caldav_uid, `doneline-${event.id}`)
  client.status = 201
  await core.syncCalendar(alice)
  assert.equal(client.resources.size, 1)
  assert.equal(core.getEvent(event.id).calendar_dirty, 0)
  assert.equal(client.created[0].filename, client.created[1].filename)
  assert.ok(client.created.every((input) => !input.iCalString.includes('Someone else')))
})

test('remote deletion removes imported events and never recreates them on the server', async () => {
  client.resources.set('remote', { url: calendarUrl + 'remote.ics', etag: '"remote1"', data: ordinaryICS('remote') })
  await core.syncCalendar(alice)
  const imported = core.findByUid('remote', alice)
  assert.ok(imported)
  client.resources.delete('remote')
  await core.syncCalendar(alice)
  assert.equal(core.getEvent(imported.id), undefined)
  assert.equal(client.created.length, 0)
})

test('dirty local edits survive a failed server write and refresh against the latest raw resource', async () => {
  client.resources.set('remote', { url: calendarUrl + 'remote.ics', etag: '"remote1"', data: ordinaryICS('remote') })
  await core.syncCalendar(alice)
  const imported = core.findByUid('remote', alice)
  core.updateEvent(imported.id, { title: 'Local edit saved' })
  client.resources.set('remote', { url: calendarUrl + 'remote.ics', etag: '"remote2"', data: ordinaryICS('remote', 'Conflicting remote edit') })
  client.status = 500
  await assert.rejects(core.syncCalendar(alice), /HTTP 500/)
  assert.equal(core.getEvent(imported.id).title, 'Local edit saved')
  assert.equal(core.getEvent(imported.id).calendar_dirty, 1)
  client.status = 201
  await core.syncCalendar(alice)
  assert.equal(core.parseICS(client.resources.get('remote').data).summary, 'Local edit saved')
})

test('delete during upload stays deleted and its durable tombstone removes the newly uploaded copy', async () => {
  const event = makeEvent()
  client.beforeCreate = () => { core.deleteEvent(event.id); client.beforeCreate = null }
  await core.syncCalendar(alice)
  // Deletion queued another serialized sync; waiting on it proves eventual removal.
  await core.syncCalendar(alice)
  assert.equal(core.getEvent(event.id), undefined)
  assert.equal(client.resources.size, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_tombstones').get().n, 0)
})

test('edit during upload remains dirty until a second write, with no duplicate remote object', async () => {
  const event = makeEvent()
  client.beforeCreate = () => { core.updateEvent(event.id, { title: 'Edited while saving' }); client.beforeCreate = null }
  const first = core.syncCalendar(alice)
  assert.equal(core.syncCalendar(alice), first)
  await first
  await core.syncCalendar(alice)
  assert.equal(client.created.length, 1)
  assert.equal(client.resources.size, 1)
  assert.equal(core.parseICS(client.resources.get(`doneline-${event.id}`).data).summary, 'Edited while saving')
  assert.equal(core.getEvent(event.id).calendar_dirty, 0)
})

test('remote occurrence delete updates EXDATE and retains every other occurrence of the series', async () => {
  client.resources.set('series', { url: calendarUrl + 'series.ics', etag: '"series1"', data: seriesICS() })
  await core.syncCalendar(alice)
  const occurrences = db.prepare('SELECT * FROM events WHERE caldav_uid = ? ORDER BY starts_at').all('series')
  assert.equal(occurrences.length, 3)
  core.deleteEvent(occurrences[1].id)
  await core.syncCalendar(alice)
  assert.equal(client.deleted.length, 0)
  assert.equal(client.resources.size, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE caldav_uid = ?').get('series').n, 2)
  assert.equal(core.parseICSOccurrences(client.resources.get('series').data, local('2026-10-01'), local('2026-11-01')).length, 2)
})

test('calendar navigation expands a stored remote rule outside the initial sync horizon', () => {
  const data = seriesICS('future').replace('UNTIL=20261022T220000Z', 'UNTIL=20291231T220000Z')
  db.prepare('INSERT INTO calendar_resources (person_id,uid,url,etag,ics) VALUES (?,?,?,?,?)').run(alice, 'future', calendarUrl + 'future.ics', '"future"', data)
  const events = core.listEvents({ personId: alice, from: local('2029-05-01'), to: local('2029-06-01') })
  assert.equal(events.length, 5)
  assert.ok(events.every((event) => new Date(event.starts_at).getDay() === 4))
})

test('missing explicitly selected calendars fail instead of silently writing to a different calendar', async () => {
  makeEvent()
  client.fetchCalendars = async () => [{ url: 'https://calendar.example/wrong/', components: ['VEVENT'] }]
  await assert.rejects(core.syncCalendar(alice), /selected calendar is unavailable/)
  assert.equal(client.created.length, 0)
})

test('application attendee names, color, and sharing round-trip through preserved ICS extensions', async () => {
  const event = makeEvent('With friends', alice, { attendees: 'Alice, Bob', color: '#123456', shared: true })
  await core.syncCalendar(alice)
  const parsed = core.parseICS(client.resources.get(`doneline-${event.id}`).data)
  assert.equal(parsed.attendees, 'Alice, Bob')
  assert.equal(parsed.color, '#123456')
  assert.equal(parsed.shared, true)
})

test('moving owner during upload retains the new owner metadata and removes the old remote copy', async () => {
  const event = makeEvent()
  client.beforeCreate = () => { core.updateEvent(event.id, { person_id: bob }); client.beforeCreate = null }
  await core.syncCalendar(alice)
  await core.syncCalendar(alice)
  const moved = core.getEvent(event.id)
  assert.equal(moved.person_id, bob)
  assert.equal(moved.source, 'local')
  assert.equal(moved.caldav_uid, null)
  assert.equal(moved.caldav_url, null)
  assert.equal(client.resources.size, 0)
})

test('queued completion callbacks survive an in-flight edit and run once after the retry', async () => {
  const event = makeEvent()
  let callbacks = 0
  const callback = () => { callbacks++ }
  client.beforeCreate = () => {
    core.updateEvent(event.id, { title: 'Edited during upload' })
    core.queueCalendarSync(alice, callback)
    core.queueCalendarSync(alice, callback)
    client.beforeCreate = null
  }
  await core.syncCalendar(alice)
  await core.syncCalendar(alice)
  assert.equal(callbacks, 1)
})

test('failed occurrence deletion keeps its tombstone and hides it until a successful retry', async () => {
  client.resources.set('series', { url: calendarUrl + 'series.ics', etag: '"series1"', data: seriesICS() })
  await core.syncCalendar(alice)
  const occurrences = db.prepare('SELECT * FROM events WHERE caldav_uid = ? ORDER BY starts_at').all('series')
  core.deleteEvent(occurrences[1].id)
  client.status = 500
  await assert.rejects(core.syncCalendar(alice), /HTTP 500/)
  const visible = core.listEvents({ personId: alice, from: local('2026-10-01'), to: local('2026-11-01') })
  assert.equal(visible.length, 2)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_tombstones').get().n, 1)
  client.status = 201
  await core.syncCalendar(alice)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_tombstones').get().n, 0)
  assert.equal(core.listEvents({ personId: alice, from: local('2026-10-01'), to: local('2026-11-01') }).length, 2)
})

test('switching calendar clears clean old snapshots, keeps pending edits, and never uploads them into the new calendar', async () => {
  client.resources.set('clean', { url: calendarUrl + 'clean.ics', etag: '"clean1"', data: ordinaryICS('clean') })
  client.resources.set('dirty', { url: calendarUrl + 'dirty.ics', etag: '"dirty1"', data: ordinaryICS('dirty') })
  await core.syncCalendar(alice)
  const clean = core.findByUid('clean', alice)
  const dirty = core.findByUid('dirty', alice)
  core.updateEvent(dirty.id, { title: 'Pending old calendar edit' })
  const newUrl = 'https://calendar.example/new/'
  core.setCalDavConfig(alice, { serverUrl: 'https://calendar.example', username: 'alice', password: 'test-only', calendarUrl: newUrl })
  assert.equal(core.getEvent(clean.id), undefined)
  assert.equal(core.getEvent(dirty.id).title, 'Pending old calendar edit')
  client.fetchCalendars = async () => [{ url: newUrl, components: ['VEVENT'] }]
  client.fetchCalendarObjects = async () => []
  await core.syncCalendar(alice)
  assert.equal(client.created.length, 0)
  assert.equal(client.updated.length, 0)
  assert.equal(core.getEvent(dirty.id).calendar_dirty, 1)
  assert.throws(() => core.setCalDavConfig(alice, { serverUrl: 'file://local', username: 'alice', password: 'x' }), /HTTPS or HTTP/)
})
