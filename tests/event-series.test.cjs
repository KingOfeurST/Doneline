const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, beforeEach, after, mock } = require('node:test')
const { buildSync } = require('esbuild')

process.env.TZ = 'Europe/Paris'
mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T10:00:00Z') })
const workspace = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-event-series-'))
process.env.DONELINE_DIR = temp
process.env.DONELINE_DB = ':memory:'
const stub = path.join(temp, 'tsdav.cjs')
fs.writeFileSync(stub, 'exports.createDAVClient = async () => globalThis.__calendarClient;')
const compiled = path.join(temp, 'core.cjs')
buildSync({ stdin: { contents: `export * from './core/index'; export * from './core/ics';`, resolveDir: workspace, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', external: ['libsql'], alias: { tsdav: stub },
  banner: { js: `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});` }, outfile: compiled, logLevel: 'silent' })
const core = require(compiled)
const db = core.getDb()
const owner = core.listPeople()[0].id
const local = (day, hour = 0) => { const date = core.parseLocalDate(day); date.setHours(hour, 0, 0, 0); return date.toISOString() }
const children = id => db.prepare('SELECT * FROM events WHERE recur_parent = ? ORDER BY starts_at').all(id)
const dates = rows => rows.map(row => core.localDateKey(new Date(row.starts_at)))
const rule = { freq: 'weekly', days: [4], startDate: '2026-10-15', endDate: '2026-11-26' }
const createSeries = (extra = {}) => core.createEvent({ title: 'Study group', person_id: owner, starts_at: local('2026-10-15', 17),
  ends_at: local('2026-10-15', 18), recurrence: JSON.stringify(rule), ...extra })

beforeEach(() => {
  for (const table of ['recurrence_exclusions', 'calendar_resource_changes', 'calendar_tombstones', 'calendar_resources', 'trash_items', 'events', 'todo_completions', 'reactions', 'todos', 'settings']) db.exec(`DELETE FROM ${table}`)
})
after(() => {
  core.closeDb(); mock.timers.reset()
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()))
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('approved bounded Thursday preview is exactly seven actual dates, with no database writes', () => {
  assert.deepEqual(core.previewRecurrence(rule, '2026-10-15'), { dates: ['2026-10-15', '2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26'], total: 7, hasMore: false })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
  assert.deepEqual(core.previewRecurrence({ ...rule, excludedDates: ['2026-10-22'] }, '2026-10-15', { limit: 2 }), { dates: ['2026-10-15', '2026-10-29'], total: 6, hasMore: true })
  assert.equal(core.previewRecurrence({ freq: 'daily', startDate: '2026-10-15' }, '2026-10-15').total, null)
})

test('independent date exclusions survive stale parent JSON, and Undo revives only its own date', () => {
  const template = createSeries()
  core.setOccurrenceExclusion('events', template.id, '2026-10-22', true)
  core.setOccurrenceExclusion('events', template.id, '2026-10-29', true)
  // A last-writer parent snapshot from the second offline device can omit the
  // first deletion; its independently replicated date record still wins.
  db.prepare('UPDATE events SET recurrence = ? WHERE id = ?').run(JSON.stringify({ ...rule, excludedDates: ['2026-10-29'] }), template.id)
  assert.deepEqual(JSON.parse(core.getEvent(template.id).recurrence).excludedDates, ['2026-10-22', '2026-10-29'])
  assert.equal(core.previewRecurrence(core.getEventSeriesContext(template.id).recurrence, '2026-10-15').total, 5)
  core.ensureEventInstancesForRange('2026-10-15', '2026-11-26')
  assert.equal(children(template.id).length, 5)
  core.setOccurrenceExclusion('events', template.id, '2026-10-22', false)
  db.prepare('UPDATE events SET recurrence = ? WHERE id = ?').run(JSON.stringify({ ...rule, excludedDates: ['2026-10-22', '2026-10-29'] }), template.id)
  core.ensureEventInstancesForRange('2026-10-15', '2026-11-26')
  assert.equal(children(template.id).length, 6)
  assert.ok(dates(children(template.id)).includes('2026-10-22'))
  assert.ok(!dates(children(template.id)).includes('2026-10-29'))
  assert.deepEqual(JSON.parse(core.listEventTemplates()[0].recurrence).excludedDates, ['2026-10-29'])
})

test('legacy exclusion backfill is idempotent and never overwrites a persistent Undo', () => {
  const template = createSeries({ recurrence: JSON.stringify({ ...rule, excludedDates: ['2026-10-22'] }) })
  core.backfillRecurrenceExclusions(db)
  core.setOccurrenceExclusion('events', template.id, '2026-10-22', false)
  db.prepare('UPDATE events SET recurrence = ? WHERE id = ?').run(JSON.stringify({ ...rule, excludedDates: ['2026-10-22'] }), template.id)
  core.backfillRecurrenceExclusions(db); core.backfillRecurrenceExclusions(db)
  assert.equal(db.prepare('SELECT excluded FROM recurrence_exclusions WHERE kind = ? AND parent_id = ? AND day = ?').get('event', template.id, '2026-10-22').excluded, 0)
  assert.equal(JSON.parse(core.getEvent(template.id).recurrence).excludedDates, undefined)
})

test('future split keeps earlier IDs, exceptions and exclusions while retaining later excluded dates', () => {
  const template = createSeries({ recurrence: JSON.stringify({ ...rule, excludedDates: ['2026-10-22', '2026-11-12'] }) })
  core.ensureEventInstancesForRange('2026-10-01', '2026-12-01')
  const historical = children(template.id).filter(row => row.starts_at < local('2026-11-05'))
  const pastException = core.updateEvent(historical[1].id, { title: 'Past exception' })
  const selected = children(template.id).find(row => row.starts_at === local('2026-11-05', 17))
  const next = core.updateEventSeries(selected.id, { title: 'New future title', starts_at: local('2026-11-05', 19), ends_at: local('2026-11-05', 20) }, 'future')
  assert.notEqual(next.id, template.id)
  assert.equal(core.getEvent(historical[0].id).title, 'Study group')
  assert.equal(core.getEvent(pastException.id).title, 'Past exception')
  assert.equal(core.getEvent(pastException.id).recur_parent, null)
  const oldRule = JSON.parse(core.getEvent(template.id).recurrence)
  assert.equal(oldRule.endDate, '2026-11-04')
  assert.deepEqual(oldRule.excludedDates, ['2026-10-22', '2026-10-29', '2026-11-12'])
  assert.deepEqual(dates(children(next.id)), ['2026-11-05', '2026-11-19', '2026-11-26'])
  assert.ok(children(next.id).every(row => row.title === 'New future title' && new Date(row.starts_at).getHours() === 19))
  core.ensureEventInstancesForRange('2026-10-01', '2026-12-01')
  assert.deepEqual(dates(children(template.id)), ['2026-10-15'])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trash_items').get().n, 0, 'internal splitting is not a Trash deletion')
})

test('future weekday/bound changes do not rewrite earlier occurrences or create dates outside the new range', () => {
  const template = createSeries()
  core.ensureEventInstancesForRange('2026-10-01', '2026-12-01')
  const selected = children(template.id).find(row => dates([row])[0] === '2026-11-05')
  const earlier = children(template.id).filter(row => row.starts_at < selected.starts_at)
  const next = core.updateEventSeries(selected.id, { recurrence: JSON.stringify({ freq: 'weekly', days: [2], startDate: '2026-11-05', endDate: '2026-11-19' }) }, 'future')
  assert.deepEqual(dates(children(next.id)), ['2026-11-10', '2026-11-17'])
  for (const row of earlier) assert.deepEqual({ ...core.getEvent(row.id), _metadata: undefined }, { ...row, _metadata: undefined })
  assert.throws(() => core.updateEventSeries(children(next.id)[0].id, { starts_at: local('2026-10-01', 17), ends_at: local('2026-10-01', 18) }, 'future'), /on or after/)
})

test('entire series updates dated history with stable IDs and local wall clocks across DST', () => {
  const template = createSeries()
  core.ensureEventInstancesForRange('2026-10-01', '2026-12-01')
  const before = children(template.id)
  const selected = before[3]
  core.updateEventSeries(selected.id, { title: 'All changed', starts_at: local('2026-10-15', 9), ends_at: local('2026-10-15', 10), shared: 1 }, 'series')
  const after = children(template.id)
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id))
  assert.ok(after.every(row => row.title === 'All changed' && row.shared === 1 && new Date(row.starts_at).getHours() === 9))
  assert.equal(after[0].starts_at, '2026-10-15T07:00:00.000Z')
  assert.equal(after[2].starts_at, '2026-10-29T08:00:00.000Z')
})

