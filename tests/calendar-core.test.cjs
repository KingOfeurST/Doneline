const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, beforeEach, after } = require('node:test')
const { buildSync } = require('esbuild')

process.env.TZ = 'Europe/Paris'
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-calendar-core-'))
process.env.DONELINE_DIR = path.join(temporary, 'data')
process.env.DONELINE_DB = ':memory:'
const compiled = path.join(temporary, 'core.cjs')
buildSync({ entryPoints: [path.join(root, 'core/index.ts')], bundle: true, platform: 'node', format: 'cjs',
  external: ['libsql'], banner: { js: `module.paths.unshift(${JSON.stringify(path.join(root, 'node_modules'))});` }, outfile: compiled, logLevel: 'silent' })
const core = require(compiled)
const db = core.getDb()
const [me, friend] = core.listPeople()
const iso = (day, time = '00:00') => new Date(`${day}T${time}:00`).toISOString()
const event = (title, start, end, extra = {}) => core.createEvent({ title, starts_at: start, ends_at: end, person_id: me.id, ...extra })

beforeEach(() => {
  for (const table of ['todo_completions', 'reactions', 'todos', 'goals', 'events', 'calendar_tombstones', 'calendar_resources', 'settings']) db.prepare(`DELETE FROM ${table}`).run()
})
after(() => {
  core.closeDb()
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temporary).startsWith('doneline-calendar-core-'))
  fs.rmSync(temporary, { recursive: true, force: true })
})

test('date writers reject impossible days, clock values, empty titles and nonexistent owners', () => {
  for (const invalid of ['2026-02-30T09:00', '2026-10-10T24:00', 'nonsense', '2026-03-29T02:30']) {
    assert.throws(() => core.createTodo({ title: 'Invalid', due_at: invalid }), /valid|exist/)
  }
  assert.throws(() => core.createTodo({ title: '  ' }), /title/)
  assert.throws(() => core.createGoal({ title: 'Invalid owner', person_id: 'missing' }), /profile/)
  assert.throws(() => event('Backwards', iso('2026-10-08', '10:00'), iso('2026-10-08', '09:00')), /end after/)
  assert.throws(() => event('Instant', iso('2026-10-08', '10:00'), iso('2026-10-08', '10:00')), /end after/)
})

test('calendar day boundaries are exclusive and follow local dates across DST', () => {
  const previous = event('Previous night', iso('2026-10-07', '23:00'), iso('2026-10-08'))
  const overnight = event('Overnight', iso('2026-10-07', '23:30'), iso('2026-10-08', '01:00'))
  const whole = event('All day', iso('2026-03-29'), iso('2026-03-29'), { all_day: true })
  const rows = core.listDayEvents('2026-10-08')
  assert.equal(rows.some((row) => row.id === previous.id), false)
  assert.equal(rows.some((row) => row.id === overnight.id), true)
  assert.equal(new Date(whole.ends_at).getTime() - new Date(whole.starts_at).getTime(), 23 * 3600000)
  assert.equal(core.listDayEvents('2026-03-30').some((row) => row.id === whole.id), false)
})

test('moving only an event start preserves timed duration and all-day calendar span', () => {
  const timed = event('Move me', iso('2026-10-08', '09:00'), iso('2026-10-08', '10:30'))
  const moved = core.updateEvent(timed.id, { starts_at: iso('2026-10-09', '14:00') })
  assert.equal(moved.ends_at, iso('2026-10-09', '15:30'))
  const whole = event('Two days', iso('2026-03-28'), iso('2026-03-30'), { all_day: true })
  const later = core.updateEvent(whole.id, { starts_at: iso('2026-10-08') })
  assert.equal(later.ends_at, iso('2026-10-10'))
})

test('range removal matches inclusive days and owner/title literally, leaving the rule active', () => {
  const rule = event('Thursday [class]', iso('2026-10-01', '09:00'), iso('2026-10-01', '10:00'), {
    recurrence: JSON.stringify({ freq: 'weekly', days: [4], startDate: '2026-10-01', endDate: '2026-10-29' })
  })
  const other = event('Thursday [class]', iso('2026-10-08', '09:00'), iso('2026-10-08', '10:00'), { person_id: friend.id, shared: true })
  const otherTitle = event('Unrelated', iso('2026-10-08', '09:00'), iso('2026-10-08', '10:00'))
  const input = { kind: 'events', fromDay: '2026-10-08', toDay: '2026-10-15', title: '[CLASS]', personId: me.id }
  const preview = core.previewRemoval(input)
  assert.equal(preview.events.length, 2)
  assert.equal(preview.events.some((row) => row.id === rule.id || row.id === other.id), false)
  const removed = core.removeRange({ ...input, expectedIds: preview.events.map((row) => `events:${row.id}`) })
  assert.deepEqual({ events: removed.events, todos: removed.todos }, { events: 2, todos: 0 })
  assert.equal(removed.trashIds.length, 2)
  const remaining = core.listEvents({ from: iso('2026-10-01'), to: iso('2026-11-01') })
  assert.deepEqual(remaining.filter((row) => row.recur_parent === rule.id).map((row) => core.localDateKey(new Date(row.starts_at))), ['2026-10-01', '2026-10-22', '2026-10-29'])
  assert.ok(core.getEvent(other.id))
  assert.ok(core.getEvent(otherTitle.id))
  assert.ok(core.getEvent(rule.id).recurrence)
})

