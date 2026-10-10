const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, after, beforeEach } = require('node:test')
const { buildSync } = require('esbuild')

// The suite uses a private temporary database and a fixed DST-observing zone.
process.env.TZ = 'Europe/Paris'
const workspace = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-recurrence-'))
process.env.DONELINE_DIR = path.join(temp, 'data')
// In-memory avoids libsql's deferred native file close holding a Windows lock.
process.env.DONELINE_DB = ':memory:'
const compiled = path.join(temp, 'core.cjs')
buildSync({
  stdin: {
    contents: `export * from './core/recurrence'; export * from './core/db'; export * from './core/events'; export * from './core/todos';`,
    resolveDir: workspace,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['libsql'],
  banner: { js: `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});` },
  outfile: compiled,
  logLevel: 'silent'
})
const core = require(compiled)
const db = core.getDb()

beforeEach(() => {
  db.prepare('DELETE FROM todo_completions').run()
  db.prepare('DELETE FROM reactions').run()
  db.prepare('DELETE FROM todos').run()
  db.prepare('DELETE FROM events').run()
})
after(() => {
  core.closeDb()
  // This is exclusively the generated temporary test directory.
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()))
  fs.rmSync(temp, { recursive: true, force: true })
})

const local = (date, hour = 0, minute = 0) => {
  const value = core.parseLocalDate(date)
  value.setHours(hour, minute, 0, 0)
  return value.toISOString()
}
const eventInstances = (id) => db.prepare('SELECT * FROM events WHERE recur_parent = ? ORDER BY starts_at').all(id)
const todoInstances = (id) => db.prepare('SELECT * FROM todos WHERE recur_parent = ? ORDER BY due_at').all(id)

test('rules validate date bounds and weekdays, with stable normalization', () => {
  assert.deepEqual(core.normalizeRecurrence({
    freq: 'weekly', days: [4, 4, 1], startDate: '2026-10-01', endDate: '2026-10-31',
    excludedDates: ['2026-10-08', '2026-10-08']
  }), {
    freq: 'weekly', days: [1, 4], startDate: '2026-10-01', endDate: '2026-10-31', excludedDates: ['2026-10-08']
  })
  assert.throws(() => core.normalizeRecurrence({ freq: 'weekly', days: [] }), /at least one weekday/)
  assert.throws(() => core.normalizeRecurrence({ freq: 'weekly', days: [7] }), /Weekdays/)
  assert.throws(() => core.normalizeRecurrence({ freq: 'monthly' }), /daily or weekly/)
  assert.throws(() => core.normalizeRecurrence({ freq: 'daily', startDate: '2026-02-30' }), /Invalid calendar date/)
  assert.throws(() => core.normalizeRecurrence({ freq: 'daily', startDate: '2026-10-08', endDate: '2026-10-01' }), /on or after/)
  assert.throws(() => core.normalizeRecurrenceJson('{broken'), /JSON/)
  assert.equal(core.parseRecurrence('{broken'), null)
  assert.equal(core.parseRecurrence('{"freq":"weekly","days":[]}'), null)
})

test('Thursday events stay inside inclusive bounds and excluded occurrences remain absent', () => {
  const template = core.createEvent({
    title: 'Thursday class', starts_at: local('2026-10-01', 9, 15), ends_at: local('2026-10-01', 10, 45), shared: true,
    recurrence: JSON.stringify({ freq: 'weekly', days: [4], startDate: '2026-10-01', endDate: '2026-10-22', excludedDates: ['2026-10-08'] })
  })
  core.ensureEventInstancesForRange('2026-09-01', '2026-11-30')
  const instances = eventInstances(template.id)
  assert.deepEqual(instances.map((item) => core.localDateKey(new Date(item.starts_at))), ['2026-10-01', '2026-10-15', '2026-10-22'])
  assert.ok(instances.every((item) => item.shared === 1))
  assert.ok(instances.every((item) => new Date(item.starts_at).getHours() === 9 && new Date(item.starts_at).getMinutes() === 15))
  assert.equal(core.ensureEventInstancesForRange('2026-09-01', '2026-11-30'), 0)
  assert.equal(eventInstances(template.id).length, 3)
})

test('unbounded event rules start at their template and generate requested dates beyond sixty days', () => {
  const template = core.createEvent({
    title: 'Future class', starts_at: local('2027-05-06', 15), ends_at: local('2027-05-06', 16),
    recurrence: JSON.stringify({ freq: 'weekly', days: [4] })
  })
  core.ensureEventInstancesForRange('2026-10-01', '2026-10-31')
  assert.equal(eventInstances(template.id).length, 0)
  core.ensureEventInstancesForRange('2027-05-01', '2027-05-31')
  assert.deepEqual(eventInstances(template.id).map((item) => core.localDateKey(new Date(item.starts_at))), ['2027-05-06', '2027-05-13', '2027-05-20', '2027-05-27'])
})