test('moving a whole-series date anchor regenerates canonical IDs without key collisions', () => {
  const template = createSeries()
  core.ensureEventInstancesForRange('2026-10-15', '2026-11-26')
  core.updateEventSeries(children(template.id)[2].id, { starts_at: local('2026-10-22', 17), ends_at: local('2026-10-22', 18),
    recurrence: JSON.stringify({ ...rule, startDate: '2026-10-22' }) }, 'series')
  assert.deepEqual(dates(children(template.id)), ['2026-10-22', '2026-10-29', '2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26'])
  for (const row of children(template.id)) assert.equal(row.id, core.recurringInstanceId('event', template.id, core.localDateKey(new Date(row.starts_at))))
})

test('one occurrence detaches, and stopping future repetition preserves the past plus one replacement', () => {
  const template = createSeries()
  core.ensureEventInstancesForRange('2026-10-01', '2026-12-01')
  const one = children(template.id)[0]
  core.updateEventSeries(one.id, { title: 'One date' }, 'occurrence')
  assert.equal(core.getEvent(one.id).recur_parent, null)
  assert.ok(JSON.parse(core.getEvent(template.id).recurrence).excludedDates.includes('2026-10-15'))
  const selected = children(template.id).find(row => dates([row])[0] === '2026-11-05')
  const single = core.updateEventSeries(selected.id, { title: 'Last date', recurrence: null }, 'future')
  assert.equal(single.recurrence, null)
  core.ensureEventInstancesForRange('2026-10-01', '2026-12-01')
  assert.deepEqual(dates(children(template.id)), ['2026-10-22', '2026-10-29'])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events WHERE starts_at >= ? AND recurrence IS NULL').get(local('2026-11-05')).n, 1)
})