test('a changed removal preview rejects the whole operation without partial deletion', () => {
  const first = event('Class', iso('2026-10-08', '09:00'), iso('2026-10-08', '10:00'))
  const input = { kind: 'events', fromDay: '2026-10-08', toDay: '2026-10-08', title: 'Class' }
  const preview = core.previewRemoval(input)
  const second = event('Class extra', iso('2026-10-08', '11:00'), iso('2026-10-08', '12:00'))
  assert.throws(() => core.removeRange({ ...input, expectedIds: preview.events.map((row) => `events:${row.id}`) }), /changed/)
  assert.ok(core.getEvent(first.id))
  assert.ok(core.getEvent(second.id))
})

test('range removal of future recurring todos creates persistent exceptions', () => {
  const template = core.createTodo({ title: 'Prep', due_at: iso('2026-10-01', '08:15'), recurrence: JSON.stringify({ freq: 'weekly', days: [4], startDate: '2026-10-01', endDate: '2026-10-29' }) })
  const input = { kind: 'todos', fromDay: '2026-10-08', toDay: '2026-10-15', title: 'Prep' }
  assert.equal(core.previewRemoval(input).todos.length, 2)
  const removed = core.removeRange(input)
  assert.deepEqual({ events: removed.events, todos: removed.todos }, { events: 0, todos: 2 })
  assert.equal(removed.trashIds.length, 2)
  core.ensureTodoInstancesForRange('2026-10-01', '2026-10-29')
  const rows = db.prepare('SELECT * FROM todos WHERE recur_parent = ? ORDER BY due_at').all(template.id)
  assert.deepEqual(rows.map((row) => core.localDateKey(new Date(row.due_at))), ['2026-10-01', '2026-10-22', '2026-10-29'])
  assert.ok(core.getTodo(template.id).recurrence)
})

test('previewing future recurring todos does not bring them into an earlier Today list', () => {
  const template = core.createTodo({ title: 'Future repeat', due_at: iso('2026-10-22', '09:00'), recurrence: JSON.stringify({ freq: 'daily', startDate: '2026-10-22', endDate: '2026-10-23' }) })
  core.previewRemoval({ kind: 'todos', fromDay: '2026-10-22', toDay: '2026-10-23' })
  assert.equal(core.listTodayTodos('2026-10-10').some((row) => row.recur_parent === template.id), false)
  assert.equal(core.listTodayTodos('2026-10-22').filter((row) => row.recur_parent === template.id).length, 1)
})

test('single-occurrence edits stay detached when the rule is materialized again', () => {
  const template = event('Class', iso('2026-10-01', '09:00'), iso('2026-10-01', '10:00'), { recurrence: JSON.stringify({ freq: 'weekly', days: [4], startDate: '2026-10-01', endDate: '2026-10-22' }) })
  const occurrence = core.listDayEvents('2026-10-08')[0]
  core.updateEvent(occurrence.id, { title: 'One exception', starts_at: iso('2026-10-09', '09:00'), ends_at: iso('2026-10-09', '10:00') })
  assert.equal(core.getEvent(occurrence.id).recur_parent, null)
  assert.equal(core.listDayEvents('2026-10-08').length, 0)
  assert.equal(core.listDayEvents('2026-10-09')[0].title, 'One exception')
  assert.ok(core.getEvent(template.id).recurrence)
})

test('goal progress survives archive retention and reopening resets archive state', () => {
  const goal = core.createGoal({ title: 'Read' })
  const kept = core.createTodo({ title: 'Goal history', goal_id: goal.id })
  const expired = core.createTodo({ title: 'Standalone history' })
  for (const task of [kept, expired]) { core.setTodoDone(task.id, true); db.prepare('UPDATE todos SET completed_at = ?, archived = 1 WHERE id = ?').run('2026-01-01T00:00:00.000Z', task.id) }
  core.purgeArchivedOlderThan(14)
  assert.equal(core.getTodo(expired.id), undefined)
  assert.ok(core.getTodo(kept.id))
  assert.equal(core.getGoal(goal.id).todo_done, 1)
  core.setTodoDone(kept.id, false)
  assert.equal(core.getTodo(kept.id).archived, 0)
  assert.equal(core.getGoal(goal.id).todo_done, 0)
})

