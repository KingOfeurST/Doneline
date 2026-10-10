const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, beforeEach, after } = require('node:test')
const { buildSync } = require('esbuild')

process.env.TZ = 'Europe/Paris'
const workspace = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-social-'))
process.env.DONELINE_DIR = temp
process.env.DONELINE_DB = ':memory:'
const compiled = path.join(temp, 'core.cjs')
buildSync({
  stdin: { contents: `export * from './core/db'; export * from './core/people'; export * from './core/prefs'; export * from './core/presence'; export * from './core/focusStats'; export * from './core/reactions'; export * from './core/notes'; export * from './core/todos'; export * from './core/goals';`, resolveDir: workspace, loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', external: ['libsql'],
  banner: { js: `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});` },
  outfile: compiled, logLevel: 'silent'
})
const core = require(compiled)
const db = core.getDb()
beforeEach(() => {
  for (const table of ['todo_completions', 'reactions', 'focus_sessions', 'nudges', 'focus_invites', 'presence', 'daily_notes', 'events', 'todos', 'goals', 'settings', 'people']) {
    db.exec(`DELETE FROM ${table}`)
  }
  db.prepare('INSERT INTO people (id,name,position) VALUES (?,?,?)').run('alice', 'Alice', 0)
  db.prepare('INSERT INTO people (id,name,position) VALUES (?,?,?)').run('bob', 'Bob', 1)
  fs.writeFileSync(path.join(temp, 'prefs.json'), '{}')
})
after(() => {
  core.closeDb()
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()))
  fs.rmSync(temp, { recursive: true, force: true })
})

test('self preferences resolve current membership and reject missing profiles', () => {
  core.setSelfPersonId('bob')
  assert.equal(core.getSelfPersonId(), 'bob')
  core.deletePerson('bob')
  assert.equal(core.getSelfPersonId(), null)
  assert.throws(() => core.setSelfPersonId('missing'), /existing profile/)
  fs.writeFileSync(path.join(temp, 'prefs.json'), '{"selfPersonId":42}')
  assert.equal(core.getSelfPersonId(), null)
})

test('corrupt notification/target preferences fall back and invalid writes are rejected', () => {
  fs.writeFileSync(path.join(temp, 'prefs.json'), JSON.stringify({ notifications: { enabled: 'false', eventLeadMin: -100, morningTime: '29:90' }, dailyTarget: 'Infinity' }))
  assert.deepEqual(core.getNotifPrefs(), core.DEFAULT_NOTIF_PREFS)
  assert.equal(core.getDailyTarget(), 4)
  assert.throws(() => core.setDailyTarget(NaN), /valid daily focus/)
  assert.throws(() => core.setNotifPrefs({ ...core.DEFAULT_NOTIF_PREFS, morningTime: '24:00' }), /morning time/)
  assert.throws(() => core.setNotifPrefs({ ...core.DEFAULT_NOTIF_PREFS, eventLeadMin: Infinity }), /1 and 120/)
})

test('shared completion recalculates on profile membership changes and preserves archived history', () => {
  const goal = core.createGoal({ title: 'Together', person_id: 'bob', shared: true })
  const task = core.createTodo({ title: 'Shared work', person_id: 'bob', goal_id: goal.id })
  core.setTodoDone(task.id, true, 'alice')
  assert.equal(core.getTodo(task.id).completed_at, null)
  core.setTodoDone(task.id, true, 'bob')
  assert.ok(core.getTodo(task.id).completed_at)
  const newcomer = core.createPerson({ name: 'Charlie' })
  assert.equal(core.getTodo(task.id).completed_at, null)
  core.deletePerson(newcomer.id)
  assert.ok(core.getTodo(task.id).completed_at)
  db.prepare('UPDATE todos SET archived = 1 WHERE id = ?').run(task.id)
  const historicalDate = core.getTodo(task.id).completed_at
  core.createPerson({ name: 'Another friend' })
  assert.equal(core.getTodo(task.id).completed_at, historicalDate)
})

test('profile deletion clears credentials and dependents, detaches others history, and refuses last profile', () => {
  const task = core.createTodo({ title: 'Owned task', person_id: 'alice' })
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('caldav:alice', '{}')
  core.setDailyNote('2026-10-10', 'Note', 'alice')
  core.setPresence('alice', { status: 'idle' })
  core.toggleReaction(task.id, 'bob', '👍')
  core.sendNudge('alice', 'bob', 'Hello')
  core.sendFocusInvite('alice', 'bob', 25, 5)
  const endedAt = new Date().toISOString()
  core.recordFocusSession({ personId: 'bob', taskId: task.id, durationSeconds: 60, startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt })
  core.deletePerson('alice')
  assert.equal(core.getTodo(task.id), undefined)
  for (const table of ['settings', 'reactions', 'daily_notes', 'presence', 'nudges', 'focus_invites']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table)
  }
  assert.equal(db.prepare('SELECT task_id FROM focus_sessions').get().task_id, null)
  assert.throws(() => core.deletePerson('bob'), /last profile/)
  assert.ok(core.getPerson('bob'))
  // Repeated delete of a missing profile remains harmless even with one left.
  assert.doesNotThrow(() => core.deletePerson('alice'))
})