const remoteSeries = () => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:remote-series', 'SUMMARY:Study group',
  'DTSTART;TZID=Europe/Paris:20261015T170000', 'DTEND;TZID=Europe/Paris:20261015T180000', 'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=7',
  'EXDATE;TZID=Europe/Paris:20261112T170000', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
const range = ics => core.parseICSOccurrences(ics, local('2026-10-01'), local('2026-12-01'))

test('remote future RANGE edit preserves earlier dates, EXDATE, alarms and local time across DST', () => {
  const edited = core.editICSScoped(remoteSeries(), { uid: 'remote-series', summary: 'Future class', start: local('2026-10-22', 19), end: local('2026-10-22', 20), allDay: false }, 'future', '2026-10-22T17:00:00')
  assert.match(edited, /RANGE=THISANDFUTURE/)
  assert.match(edited, /BEGIN:VALARM/)
  const occurrences = range(edited)
  assert.equal(occurrences.length, 6)
  assert.equal(occurrences[0].summary, 'Study group')
  assert.equal(new Date(occurrences[0].start).getHours(), 17)
  assert.ok(occurrences.slice(1).every(row => row.summary === 'Future class' && new Date(row.start).getHours() === 19))
  assert.equal(occurrences[2].start, '2026-10-29T18:00:00.000Z')
})

test('remote entire-series edits preserve timezone, count and excluded dates', () => {
  const edited = core.editICSScoped(remoteSeries(), { uid: 'remote-series', summary: 'All class', start: local('2026-10-15', 9), end: local('2026-10-15', 10), allDay: false }, 'series')
  assert.match(edited, /DTSTART;TZID=Europe\/Paris:20261015T090000/)
  const occurrences = range(edited)
  assert.equal(occurrences.length, 6)
  assert.ok(occurrences.every(row => new Date(row.start).getHours() === 9))
})

test('scoped remote edits retain custom embedded timezone definitions across DST', () => {
  const zone = ['BEGIN:VTIMEZONE', 'TZID:Custom/Paris', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'END:VTIMEZONE'].join('\r\n')
  const source = remoteSeries().replace('BEGIN:VEVENT', zone + '\r\nBEGIN:VEVENT').replaceAll('Europe/Paris', 'Custom/Paris')
  const edited = core.editICSScoped(source, { uid: 'remote-series', summary: 'Custom class', start: local('2026-10-15', 9), end: local('2026-10-15', 10), allDay: false }, 'series')
  assert.match(edited, /TZID:Custom\/Paris/)
  assert.ok(range(edited).every(row => new Date(row.start).getHours() === 9))
  assert.equal(range(edited).length, 6)
})