test('goal deletion removes linked work and dependent completion/reaction records', () => {
  const goal = core.createGoal({ title: 'Remove all', shared: true })
  const task = core.createTodo({ title: 'Linked', goal_id: goal.id })
  core.setTodoDone(task.id, true, me.id)
  core.toggleReaction(task.id, friend.id, '👍')
  const unrelated = core.createTodo({ title: 'Keep' })
  core.deleteGoal(goal.id)
  assert.equal(core.getGoal(goal.id), undefined)
  assert.equal(core.getTodo(task.id), undefined)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todo_completions').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reactions').get().n, 0)
  assert.ok(core.getTodo(unrelated.id))
})

test('shared goals and their todos are visible from either profile', () => {
  const shared = core.createGoal({ title: 'Together', person_id: me.id, shared: true })
  const task = core.createTodo({ title: 'Both do this', person_id: me.id, goal_id: shared.id })
  const privateTask = core.createTodo({ title: 'Only me', person_id: me.id })
  assert.ok(core.listGoals({ personId: friend.id }).some((row) => row.id === shared.id))
  const visible = core.listTodos({ personId: friend.id })
  assert.ok(visible.some((row) => row.id === task.id))
  assert.equal(visible.some((row) => row.id === privateTask.id), false)
})

test('moving completed work into a shared goal preserves my part and requires the other profile', () => {
  const shared = core.createGoal({ title: 'Together', shared: true })
  const task = core.createTodo({ title: 'Previously done', person_id: me.id })
  core.setTodoDone(task.id, true)
  const linked = core.updateTodo(task.id, { goal_id: shared.id })
  assert.equal(linked.completed_at, null)
  assert.ok(linked.done_by.includes(me.id))
  const both = core.setTodoDone(task.id, true, friend.id)
  assert.ok(both.completed_at)
  const privateAgain = core.updateTodo(task.id, { goal_id: null })
  assert.ok(privateAgain.completed_at)
  assert.equal(privateAgain.done_by, null)
  const unfinished = core.createTodo({ title: 'Someone else did their part', person_id: me.id, goal_id: shared.id })
  core.setTodoDone(unfinished.id, true, friend.id)
  assert.equal(core.updateTodo(unfinished.id, { goal_id: null }).completed_at, null)
})

test('editing or removing a shared repeat rule preserves partially completed occurrences', () => {
  const goal = core.createGoal({ title: 'Shared repeat', shared: true })
  const due = new Date(); due.setDate(due.getDate() + 3); due.setHours(8, 0, 0, 0)
  const template = core.createTodo({ title: 'Shared routine', goal_id: goal.id, due_at: due.toISOString(), recurrence: JSON.stringify({ freq: 'daily' }) })
  core.ensureTodoInstancesForDate(due)
  const child = db.prepare('SELECT id FROM todos WHERE recur_parent = ?').get(template.id)
  core.setTodoDone(child.id, true, me.id)
  core.updateTodo(template.id, { title: 'Updated routine' })
  core.ensureTodoInstancesForDate(due)
  assert.ok(core.getTodo(child.id).done_by.includes(me.id))
  assert.equal(db.prepare('SELECT COUNT(*) n FROM todos WHERE recur_parent = ?').get(template.id).n, 1)
  core.deleteTodo(template.id)
  assert.equal(core.getTodo(child.id).recur_parent, null)
  assert.ok(core.getTodo(child.id).done_by.includes(me.id))
  assert.equal(core.getTodo(child.id).completed_at, null)
})

test('transferring a synced occurrence records the old owner deletion and creates a local target', () => {
  const original = event('Move owner', iso('2026-10-08', '09:00'), iso('2026-10-08', '10:00'), { source: 'caldav', caldav_uid: 'remote-series', caldav_url: 'https://example.test/old/series.ics', caldav_recurrence_id: '2026-10-08T09:00:00' })
  const moved = core.updateEvent(original.id, { person_id: friend.id })
  assert.equal(moved.caldav_uid, null)
  assert.equal(moved.source, 'local')
  assert.equal(moved.person_id, friend.id)
  const marker = db.prepare('SELECT * FROM calendar_tombstones').get()
  assert.equal(marker.person_id, me.id)
  assert.equal(marker.recurrence_id, original.caldav_recurrence_id)
})
