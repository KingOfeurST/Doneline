const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test, after } = require('node:test')
const { buildSync } = require('esbuild')

// Exercise a real file across separate app lifetimes. No child can reach a
// user's database/config; exiting also releases deferred libsql native handles.
const workspace = path.resolve(__dirname, '..')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-notes-persistence-'))
const compiled = path.join(directory, 'core.cjs')
const childScript = path.join(directory, 'child.cjs')
const database = path.join(directory, 'notes.db')
const fixture = {
  day: '2026-10-10',
  previousDay: '2026-10-09',
  clearedDay: '2026-10-08',
  body: 'Plans — café, 東京, 📝\nSecond line\n\nLast line with trailing spaces  ',
  otherPersonBody: 'The other profile owns this note.\nSeparate text.',
  previousBody: 'Keep yesterday’s note after today opens.',
  laterBody: 'Updated after reopen.\nÉcriture persistante ✅'
}

buildSync({
  stdin: {
    contents: `export { initDb, getDb, closeDb, reopenDb } from './core/db';
      export { getDailyNote, setDailyNote, listNoteDays } from './core/notes';
      export { listPeople } from './core/people'; export { runMaintenance } from './core/recurrence';`,
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

fs.writeFileSync(childScript, String.raw`
const core = require('./core.cjs')
const fixture = JSON.parse(process.env.DONELINE_NOTES_FIXTURE)
function readNote(day, personId) {
  const note = core.getDailyNote(day, personId)
  // Native query timing metadata is transient and is not stored note data.
  return { day: note.day, person_id: note.person_id, body: note.body, updated_at: note.updated_at }
}
async function main() {
  await core.initDb()
  const people = core.listPeople()
  const [self, friend] = people
  const mode = process.env.DONELINE_NOTES_MODE
  let maintenance
  if (mode === 'write') {
    core.setDailyNote(fixture.day, fixture.body, self.id)
    core.setDailyNote(fixture.day, fixture.otherPersonBody, friend.id)
    core.setDailyNote(fixture.previousDay, fixture.previousBody, self.id)
    core.setDailyNote(fixture.clearedDay, 'This note will be explicitly cleared.', self.id)
  }
  if (mode === 'update-and-maintain') {
    core.setDailyNote(fixture.day, fixture.laterBody, self.id)
    core.setDailyNote(fixture.clearedDay, '', self.id)
    // Force both archive and purge to do real work while preserving old notes.
    core.getDb().prepare('INSERT INTO todos (id,title,person_id,completed_at) VALUES (?,?,?,?)')
      .run('old-finished-task', 'Maintenance fixture', self.id, '2000-01-01T00:00:00.000Z')
    maintenance = core.runMaintenance({ now: new Date('2026-10-10T10:00:00.000Z') })
  }
  // Verify reinitialization in this process, then the parent starts a fresh one.
  core.closeDb()
  await core.initDb()
  const beforeReopen = readNote(fixture.day, self.id)
  await core.reopenDb()
  const afterReopen = readNote(fixture.day, self.id)
  const result = {
    people: core.listPeople().map((person) => person.id),
    self: readNote(fixture.day, self.id),
    friend: readNote(fixture.day, friend.id),
    previous: readNote(fixture.previousDay, self.id),
    cleared: readNote(fixture.clearedDay, self.id),
    missing: readNote('2026-10-07', self.id),
    selfDays: core.listNoteDays(self.id),
    friendDays: core.listNoteDays(friend.id),
    rows: core.getDb().prepare('SELECT COUNT(*) AS n FROM daily_notes').get().n,
    sameAfterReopen: JSON.stringify(beforeReopen) === JSON.stringify(afterReopen),
    maintenance
  }
  core.closeDb()
  console.log(JSON.stringify(result))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
`)

function run(mode) {
  const result = spawnSync(process.execPath, [childScript], {
    env: {
      ...process.env,
      TZ: 'Europe/Paris',
      DONELINE_DIR: path.join(directory, 'private-data'),
      DONELINE_DB: database,
      DONELINE_NOTES_MODE: mode,
      DONELINE_NOTES_FIXTURE: JSON.stringify(fixture)
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1))
}

after(() => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('doneline-notes-persistence-'))
  assert.equal(path.dirname(path.resolve(database)), path.resolve(directory))
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('daily notes persist exact text, day and profile across database close, reinit and fresh processes', () => {
  const written = run('write')
  assert.equal(written.self.body, fixture.body)
  assert.equal(written.self.day, fixture.day)
  assert.equal(written.self.person_id, written.people[0])
  assert.equal(written.friend.body, fixture.otherPersonBody)
  assert.equal(written.friend.person_id, written.people[1])
  assert.equal(written.previous.body, fixture.previousBody)
  assert.equal(written.rows, 4)
  assert.equal(written.sameAfterReopen, true)
  assert.equal(written.missing.body, '')
  assert.equal(written.missing.updated_at, '')
  assert.ok(written.self.updated_at)
  assert.deepEqual(written.selfDays, [fixture.day, fixture.previousDay, fixture.clearedDay])
  assert.deepEqual(written.friendDays, [fixture.day])
  assert.deepEqual(run('read'), written)
})

test('explicit clearing persists and active archive/purge maintenance leaves every other note intact', () => {
  run('write')
  const changed = run('update-and-maintain')
  assert.equal(changed.self.body, fixture.laterBody)
  assert.equal(changed.friend.body, fixture.otherPersonBody)
  assert.equal(changed.previous.body, fixture.previousBody)
  assert.equal(changed.cleared.body, '')
  assert.ok(changed.cleared.updated_at, 'a persisted clear remains distinct from a missing note')
  assert.equal(changed.rows, 4, 'empty notes retain their stored day/profile row')
  assert.equal(changed.sameAfterReopen, true)
  assert.equal(changed.maintenance.archived, 1)
  assert.equal(changed.maintenance.purged, 1)
  assert.deepEqual(changed.selfDays, [fixture.day, fixture.previousDay])
  const reopened = run('read')
  const { maintenance, ...withoutMaintenance } = changed
  assert.deepEqual(reopened, withoutMaintenance)
})