test('restoring a remote excluded occurrence removes only its EXDATE and preserves the series', () => {
  const restored = core.editICSScoped(remoteSeries(), { uid: 'remote-series', summary: 'Restored class', start: local('2026-11-12', 17), end: local('2026-11-12', 18), allDay: false }, 'occurrence', '2026-11-12T17:00:00')
  const occurrences = range(restored)
  assert.equal(occurrences.length, 7)
  assert.equal(occurrences.find(row => core.localDateKey(new Date(row.start)) === '2026-11-12').summary, 'Restored class')
})

test('new recurrence and remote children have deterministic identities across independent materialization', () => {
  const template = createSeries()
  const todoTemplate = core.createTodo({ title: 'Prep', due_at: local('2026-10-15', 16), recurrence: JSON.stringify(rule) })
  core.ensureEventInstancesForRange('2026-10-15', '2026-11-26')
  core.ensureTodoInstancesForRange('2026-10-15', '2026-11-26')
  const eventIds = children(template.id).map(row => row.id)
  const todoIds = db.prepare('SELECT id FROM todos WHERE recur_parent = ? ORDER BY due_at').all(todoTemplate.id).map(row => row.id)
  db.prepare('DELETE FROM events WHERE recur_parent = ?').run(template.id)
  db.prepare('DELETE FROM todos WHERE recur_parent = ?').run(todoTemplate.id)
  core.ensureEventInstancesForRange('2026-10-15', '2026-11-26')
  core.ensureTodoInstancesForRange('2026-10-15', '2026-11-26')
  assert.deepEqual(children(template.id).map(row => row.id), eventIds)
  assert.deepEqual(db.prepare('SELECT id FROM todos WHERE recur_parent = ? ORDER BY due_at').all(todoTemplate.id).map(row => row.id), todoIds)
  assert.notEqual(eventIds[0], todoIds[0])
  const imported = { person_id: owner, uid: 'remote-series', url: 'https://calendar.example/alice/series.ics', etag: 'old', ics: remoteSeries() }
  db.prepare('INSERT INTO calendar_resources (person_id,uid,url,etag,ics) VALUES (?,?,?,?,?)').run(imported.person_id, imported.uid, imported.url, imported.etag, imported.ics)
  core.ensureRemoteCalendarInstancesForRange(local('2026-10-01'), local('2026-12-01'))
  const remoteIds = db.prepare('SELECT id FROM events WHERE caldav_uid = ? ORDER BY starts_at').all(imported.uid).map(row => row.id)
  db.prepare('DELETE FROM events WHERE caldav_uid = ?').run(imported.uid)
  core.ensureRemoteCalendarInstancesForRange(local('2026-10-01'), local('2026-12-01'))
  assert.deepEqual(db.prepare('SELECT id FROM events WHERE caldav_uid = ? ORDER BY starts_at').all(imported.uid).map(row => row.id), remoteIds)
  const legacy = children(template.id)[0]
  db.prepare('UPDATE events SET id = ? WHERE id = ?').run('legacy-preserved-id', legacy.id)
  core.ensureEventInstancesForRange('2026-10-15', '2026-11-26')
  assert.equal(children(template.id)[0].id, 'legacy-preserved-id')
})

test('detached restored exceptions occupying deterministic IDs survive changed-rule materialization', () => {
  const template = createSeries()
  const task = core.createTodo({ title: 'Prep', due_at: local('2026-10-15', 16), recurrence: JSON.stringify(rule) })
  core.ensureEventInstancesForRange('2026-10-15', '2026-10-15'); core.ensureTodoInstancesForDate('2026-10-15')
  const event = children(template.id)[0]
  const todo = db.prepare('SELECT * FROM todos WHERE recur_parent = ?').get(task.id)
  db.prepare('UPDATE events SET recur_parent = NULL, title = ? WHERE id = ?').run('Restored event exception', event.id)
  db.prepare('UPDATE todos SET recur_parent = NULL, title = ? WHERE id = ?').run('Restored task exception', todo.id)
  assert.equal(core.ensureEventInstancesForRange('2026-10-15', '2026-10-15'), 0)
  assert.equal(core.ensureTodoInstancesForDate('2026-10-15'), 0)
  assert.equal(core.getEvent(event.id).title, 'Restored event exception')
  assert.equal(db.prepare('SELECT title FROM todos WHERE id = ?').get(todo.id).title, 'Restored task exception')
})