test('nudge TTL parses both legacy UTC and ISO timestamps; social writes require valid people', () => {
  const nudge = core.sendNudge('alice', 'bob', 'Hello')
  const legacyFresh = new Date(Date.now() - 60_000).toISOString().replace('T', ' ').slice(0, 19)
  db.prepare('UPDATE nudges SET created_at = ? WHERE id = ?').run(legacyFresh, nudge.id)
  assert.equal(core.unseenNudgesFor('bob').length, 1)
  db.prepare('UPDATE nudges SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 11 * 60_000).toISOString(), nudge.id)
  assert.equal(core.unseenNudgesFor('bob').length, 0)
  assert.throws(() => core.sendNudge('alice', 'missing', 'Hello'), /existing profile/)
  assert.throws(() => core.sendNudge('alice', 'alice', 'Hello'), /another profile/)
  assert.throws(() => core.setPresence('missing', { status: 'idle' }), /existing profile/)
  assert.throws(() => core.setPresence('alice', { status: 'focusing', ends_at: 'broken' }), /not valid/)
})

test('focus invites expire correctly and a retry keeps one shared start anchor', () => {
  const invite = core.sendFocusInvite('alice', 'bob', 25, 5)
  assert.match(invite.created_at, /Z$/)
  assert.throws(() => core.startCoFocus(invite.id), /must join/)
  core.acceptInvite(invite.id)
  const anchor = core.startCoFocus(invite.id)
  assert.equal(core.startCoFocus(invite.id), anchor)
  assert.equal(core.pendingInvitesFor('bob').length, 0)
  const old = core.sendFocusInvite('alice', 'bob', 25, 5)
  db.prepare('UPDATE focus_invites SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 6 * 60_000).toISOString(), old.id)
  assert.equal(core.pendingInvitesFor('bob').length, 0)
  assert.throws(() => core.acceptInvite(old.id), /expired/)
  assert.equal(core.activeInviteFor('alice').id, invite.id)
  db.prepare('UPDATE focus_invites SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 60_000).toISOString(), invite.id)
  assert.equal(core.activeInviteFor('alice'), undefined)
  assert.throws(() => core.sendFocusInvite('alice', 'bob', NaN, 5), /whole minutes/)
  assert.throws(() => core.sendFocusInvite('alice', 'bob', 25, -5), /whole minutes/)
})

test('focus recording rejects invalid duration/time and duplicate IDs cannot create a shared streak', () => {
  const endedAt = new Date().toISOString()
  const input = { personId: 'alice', durationSeconds: 60, startedAt: new Date(Date.now() - 60_000).toISOString(), endedAt }
  core.recordFocusSession(input)
  assert.equal(core.focusStats('alice').todaySessions, 1)
  assert.throws(() => core.recordFocusSession({ ...input, durationSeconds: NaN }), /Focus duration/)
  assert.throws(() => core.recordFocusSession({ ...input, durationSeconds: 600 }), /cannot exceed/)
  assert.throws(() => core.recordFocusSession({ ...input, startedAt: 'broken' }), /not valid/)
  assert.equal(core.sharedFocusStreak(['alice', 'alice']), 0)
})

test('notes validate real days and reaction polling compares exact UTC instants', () => {
  assert.throws(() => core.setDailyNote('2026-02-30', 'invalid', 'alice'), /Invalid calendar date/)
  assert.throws(() => core.setDailyNote('2026-10-10', 'invalid', 'missing'), /existing profile/)
  assert.throws(() => core.listNoteDays('alice', -1), /1 to 1000/)
  const task = core.createTodo({ title: 'React to this', person_id: 'alice' })
  assert.throws(() => core.toggleReaction('missing', 'bob', '👍'), /no longer exists/)
  core.toggleReaction(task.id, 'bob', '👍')
  const since = '2026-10-10T10:00:00.500Z'
  db.prepare('UPDATE reactions SET created_at = ?').run('2026-10-10T10:00:00Z')
  assert.equal(core.newReactionsFor('alice', since).length, 0)
  db.prepare('UPDATE reactions SET created_at = ?').run('2026-10-10T10:00:00.750Z')
  assert.equal(core.newReactionsFor('alice', since).length, 1)
})
