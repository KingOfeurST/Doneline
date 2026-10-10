import test from 'node:test'
import assert from 'node:assert/strict'
import type { TodoWithGoal } from '../src/shared/api'
import { isTodoDoneForSelf, optimisticTodoCompletion, TodoLoadGuard } from '../src/renderer/src/lib/todoCompletion'
import { FocusClock } from '../src/renderer/src/lib/focusClock'
import { KeyedSerialQueue } from '../src/renderer/src/lib/serialQueue'
import { fmtDayLabel, localDateInput, parseCreatedAt, toISO } from '../src/renderer/src/lib/format'

function todo(patch: Partial<TodoWithGoal> = {}): TodoWithGoal {
  return {
    id: 'task', person_id: 'alice', title: 'Read', goal_id: null, notes: null, due_at: null,
    completed_at: null, position: 0, archived: 0, recurrence: null, recur_parent: null,
    created_at: '2026-10-10T09:00:00Z', goal_title: null, goal_color: null, goal_shared: null,
    done_by: null, person_name: 'Alice', person_emoji: 'A', ...patch
  }
}

test('day labels retain their calendar day west of UTC', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Pacific/Honolulu'
  try {
    const expected = new Date(2026, 9, 10).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    assert.equal(fmtDayLabel('2026-10-10'), expected)
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('legacy template creation timestamps retain the UTC instant and local repeat day', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Europe/Paris'
  try {
    const created = parseCreatedAt('2026-10-09 23:30:00')
    assert.equal(created.toISOString(), '2026-10-09T23:30:00.000Z')
    assert.equal(localDateInput(created), '2026-10-10')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('date/time conversion rejects invalid fields instead of normalizing them', () => {
  assert.throws(() => toISO('2026-02-30', '09:00'), /valid date/)
  assert.throws(() => toISO('2026-13-01', '09:00'), /valid date/)
  assert.throws(() => toISO('2026-03-01', '24:00'), /valid time/)
  assert.throws(() => toISO('2026-03-01', '09:60'), /valid time/)
  assert.throws(() => toISO('2026-3-1', '09:00'), /valid date/)
})

test('date/time conversion rejects DST gaps and preserves neighboring local times', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Europe/Paris'
  try {
    assert.throws(() => toISO('2026-03-29', '02:30'), /does not exist in your time zone/)
    assert.equal(toISO('2026-03-29', '01:30'), '2026-03-29T00:30:00.000Z')
    assert.equal(toISO('2026-03-29', '03:30'), '2026-03-29T01:30:00.000Z')
    assert.equal(toISO('2028-02-29', ''), '2028-02-28T23:00:00.000Z')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('personal completion immediately leaves the open list and can be reopened', () => {
  const original = todo()
  const done = optimisticTodoCompletion(original, true, 'alice', ['alice'], '2026-10-10T10:00:00Z')
  assert.equal(isTodoDoneForSelf(original, 'alice'), false)
  assert.equal(isTodoDoneForSelf(done, 'alice'), true)
  assert.equal(original.completed_at, null)
  assert.equal(optimisticTodoCompletion(done, false, 'alice', ['alice']).completed_at, null)
})

test('shared completion hides my own remaining task before everyone is finished', () => {
  const shared = todo({ goal_shared: 1 })
  const mine = optimisticTodoCompletion(shared, true, 'alice', ['alice', 'bob'])
  assert.equal(mine.completed_at, null)
  assert.equal(isTodoDoneForSelf(mine, 'alice'), true)
  assert.equal(isTodoDoneForSelf(mine, 'bob'), false)
  const both = optimisticTodoCompletion(mine, true, 'bob', ['alice', 'bob'])
  assert.ok(both.completed_at)
  const reopenMine = optimisticTodoCompletion(both, false, 'alice', ['alice', 'bob'])
  assert.equal(reopenMine.completed_at, null)
  assert.equal(reopenMine.done_by, 'bob')
})

test('clicks invalidate older reads, repeated pending clicks are ignored, and old profiles cannot win', () => {
  const guard = new TodoLoadGuard()
  const oldRead = guard.beginLoad()
  const done = optimisticTodoCompletion(todo(), true, 'alice', ['alice'])
  assert.equal(guard.beginMutation(done), true)
  assert.equal(guard.isCurrent(oldRead), false)
  assert.equal(guard.beginMutation(done), false)
  const duringWrite = guard.beginLoad()
  const overlaid = guard.applyPending([todo({ title: 'Renamed remotely' })])[0]
  assert.equal(overlaid.title, 'Renamed remotely')
  assert.ok(overlaid.completed_at)
  guard.finishMutation(done.id)
  assert.equal(guard.isCurrent(duringWrite), false)
  const oldProfile = guard.beginLoad()
  const newProfile = guard.beginLoad()
  assert.equal(guard.isCurrent(oldProfile), false)
  assert.equal(guard.isCurrent(newProfile), true)
  assert.equal(guard.applyPending([todo()])[0].completed_at, null)
})

test('another task completing preserves an optimistic task still being saved', () => {
  const guard = new TodoLoadGuard()
  const first = optimisticTodoCompletion(todo(), true, 'alice', ['alice'])
  const second = optimisticTodoCompletion(todo({ id: 'second' }), true, 'alice', ['alice'])
  guard.beginMutation(first)
  guard.beginMutation(second)
  guard.finishMutation(first.id)
  const rows = guard.applyPending([first, todo({ id: 'second' })])
  assert.ok(rows.every((row) => row.completed_at !== null))
})

test('focus timer follows elapsed time after a delayed tick and never credits paused time', () => {
  const clock = new FocusClock(1500)
  clock.start(0)
  assert.equal(clock.advance(90_000), 1410)
  clock.pause(120_000)
  assert.equal(clock.advance(3_720_000), 1380)
  clock.start(3_720_000)
  assert.equal(clock.advance(3_780_000), 1320)
  assert.equal(clock.takeRecordableSeconds(3_780_000), 180)
  assert.equal(clock.takeRecordableSeconds(3_780_000), 0)
})

test('extra minutes count all time actually spent focusing', () => {
  const clock = new FocusClock(1500)
  clock.start(0)
  assert.equal(clock.extend(300, 600_000), 1200)
  assert.equal(clock.totalSeconds, 1800)
  assert.equal(clock.advance(1_800_000), 0)
  assert.equal(clock.takeRecordableSeconds(1_800_000), 1800)
})

test('focus time is capped at its phase boundary and prep/short blocks earn no session', () => {
  const clock = new FocusClock(60)
  assert.equal(clock.takeRecordableSeconds(10_000), 0)
  clock.start(10_000)
  assert.equal(clock.advance(10_000_000), 0)
  assert.equal(clock.takeRecordableSeconds(10_000_000), 60)
  clock.reset(1500)
  clock.start(11_000_000)
  clock.pause(11_030_000)
  assert.equal(clock.takeRecordableSeconds(12_000_000), 0)
})

test('note writes stay ordered across editors, while separate notes can save independently', async () => {
  const queue = new KeyedSerialQueue()
  const calls: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const first = queue.run('alice:today', async () => { calls.push('first'); await blocked })
  const second = queue.run('alice:today', async () => { calls.push('second') })
  const other = queue.run('bob:today', async () => { calls.push('other') })
  await other
  assert.deepEqual(calls, ['first', 'other'])
  release()
  await Promise.all([first, second, queue.wait('alice:today')])
  assert.deepEqual(calls, ['first', 'other', 'second'])
})

test('a failed note save does not prevent the next draft from saving', async () => {
  const queue = new KeyedSerialQueue()
  const failed = queue.run('note', async () => { throw new Error('write failed') })
  const next = queue.run('note', async () => 'new draft')
  await assert.rejects(failed, /write failed/)
  assert.equal(await next, 'new draft')
})