const calendarUrl = 'https://calendar.example/alice/'
function fakeClient(ics = remoteSeries()) {
  let revision = 0
  const resource = { url: calendarUrl + 'series.ics', etag: '"v0"', data: ics }
  const client = { status: 204, resources: new Map([['remote-series', resource]]), fetched: 0, updated: [], created: [],
    fetchCalendars: async () => [{ url: calendarUrl, displayName: 'Test', components: ['VEVENT'] }],
    fetchCalendarObjects: async () => { client.fetched++; await client.beforeFetch?.(); return [...client.resources.values()].map(row => ({ ...row })) },
    updateCalendarObject: async ({ calendarObject }) => {
      client.updated.push(calendarObject); await client.beforeUpdate?.()
      const response = new Response(null, { status: client.status, headers: { etag: `"v${++revision}"` } })
      if (response.ok) client.resources.set(core.icsResourceUid(calendarObject.data), { url: calendarObject.url, etag: response.headers.get('etag'), data: calendarObject.data })
      return response
    },
    createCalendarObject: async input => {
      client.created.push(input)
      const response = new Response(null, { status: client.status, headers: { etag: `"v${++revision}"` } })
      if (response.ok) client.resources.set(core.icsResourceUid(input.iCalString), { url: calendarUrl + input.filename, etag: response.headers.get('etag'), data: input.iCalString })
      return response
    },
    deleteCalendarObject: async () => new Response(null, { status: 204 }) }
  globalThis.__calendarClient = client
  core.setCalDavConfig(owner, { serverUrl: 'https://calendar.example', username: 'alice', password: 'test-only', calendarUrl })
  return client
}

