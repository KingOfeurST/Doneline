const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { test, after } = require('node:test')
const { buildSync } = require('esbuild')

// Disk migrations run in child processes: libsql can retain native statements
// until process exit, so closing a connection alone may hold a Windows lock.
const workspace = path.resolve(__dirname, '..')
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-migration-test-'))
const compiled = path.join(temporaryRoot, 'core.cjs')
const childScript = path.join(temporaryRoot, 'child.cjs')
buildSync({
  entryPoints: [path.join(workspace, 'core', 'db.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['libsql'],
  banner: { js: `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});` },
  outfile: compiled,
  logLevel: 'silent'
})

fs.writeFileSync(childScript, `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});\n` + String.raw`
const Database = require('libsql')
const mode = process.env.DONELINE_MIGRATION_MODE

function seed(withRecurrence) {
  const db = new Database(process.env.DONELINE_DB)
  const owner = withRecurrence ? ', person_id TEXT' : ''
  const goalShared = withRecurrence ? ', shared INTEGER NOT NULL DEFAULT 0' : ''
  const todoExtra = withRecurrence ? ', archived INTEGER NOT NULL DEFAULT 0, recurrence TEXT, recur_parent TEXT' : ''
  const eventExtra = withRecurrence ? ', recurrence TEXT, recur_parent TEXT, shared INTEGER NOT NULL DEFAULT 0' : ''
  db.exec(
    'CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, emoji TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')));' +
    'CREATE TABLE goals (id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL DEFAULT \'#2f7a4d\', archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' + owner + goalShared + ');' +
    'CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal_id TEXT REFERENCES goals(id) ON DELETE SET NULL, notes TEXT, due_at TEXT, completed_at TEXT, position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' + owner + todoExtra + ');' +
    'CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, location TEXT, notes TEXT, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT \'#2f7a4d\', attendees TEXT, caldav_uid TEXT, caldav_etag TEXT, caldav_url TEXT, source TEXT NOT NULL DEFAULT \'local\', created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' + owner + eventExtra + ');' +
    'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);'
  )
  db.prepare('INSERT INTO people (id,name,color,emoji,position) VALUES (?,?,?,?,?)').run('existing-alex', 'Alex', '#112233', 'A', 0)
  db.prepare('INSERT INTO people (id,name,color,emoji,position) VALUES (?,?,?,?,?)').run('existing-belle', 'Belle', '#445566', 'B', 1)
  db.prepare('INSERT INTO goals (id,title) VALUES (?,?)').run('existing-goal', 'Keep this goal')
  db.prepare('INSERT INTO todos (id,title,goal_id,notes,due_at,completed_at) VALUES (?,?,?,?,?,?)')
    .run('existing-todo', 'Keep this task', 'existing-goal', 'Keep these notes', '2026-10-10T07:15:00.000Z', '2026-10-10T08:30:00.000Z')
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('existing-preference', 'Keep this setting')
  const insertEvent = db.prepare('INSERT INTO events (id,title,starts_at,ends_at,all_day) VALUES (?,?,?,?,?)')
  // The last covered day crosses the European autumn clock change.
  insertEvent.run('legacy-day', 'All day through Sunday', '2026-10-23T22:00:00.000Z', '2026-10-25T22:59:00.000Z', 1)
  insertEvent.run('already-exclusive', 'Already canonical', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z', 1)
  insertEvent.run('timed', 'Timed appointment', '2026-10-10T08:00:00.000Z', '2026-10-10T09:45:00.000Z', 0)
  if (withRecurrence) {
    db.prepare('UPDATE goals SET person_id = ?, shared = 1 WHERE id = ?').run('existing-belle', 'existing-goal')
    db.prepare('UPDATE todos SET person_id = ? WHERE id = ?').run('existing-belle', 'existing-todo')
    db.prepare('UPDATE events SET person_id = ?').run('existing-alex')
    insertEvent.run('repeat-template', 'Shared weekly event', '2026-10-01T07:00:00.000Z', '2026-10-01T08:00:00.000Z', 0)
    insertEvent.run('repeat-child', 'Shared weekly event', '2026-10-08T07:00:00.000Z', '2026-10-08T08:00:00.000Z', 0)
    db.prepare('UPDATE events SET person_id = ?, shared = 1, recurrence = ? WHERE id = ?')
      .run('existing-alex', '{"freq":"weekly","days":[4]}', 'repeat-template')
    db.prepare('UPDATE events SET person_id = ?, recur_parent = ? WHERE id = ?')
      .run('existing-alex', 'repeat-template', 'repeat-child')
  }
  db.close()
  console.log(JSON.stringify({ seeded: true }))
}

async function inspect() {
  // Verify the migration's local clock assumptions on each actual host OS.
  if (Intl.DateTimeFormat().resolvedOptions().timeZone !== process.env.TZ) {
    throw new Error('Node did not apply the requested migration fixture timezone')
  }
  const core = require('./core.cjs')
  if (process.env.DONELINE_STARTUP_METHOD === 'init') await core.initDb()
  const db = core.getDb()
  if (mode === 'new-after-migration') {
    db.prepare('INSERT INTO events (id,title,starts_at,ends_at,all_day,person_id) VALUES (?,?,?,?,?,?)')
      .run('new-exclusive', 'New midnight boundary', '2026-10-30T23:00:00.000Z', '2026-10-31T23:00:00.000Z', 1, 'existing-alex')
    // A marker must prevent the one-time shared backfill from repeating too.
    db.prepare('UPDATE events SET shared = 0 WHERE id = ?').run('repeat-child')
  }
  const result = {
    people: db.prepare('SELECT * FROM people ORDER BY position').all(),
    goals: db.prepare('SELECT * FROM goals ORDER BY id').all(),
    todos: db.prepare('SELECT * FROM todos ORDER BY id').all(),
    events: db.prepare('SELECT * FROM events ORDER BY id').all(),
    settings: db.prepare('SELECT * FROM settings ORDER BY key').all()
  }
  core.closeDb()
  console.log(JSON.stringify(result))
}

async function main() {
  if (mode === 'seed-legacy' || mode === 'seed-oldest') return seed(mode === 'seed-legacy')
  if (mode === 'concurrent-startup') {
    console.log('READY')
    await new Promise((resolve) => process.stdin.once('data', resolve))
    process.stdin.pause()
  }
  await inspect()
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
`)

function environment(directory, mode, extra = {}) {
  const database = path.join(directory, 'legacy.db')
  assert.equal(path.dirname(path.resolve(database)), path.resolve(directory))
  assert.ok(path.resolve(directory).startsWith(temporaryRoot + path.sep))
  return {
    ...process.env,
    TZ: 'Europe/Paris',
    DONELINE_DIR: path.join(directory, 'data'),
    DONELINE_DB: database,
    DONELINE_MIGRATION_MODE: mode,
    ...extra
  }
}

function parseChild(result) {
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  const lines = result.stdout.trim().split(/\r?\n/)
  return JSON.parse(lines.at(-1))
}

function run(directory, mode, extra) {
  return parseChild(spawnSync(process.execPath, [childScript], {
    env: environment(directory, mode, extra),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  }))
}

function privateDirectory(name) {
  const directory = path.join(temporaryRoot, name)
  fs.mkdirSync(directory)
  return directory
}

after(() => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temporaryRoot).startsWith('doneline-migration-test-'))
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('legacy migration preserves data and applies calendar fixes exactly once across timezone changes', () => {
  const directory = privateDirectory('legacy')
  assert.equal(run(directory, 'seed-legacy').seeded, true)
  const first = run(directory, 'inspect')
  assert.deepEqual(first.people.map(({ id, name }) => ({ id, name })), [
    { id: 'existing-alex', name: 'Alex' }, { id: 'existing-belle', name: 'Belle' }
  ])
  assert.equal(first.goals[0].id, 'existing-goal')
  assert.equal(first.goals[0].person_id, 'existing-belle')
  assert.equal(first.goals[0].shared, 1)
  assert.equal(first.todos[0].id, 'existing-todo')
  assert.equal(first.todos[0].person_id, 'existing-belle')
  assert.equal(first.todos[0].goal_id, 'existing-goal')
  assert.equal(first.todos[0].notes, 'Keep these notes')
  assert.equal(first.todos[0].completed_at, '2026-10-10T08:30:00.000Z')
  const events = new Map(first.events.map((row) => [row.id, row]))
  assert.equal(events.get('legacy-day').ends_at, '2026-10-25T23:00:00.000Z')
  assert.equal(events.get('legacy-day').starts_at, '2026-10-23T22:00:00.000Z')
  assert.equal(events.get('already-exclusive').ends_at, '2026-10-25T23:00:00.000Z')
  assert.equal(events.get('timed').ends_at, '2026-10-10T09:45:00.000Z')
  assert.equal(events.get('repeat-child').shared, 1)
  assert.equal(events.get('repeat-child').recur_parent, 'repeat-template')
  assert.equal(events.get('repeat-template').recurrence, '{"freq":"weekly","days":[4]}')
  assert.ok(first.events.every((row) => row.calendar_dirty === 0 && row.caldav_recurrence_id === null))
  assert.ok(first.settings.some((row) => row.key === 'existing-preference' && row.value === 'Keep this setting'))
  assert.equal(first.settings.filter((row) => row.key === 'migration:calendar-boundaries-v1').length, 1)

  const newData = run(directory, 'new-after-migration')
  const changedZone = run(directory, 'inspect', { TZ: 'America/New_York' })
  assert.deepEqual(changedZone, newData)
  assert.equal(changedZone.events.find((row) => row.id === 'new-exclusive').ends_at, '2026-10-31T23:00:00.000Z')
  assert.equal(changedZone.events.find((row) => row.id === 'repeat-child').shared, 0)
  assert.equal(changedZone.people.length, 2)
})

test('first-release schema backfills profile ownership without replacing existing IDs', () => {
  const directory = privateDirectory('oldest')
  run(directory, 'seed-oldest')
  const first = run(directory, 'inspect')
  assert.deepEqual(first.people.map((row) => row.id), ['existing-alex', 'existing-belle'])
  assert.equal(first.goals[0].id, 'existing-goal')
  assert.equal(first.todos[0].id, 'existing-todo')
  assert.ok([...first.goals, ...first.todos, ...first.events].every((row) => row.person_id === 'existing-alex'))
  assert.equal(first.todos[0].archived, 0)
  assert.equal(first.todos[0].recurrence, null)
  assert.equal(first.goals[0].shared, 0)
  assert.deepEqual(run(directory, 'inspect'), first)
})

test('simultaneous app and MCP startup seed exactly one pair of default profiles', { timeout: 35000 }, async () => {
  const directory = privateDirectory('simultaneous')
  function starter(method) {
    const child = spawn(process.execPath, [childScript], {
      env: environment(directory, 'concurrent-startup', { DONELINE_STARTUP_METHOD: method }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let readyResolve
    let readyReject
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const timeout = setTimeout(() => child.kill(), 30000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.includes('READY\n')) readyResolve() })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const finished = new Promise((resolve, reject) => {
      child.once('error', (error) => { clearTimeout(timeout); readyReject(error); reject(error) })
      child.once('close', (status) => {
        clearTimeout(timeout)
        if (!stdout.includes('READY\n')) readyReject(new Error(stderr || 'Child exited before startup barrier'))
        try { resolve(parseChild({ status, stdout, stderr })) } catch (error) { reject(error) }
      })
    })
    // Startup can fail before the parent has finished waiting at the barrier.
    finished.catch(() => {})
    return { child, ready, finished }
  }
  const app = starter('init')
  const mcp = starter('get')
  try {
    await Promise.all([app.ready, mcp.ready])
    app.child.stdin.end('start\n')
    mcp.child.stdin.end('start\n')
    const results = await Promise.all([app.finished, mcp.finished])
    assert.equal(results[0].people.length, 2)
    assert.equal(results[1].people.length, 2)
    assert.deepEqual(results[0].people, results[1].people)
    const persisted = run(directory, 'inspect')
    assert.deepEqual(persisted.people, results[0].people)
    assert.deepEqual(persisted.people.map((row) => row.name), ['Me', 'Friend'])
    assert.equal(persisted.settings.filter((row) => row.key === 'migration:calendar-boundaries-v1').length, 1)
  } finally {
    if (app.child.exitCode === null) app.child.kill()
    if (mcp.child.exitCode === null) mcp.child.kill()
    await Promise.allSettled([app.finished, mcp.finished])
  }
})