test('multi-day occurrences starting before a requested range still overlap it', () => {
  const template = core.createEvent({
    title: 'Weekend retreat', starts_at: local('2026-10-02', 18), ends_at: local('2026-10-04', 17),
    recurrence: JSON.stringify({ freq: 'weekly', days: [5], startDate: '2026-10-02' })
  })
  core.ensureEventInstancesForRange('2026-10-10', '2026-10-10')
  const instances = eventInstances(template.id)
  assert.equal(instances.length, 1)
  assert.equal(core.localDateKey(new Date(instances[0].starts_at)), '2026-10-09')
  assert.equal(core.localDateKey(new Date(instances[0].ends_at)), '2026-10-11')
})

test('recurring todos preserve due times, weekdays, start/end bounds, and exclusions', () => {
  const template = core.createTodo({
    title: 'Thursday homework', due_at: local('2026-10-01', 9, 30),
    recurrence: JSON.stringify({ freq: 'weekly', days: [4], endDate: '2026-10-22', excludedDates: ['2026-10-15'] })
  })
  core.ensureTodoInstancesForRange('2026-09-01', '2026-11-30')
  const instances = todoInstances(template.id)
  assert.deepEqual(instances.map((item) => core.localDateKey(new Date(item.due_at))), ['2026-10-01', '2026-10-08', '2026-10-22'])
  assert.ok(instances.every((item) => new Date(item.due_at).getHours() === 9 && new Date(item.due_at).getMinutes() === 30))
  assert.equal(core.ensureTodoInstancesForRange('2026-09-01', '2026-11-30'), 0)
})

test('new recurring todos without a due date never generate before creation', () => {
  const template = core.createTodo({ title: 'No date', recurrence: '{"freq":"daily"}' })
  db.prepare('UPDATE todos SET created_at = ? WHERE id = ?').run('2026-10-09 23:30:00', template.id)
  core.ensureTodoInstancesForDate('2026-10-09')
  assert.equal(todoInstances(template.id).length, 0)
  core.ensureTodoInstancesForDate('2026-10-10')
  assert.equal(todoInstances(template.id).length, 1)
  assert.equal(new Date(todoInstances(template.id)[0].due_at).getHours(), 23)
})

test('DST preserves local starts/ends and exclusive all-day duration across spring and autumn', () => {
  const originalStart = new Date(local('2026-03-20', 10))
  const originalEnd = new Date(local('2026-03-22', 11))
  const spring = core.occurrenceTimes(originalStart, originalEnd, core.parseLocalDate('2026-03-28'))
  assert.equal(core.localDateKey(spring.start), '2026-03-28')
  assert.equal(core.localDateKey(spring.end), '2026-03-30')
  assert.equal(spring.start.getHours(), 10)
  assert.equal(spring.end.getHours(), 11)
  assert.equal((spring.end - spring.start) / 3_600_000, 48)
  const oneDayStart = new Date(local('2026-03-01'))
  const oneDayEnd = new Date(local('2026-03-02'))
  const shortDay = core.occurrenceTimes(oneDayStart, oneDayEnd, core.parseLocalDate('2026-03-29'))
  const longDay = core.occurrenceTimes(oneDayStart, oneDayEnd, core.parseLocalDate('2026-10-25'))
  assert.equal(shortDay.end.getHours(), 0)
  assert.equal((shortDay.end - shortDay.start) / 3_600_000, 23)
  assert.equal(longDay.end.getHours(), 0)
  assert.equal((longDay.end - longDay.start) / 3_600_000, 25)
})

test('spring-forward missing times still generate a positive event duration', () => {
  const occurrence = core.occurrenceTimes(new Date(local('2026-03-22', 2, 30)), new Date(local('2026-03-22', 3)), core.parseLocalDate('2026-03-29'))
  assert.ok(occurrence.end > occurrence.start)
  assert.equal(occurrence.start.getHours(), 3)
})

test('maintenance with an injected day generates only that day of recurring todos', () => {
  const template = core.createTodo({ title: 'Daily bounded task', due_at: local('2026-10-01', 8), recurrence: '{"freq":"daily","endDate":"2026-10-31"}' })
  core.runMaintenance({ now: core.parseLocalDate('2026-10-10'), eventFrom: '2026-10-10', eventTo: '2026-10-10' })
  assert.deepEqual(todoInstances(template.id).map((item) => core.localDateKey(new Date(item.due_at))), ['2026-10-10'])
})

test('huge explicit ranges are rejected before any recurring rows are generated', () => {
  const event = core.createEvent({ title: 'Daily', starts_at: local('2026-10-01', 9), ends_at: local('2026-10-01', 10), recurrence: '{"freq":"daily"}' })
  const todo = core.createTodo({ title: 'Daily task', due_at: local('2026-10-01', 9), recurrence: '{"freq":"daily"}' })
  assert.throws(() => core.ensureEventInstancesForRange('2026-10-01', '2040-10-01'), /ten years/)
  assert.throws(() => core.ensureTodoInstancesForRange('2026-10-01', '2040-10-01'), /ten years/)
  assert.equal(eventInstances(event.id).length, 0)
  assert.equal(todoInstances(todo.id).length, 0)
})