test('remote future edits update offline immediately and failed PUT retains its durable command for retry', async () => {
  const client = fakeClient()
  await core.syncCalendar(owner)
  const selected = core.listDayEvents('2026-10-22', owner).find(row => row.caldav_uid)
  assert.deepEqual(core.getEventSeriesContext(selected.id).scopes, ['occurrence', 'future', 'series'])
  core.updateEventSeries(selected.id, { title: 'Saved offline future', starts_at: local('2026-10-22', 19), ends_at: local('2026-10-22', 20) }, 'future')
  assert.equal(core.listDayEvents('2026-10-29', owner)[0].title, 'Saved offline future')
  assert.equal(new Date(core.listDayEvents('2026-10-29', owner)[0].starts_at).getHours(), 19)
  assert.equal(core.listDayEvents('2026-10-15', owner)[0].title, 'Study group')
  client.status = 503
  await assert.rejects(core.syncCalendar(owner), /HTTP 503/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_resource_changes').get().n, 1)
  client.status = 204
  await core.syncCalendar(owner)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_resource_changes').get().n, 0)
  assert.equal(range(client.resources.get('remote-series').data)[2].summary, 'Saved offline future')
})

test('pending single-date exception composes with an offline master clock edit without duplicate dates', async () => {
  const client = fakeClient()
  await core.syncCalendar(owner)
  const exception = core.listDayEvents('2026-10-29', owner)[0]
  core.updateEventSeries(exception.id, { title: 'Independent exception', starts_at: local('2026-10-29', 20), ends_at: local('2026-10-29', 21) }, 'occurrence')
  const selected = core.listDayEvents('2026-10-22', owner)[0]
  core.updateEventSeries(selected.id, { title: 'Whole series', starts_at: local('2026-10-15', 9), ends_at: local('2026-10-15', 10) }, 'series')
  const visible = core.listEvents({ from: local('2026-10-01'), to: local('2026-12-01'), personId: owner })
  assert.equal(visible.length, 6)
  assert.equal(visible.filter(row => core.localDateKey(new Date(row.starts_at)) === '2026-10-29').length, 1)
  assert.equal(core.listDayEvents('2026-10-29', owner)[0].title, 'Independent exception')
  assert.equal(new Date(core.listDayEvents('2026-10-29', owner)[0].starts_at).getHours(), 20)
  await core.syncCalendar(owner)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_resource_changes').get().n, 0)
  assert.equal(range(client.resources.get('remote-series').data).length, 6)
})

test('pending occurrence deletion shifts with an offline series clock edit and cannot reappear', async () => {
  const client = fakeClient()
  await core.syncCalendar(owner)
  const removed = core.listDayEvents('2026-11-19', owner)[0]
  core.deleteEvent(removed.id)
  const selected = core.listDayEvents('2026-10-22', owner)[0]
  core.updateEventSeries(selected.id, { title: 'New clock', starts_at: local('2026-10-15', 9), ends_at: local('2026-10-15', 10) }, 'series')
  assert.equal(core.listDayEvents('2026-11-19', owner).length, 0)
  assert.equal(core.prepareRestoredRemoteOccurrence(owner, 'remote-series', removed.caldav_recurrence_id), false, 'obsolete clock identity restores detached')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_resource_changes').get().n, 2)
  await core.syncCalendar(owner)
  assert.equal(range(client.resources.get('remote-series').data).length, 5)
  assert.equal(core.listDayEvents('2026-11-19', owner).length, 0)
})

test('Trash reconciliation cancels a queued date exclusion only when its series identity still matches', async () => {
  const client = fakeClient()
  await core.syncCalendar(owner)
  const removed = core.listDayEvents('2026-11-19', owner)[0]
  core.deleteEvent(removed.id)
  const selected = core.listDayEvents('2026-10-22', owner)[0]
  core.updateEventSeries(selected.id, { title: 'New title', starts_at: local('2026-10-15', 17), ends_at: local('2026-10-15', 18) }, 'series')
  assert.equal(core.prepareRestoredRemoteOccurrence(owner, 'remote-series', removed.caldav_recurrence_id), true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calendar_resource_changes').get().n, 1)
  assert.equal(client.updated.length, 0)
})

test('restored recurrence with a missing remote UID becomes one independent local event', async () => {
  const client = fakeClient(); client.resources.clear()
  const restored = core.createEvent({ title: 'Restored dated event', person_id: owner, starts_at: local('2026-10-22', 17), ends_at: local('2026-10-22', 18),
    source: 'caldav', caldav_uid: 'deleted-series', caldav_recurrence_id: '2026-10-22T17:00:00', caldav_url: calendarUrl + 'deleted.ics' })
  db.prepare('UPDATE events SET calendar_dirty = 1, calendar_restore = 1 WHERE id = ?').run(restored.id)
  await core.syncCalendar(owner)
  const saved = core.getEvent(restored.id)
  assert.equal(saved.caldav_recurrence_id, null)
  assert.equal(saved.caldav_uid, `doneline-${restored.id}`)
  assert.equal(saved.calendar_restore, 0)
  assert.equal(client.created.length, 1)
  assert.equal(core.parseICSOccurrences(client.created[0].iCalString, local('2026-10-01'), local('2026-12-01')).length, 1)
})

test('restored occurrence in an existing resource uses its fresh ETag and clears only the restored EXDATE', async () => {
  const client = fakeClient()
  const restored = core.createEvent({ title: 'Restored deleted date', person_id: owner, starts_at: local('2026-11-12', 17), ends_at: local('2026-11-12', 18),
    source: 'caldav', caldav_uid: 'remote-series', caldav_recurrence_id: '2026-11-12T17:00:00', caldav_url: calendarUrl + 'series.ics', caldav_etag: 'obsolete' })
  db.prepare('UPDATE events SET calendar_dirty = 1, calendar_restore = 1 WHERE id = ?').run(restored.id)
  await core.syncCalendar(owner)
  assert.equal(core.getEvent(restored.id).calendar_restore, 0)
  assert.equal(client.updated[0].etag, '"v0"')
  assert.equal(range(client.resources.get('remote-series').data).length, 7)
})

test('calendar restore pause waits for an active sync and defers new manual sync until restore finishes', async () => {
  const client = fakeClient()
  let releaseFetch, releaseRestore
  let entered = false
  client.beforeFetch = () => new Promise(resolve => { releaseFetch = resolve })
  const flight = core.syncCalendar(owner)
  while (!releaseFetch) await new Promise(resolve => setImmediate(resolve))
  const pause = core.withCalendarSyncPaused(async () => { entered = true; await new Promise(resolve => { releaseRestore = resolve }) })
  const nextFlight = core.syncCalendar(owner)
  assert.equal(entered, false)
  releaseFetch(); await flight
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.fetched, 1)
  client.beforeFetch = undefined
  releaseRestore(); await pause; await nextFlight
  assert.equal(client.fetched, 2)
})
