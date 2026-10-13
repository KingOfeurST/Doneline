const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createHash } = require('node:crypto')
const { test, after } = require('node:test')
const { buildSync } = require('esbuild')
const Database = require('libsql')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

process.env.TZ = 'Europe/Paris'
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-mcp-control-'))
const serverPath = path.join(temporary, 'server.cjs')
buildSync({ entryPoints: [path.join(root, 'mcp/server.ts')], bundle: true, platform: 'node', format: 'cjs',
  packages: 'external', banner: { js: `module.paths.unshift(${JSON.stringify(path.join(root, 'node_modules'))});` },
  outfile: serverPath, logLevel: 'silent' })
const sessions = new Set()
let caseNumber = 0

function workspace() {
  const directory = path.join(temporary, `workspace-${++caseNumber}`)
  fs.mkdirSync(directory)
  return { directory, database: path.join(directory, 'doneline.db') }
}

async function connect(location) {
  const client = new Client({ name: 'doneline-control-test', version: '1.0.0' }, { capabilities: {} })
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: root,
    env: { TZ: 'Europe/Paris', DONELINE_DIR: location.directory, DONELINE_DB: location.database }, stderr: 'pipe' })
  let stderr = ''
  transport.stderr.on('data', chunk => { stderr += chunk })
  const session = {
    client, transport,
    async raw(name, args = {}) { return client.callTool({ name, arguments: args }, undefined, { timeout: 15000 }) },
    async tool(name, args = {}, receipt = false) {
      const result = await this.raw(name, args)
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}; ${stderr}`)
      assert.equal(result.content[0]?.type, 'text', `${name} must expose interoperable text content`)
      const value = JSON.parse(result.content[0].text)
      assert.deepEqual(result.structuredContent?.result, value, `${name} structured and text outputs must agree`)
      if (receipt) assert.equal(result.structuredContent?.local_receipt?.saved_locally, true, `${name} must acknowledge a durable local write`)
      return value
    },
    async error(name, args, pattern) {
      let result
      try { result = await this.raw(name, args) } catch (error) {
        assert.match(error.message, pattern)
        return
      }
      assert.equal(result.isError, true, `${name} must flag errors, received ${JSON.stringify(result)}`)
      assert.match(result.content.map(item => item.text || '').join('\n'), pattern)
    },
    async close() {
      if (!sessions.has(this)) return
      sessions.delete(this)
      const started = Date.now()
      await client.close()
      assert.ok(Date.now() - started < 1800, `Server must close promptly on stdin EOF without the SDK's forced termination; stderr: ${stderr}`)
    }
  }
  sessions.add(session)
  await client.connect(transport)
  return session
}

after(async () => {
  await Promise.all([...sessions].map(session => session.close()))
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temporary).startsWith('doneline-mcp-control-'))
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const iso = (day, time = '09:00') => new Date(`${day}T${time}:00`).toISOString()
const dayOf = value => {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const ids = rows => rows.map(row => row.id)

test('MCP discovery exposes complete control schemas and profile changes survive a fresh process', async () => {
  const location = workspace()
  let s = await connect(location)
  const listed = await s.client.listTools()
  const tools = new Map(listed.tools.map(tool => [tool.name, tool]))
  for (const name of ['status', 'select_profile', 'search', 'plan_day', 'plan_week', 'generate_instances',
    'preview_recurrence', 'list_trash', 'restore_trash', 'create_backup', 'list_backups', 'restore_backup', 'append_note']) {
    assert.ok(tools.has(name), `Missing MCP tool ${name}`)
    assert.equal(tools.get(name).inputSchema.type, 'object')
  }
  assert.deepEqual(new Set(tools.get('update_event').inputSchema.properties.scope.enum), new Set(['occurrence', 'future', 'series']))
  const people = await s.tool('list_people')
  assert.ok(people.length >= 2)
  const profile = people[1]
  await s.tool('select_profile', { person_id: profile.id }, true)
  const task = await s.tool('add_todo', { title: 'Persistent profile task', due_at: '2026-10-14T23:30' }, true)
  assert.equal(task.person_id, profile.id)
  assert.equal(task.due_at, iso('2026-10-14', '23:30'))
  await s.close()
  s = await connect(location)
  const resumed = await s.tool('add_goal', { title: 'Persistent profile goal' }, true)
  assert.equal(resumed.person_id, profile.id)
  assert.ok((await s.tool('list_todos')).some(row => row.id === task.id && row.person_id === profile.id))
  const status = await s.tool('status')
  assert.equal(status.sync.cloud, false)
  assert.equal(status.sync.state, 'local')
  assert.equal(status.profile.id, profile.id)
  assert.equal(status.database_path, location.database)
  assert.equal(status.data_directory, location.directory)
  assert.equal(status.timezone, 'Europe/Paris')
  await s.error('select_profile', { person_id: 'missing-profile' }, /profile/i)
  await s.close()
})

test('task, goal, event, notes and accent-insensitive search retain exact values across processes', async () => {
  const location = workspace()
  let s = await connect(location)
  const [other, me] = await s.tool('list_people')
  await s.tool('select_profile', { person_id: me.id })
  const goal = await s.tool('add_goal', { title: 'Café project', color: '#123456' }, true)
  const task = await s.tool('add_todo', { title: 'Read chapter', goal_id: goal.id, notes: 'Café project details', due_at: '2026-10-14T00:15' }, true)
  assert.equal(task.due_at, iso('2026-10-14', '00:15'))
  const event = await s.tool('add_event', { title: 'Catch up', location: 'Café room', starts_at: '2026-10-14T10:00', ends_at: '2026-10-14T11:30' }, true)
  assert.equal(event.person_id, me.id)
  const updated = await s.tool('update_event', { id: event.id, starts_at: '2026-10-15T14:00', notes: 'Discuss Café project' }, true)
  assert.equal(updated.ends_at, iso('2026-10-15', '15:30'), 'Moving start alone must preserve duration')
  await s.tool('complete_todo', { id: task.id }, true)
  await s.tool('update_goal', { id: goal.id, title: 'Café renamed', archived: true }, true)
  await s.tool('set_note', { day: '2026-10-14', body: 'Café thoughts' }, true)
  await Promise.all([
    s.tool('append_note', { day: '2026-10-14', body: 'First append' }, true),
    s.tool('append_note', { day: '2026-10-14', body: 'Second append' }, true)
  ])
  const note = await s.tool('get_note', { day: '2026-10-14' })
  assert.equal(note.person_id, me.id)
  assert.equal(note.body.split('\n').length, 3)
  assert.ok(note.body.startsWith('Café thoughts\n'))
  assert.ok(note.body.includes('First append') && note.body.includes('Second append'), 'Concurrent append must not overwrite either text')
  await s.tool('set_note', { day: '2026-10-14', body: 'Café private note', person_id: other.id })
  const search = await s.tool('search', { query: 'CAFE', person_id: me.id })
  assert.deepEqual(ids(search.todos), [task.id], 'Search must include finished work')
  assert.deepEqual(ids(search.events), [event.id])
  assert.deepEqual(ids(search.goals), [goal.id], 'Search must include archived goals')
  assert.deepEqual(search.notes.map(row => row.person_id), [me.id], 'Search must respect private note profiles')
  await s.close()
  s = await connect(location)
  assert.equal((await s.tool('get_note', { day: '2026-10-14' })).body, note.body)
  const detail = await s.tool('list_goal_todos', { goal_id: goal.id })
  assert.deepEqual(ids(detail.done), [task.id])
  await s.tool('complete_todo', { id: task.id, done: false }, true)
  await s.tool('update_todo', { id: task.id, title: 'Reopened task', notes: null, due_at: null }, true)
  const reopened = (await s.tool('list_todos')).find(row => row.id === task.id)
  assert.equal(reopened.title, 'Reopened task')
  assert.equal(reopened.notes, null)
  assert.equal(reopened.due_at, null)
  await s.tool('set_note', { day: '2026-10-14', body: '' }, true)
  assert.equal((await s.tool('get_note', { day: '2026-10-14' })).body, '')
  assert.deepEqual(await s.tool('list_note_days'), [])
  await s.tool('set_note', { day: '2026-10-15', body: 'Delete the whole daily note' })
  const cleared = await s.tool('delete_note', { day: '2026-10-15' }, true)
  assert.equal(cleared.cleared, true)
  assert.equal(cleared.person_id, me.id)
  assert.equal((await s.tool('get_note', { day: '2026-10-15' })).body, '')
  await s.close()
})

test('repeat previews are read-only, range generation is bounded, and edited task occurrences do not duplicate', async () => {
  const location = workspace()
  const s = await connect(location)
  const preview = await s.tool('preview_recurrence', { anchor_day: '2026-10-01', repeat: 'weekly', repeat_days: [4], repeat_until: '2026-10-22' })
  assert.deepEqual(preview.dates, ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22'])
  assert.equal(preview.total, 4)
  assert.equal(preview.hasMore, false)
  assert.deepEqual(await s.tool('list_recurring'), { todos: [], events: [] }, 'Preview must not save a rule')
  const taskRule = await s.tool('add_todo', { title: 'Thursday reading', due_at: '2026-10-01T09:00', repeat: 'weekly', repeat_days: [4], repeat_from: '2026-10-01', repeat_until: '2026-10-22' })
  await s.tool('generate_instances', { from_day: '2026-10-01', to_day: '2026-10-22' }, true)
  const before = (await s.tool('list_todos')).filter(row => row.recur_parent === taskRule.id)
  assert.equal(before.length, 4)
  const occurrence = before.find(row => dayOf(row.due_at) === '2026-10-08')
  await s.tool('update_todo', { id: occurrence.id, title: 'Only this reading', due_at: '2026-10-09T11:00' }, true)
  await s.tool('generate_instances', { from_day: '2026-10-01', to_day: '2026-10-22' })
  const after = (await s.tool('list_todos')).filter(row => row.id === occurrence.id || row.recur_parent === taskRule.id)
  assert.equal(after.length, 4, 'Generating again must preserve the detached exception without recreating its old date')
  assert.equal(after.find(row => row.id === occurrence.id).recur_parent, null)
  const existingPreview = await s.tool('preview_recurrence', { kind: 'todo', id: taskRule.id })
  assert.deepEqual(existingPreview.dates, ['2026-10-01', '2026-10-15', '2026-10-22'])
  await s.error('generate_instances', { from_day: '2026-01-01', to_day: '2027-01-02' }, /range|366|year/i)
  assert.deepEqual(ids(await s.tool('list_todos')), ids(after), 'Invalid generation must leave the database unchanged')
  await s.error('generate_instances', { from_day: '2026-10-22', to_day: '2026-10-01' }, /range|end|after/i)
  await s.error('preview_recurrence', { anchor_day: '2026-10-01', repeat: 'weekly', repeat_days: [] }, /weekday/i)
  await s.error('preview_recurrence', { anchor_day: '2026-10-01', repeat: 'daily', repeat_until: '2026-09-01' }, /end|start/i)
  await s.close()
})

test('day and week plans include bounded occurrences, per-profile shared completion and open backlog', async () => {
  const location = workspace()
  const s = await connect(location)
  const [other, me] = await s.tool('list_people')
  await s.tool('select_profile', { person_id: me.id })
  const overdue = await s.tool('add_todo', { title: 'Overdue', due_at: '2026-10-12T23:55' })
  const undated = await s.tool('add_todo', { title: 'No date' })
  const today = await s.tool('add_todo', { title: 'Midnight', due_at: '2026-10-14T00:15' })
  const upcoming = await s.tool('add_todo', { title: 'Next day', due_at: '2026-10-15T09:00' })
  await s.tool('add_todo', { title: 'Private other task', person_id: other.id, due_at: '2026-10-14T09:00' })
  const sharedGoal = await s.tool('add_goal', { title: 'Shared plan goal', person_id: other.id, shared: true })
  const shared = await s.tool('add_todo', { title: 'My part done', person_id: other.id, goal_id: sharedGoal.id, due_at: '2026-10-14T09:00' })
  const partiallyDone = await s.tool('complete_todo', { id: shared.id })
  assert.equal(partiallyDone.completed_at, null, 'Shared work stays open until everyone completes it')
  const spanning = await s.tool('add_event', { title: 'Overnight', starts_at: '2026-10-14T23:00', ends_at: '2026-10-15T02:00' })
  const rule = await s.tool('add_todo', { title: 'Planning repeat', due_at: '2028-02-14T09:00', repeat: 'daily', repeat_from: '2028-02-14', repeat_until: '2028-02-20' })
  const pure = await s.tool('plan_week', { from_day: '2028-02-14', generate_instances: false })
  assert.equal(pure.days.length, 7)
  assert.equal(pure.from_day, '2028-02-14')
  assert.equal(pure.to_day, '2028-02-20')
  assert.ok(pure.days.every(day => !day.todos.some(row => row.recur_parent === rule.id)), 'A pure planning read must not generate recurring tasks')
  const generated = await s.tool('plan_week', { from_day: '2028-02-14' })
  assert.equal(generated.generated.todos, 7)
  assert.ok(generated.days.every(day => day.todos.filter(row => row.recur_parent === rule.id).length === 1))
  const day = await s.tool('plan_day', { day: '2026-10-14', generate_instances: false })
  assert.equal(day.person_id, me.id)
  assert.deepEqual(new Set(ids(day.todos)), new Set([today.id, shared.id]))
  assert.deepEqual(ids(day.events), [spanning.id])
  assert.deepEqual(ids(day.backlog.overdue), [overdue.id])
  assert.deepEqual(ids(day.backlog.undated), [undated.id])
  assert.equal(day.counts.open_todos, 1)
  assert.equal(day.counts.completed_todos, 1, 'Planning must recognize the active profile completed its share')
  assert.ok(day.goals.some(row => row.id === sharedGoal.id))
  const week = await s.tool('plan_week', { from_day: '2026-10-14', generate_instances: false })
  assert.equal(week.days.length, 7)
  assert.equal(week.to_day, '2026-10-20')
  assert.ok(week.days[1].todos.some(row => row.id === upcoming.id))
  assert.ok(week.days[1].events.some(row => row.id === spanning.id), 'Multi-day events overlap each relevant day')
  assert.equal(week.counts.events, 1, 'Week totals count distinct events once')
  const all = await s.tool('plan_day', { day: '2026-10-14', person_id: 'all', generate_instances: false })
  assert.equal(all.todos.length, 3)
  await s.error('plan_day', { day: '2026-02-30' }, /date/i)
  await s.error('plan_week', { from_day: '2026-10-14', person_id: 'missing' }, /profile/i)
  await s.close()
})

test('future event edits preserve earlier history and delete receipts restore recurring dates after restart', async () => {
  const location = workspace()
  let s = await connect(location)
  const rule = await s.tool('add_event', { title: 'Thursday session', starts_at: '2026-10-01T09:00', ends_at: '2026-10-01T10:00', repeat: 'weekly', repeat_days: [4], repeat_from: '2026-10-01', repeat_until: '2026-10-22' })
  const range = { from: '2026-10-01', to: '2026-10-23' }
  const before = (await s.tool('list_events', range)).filter(row => row.recur_parent === rule.id)
  assert.equal(before.length, 4)
  const first = before.find(row => dayOf(row.starts_at) === '2026-10-01')
  const second = before.find(row => dayOf(row.starts_at) === '2026-10-08')
  const replacement = await s.tool('update_event', { id: second.id, scope: 'future', title: 'Later session', starts_at: '2026-10-08T11:00' }, true)
  const after = await s.tool('list_events', range)
  const historical = after.find(row => row.id === first.id)
  assert.equal(historical.title, 'Thursday session')
  assert.equal(historical.starts_at, first.starts_at)
  assert.equal(historical.recur_parent, rule.id)
  const future = after.filter(row => row.recur_parent === replacement.id)
  assert.equal(future.length, 3)
  assert.ok(future.every(row => row.title === 'Later session' && new Date(row.starts_at).getHours() === 11))
  assert.ok(future.every(row => new Date(row.ends_at) - new Date(row.starts_at) === 3600000))
  const selected = future.find(row => dayOf(row.starts_at) === '2026-10-15')
  const deleted = await s.tool('delete_event', { id: selected.id }, true)
  assert.equal(deleted.deleted, selected.id)
  assert.ok(deleted.trash_id)
  const trash = await s.tool('list_trash')
  assert.ok(trash.some(row => row.id === deleted.trash_id && row.item_id === selected.id && row.kind === 'event'))
  await s.close()
  s = await connect(location)
  assert.ok(!(await s.tool('list_events', range)).some(row => row.id === selected.id), 'Deleted occurrence must remain excluded in a fresh process')
  const restored = await s.tool('restore_trash', { id: deleted.trash_id }, true)
  assert.ok(restored.itemIds.includes(selected.id))
  assert.equal((await s.tool('list_events', range)).filter(row => row.recur_parent === replacement.id).length, 3)
  assert.ok(!(await s.tool('list_trash')).some(row => row.id === deleted.trash_id))
  await s.error('restore_trash', { id: deleted.trash_id }, /trash|longer/i)
  const task = await s.tool('add_todo', { title: 'Undo this task' })
  const taskDeleted = await s.tool('delete_todo', { id: task.id }, true)
  assert.equal(taskDeleted.deleted, task.id)
  assert.ok(taskDeleted.trash_id)
  await s.tool('restore_trash', { id: taskDeleted.trash_id }, true)
  assert.ok((await s.tool('list_todos')).some(row => row.id === task.id))
  await s.error('delete_todo', { id: 'missing-task' }, /not found/i)
  await s.error('delete_event', { id: 'missing-event' }, /not found/i)
  await s.close()
})

test('backup restore is atomic, creates a safety copy, and refuses invalid requests without changing work', async () => {
  const location = workspace()
  let s = await connect(location)
  const goal = await s.tool('add_goal', { title: 'Backup goal' })
  const task = await s.tool('add_todo', { title: 'Before backup', goal_id: goal.id })
  await s.tool('set_note', { day: '2026-10-14', body: 'Before backup note' })
  const backup = await s.tool('create_backup', {}, true)
  assert.equal(backup.reason, 'manual')
  assert.ok(backup.sizeBytes > 0)
  assert.ok((await s.tool('list_backups')).some(row => row.id === backup.id))
  await s.tool('update_todo', { id: task.id, title: 'After backup' })
  await s.tool('set_note', { day: '2026-10-14', body: 'After backup note' })
  await s.error('restore_backup', { id: backup.id, confirm_restore: false }, /confirm|true|restore/i)
  await s.error('restore_backup', { id: '../outside', confirm_restore: true }, /backup/i)
  assert.equal((await s.tool('list_todos')).find(row => row.id === task.id).title, 'After backup')
  const restored = await s.tool('restore_backup', { id: backup.id, confirm_restore: true }, true)
  assert.equal(restored.safetyBackup.reason, 'before-restore')
  assert.ok(restored.safetyBackup.id !== backup.id)
  await s.close()
  s = await connect(location)
  assert.equal((await s.tool('list_todos')).find(row => row.id === task.id).title, 'Before backup')
  assert.equal((await s.tool('get_note', { day: '2026-10-14' })).body, 'Before backup note')
  assert.ok((await s.tool('list_goals')).some(row => row.id === goal.id))
  assert.ok((await s.tool('list_backups')).some(row => row.id === restored.safetyBackup.id))
  await s.close()
})

test('goal and profile deletion previews identify cascades and preserve a restorable safety backup', async () => {
  const location = workspace()
  const s = await connect(location)
  const person = await s.tool('add_person', { name: 'Temporary profile', emoji: '🧪', color: '#456789' }, true)
  await s.tool('select_profile', { person_id: person.id })
  const goal = await s.tool('add_goal', { title: 'Goal cascade' })
  const task = await s.tool('add_todo', { title: 'Linked work', goal_id: goal.id })
  const deleted = await s.tool('delete_goal', { id: goal.id }, true)
  assert.equal(deleted.deleted, goal.id)
  assert.equal(deleted.safetyBackup.reason, 'manual')
  assert.ok(!(await s.tool('list_todos')).some(row => row.id === task.id))
  assert.ok(!(await s.tool('list_goals')).some(row => row.id === goal.id))
  await s.tool('restore_backup', { id: deleted.safetyBackup.id, confirm_restore: true })
  assert.ok((await s.tool('list_todos')).some(row => row.id === task.id && row.goal_id === goal.id))
  const preview = await s.tool('delete_person', { id: person.id })
  assert.equal(preview.preview, true)
  assert.ok((await s.tool('list_people')).some(row => row.id === person.id), 'Default profile delete must only preview')
  const removed = await s.tool('delete_person', { id: person.id, confirm_delete: true }, true)
  assert.equal(removed.deleted, person.id)
  assert.ok(removed.safetyBackup.id)
  assert.ok(!(await s.tool('list_people')).some(row => row.id === person.id))
  await s.tool('restore_backup', { id: removed.safetyBackup.id, confirm_restore: true })
  assert.ok((await s.tool('list_people')).some(row => row.id === person.id))
  assert.ok((await s.tool('list_todos')).some(row => row.id === task.id))
  await s.close()
})

test('a held remote snapshot cannot block local writes or EOF shutdown, and pending writes sync after restart', async t => {
  const location = workspace()
  let s = await connect(location)
  const people = await s.tool('list_people')
  await s.close()
  const remotePath = path.join(location.directory, 'fixture-remote.db')
  const copySnapshot = destination => {
    const source = new Database(location.database)
    try { source.prepare('VACUUM INTO ?').run(destination) } finally { source.close() }
  }
  copySnapshot(remotePath)
  const remote = new Database(remotePath)
  let reachedSnapshot
  const held = new Promise(resolve => { reachedSnapshot = resolve })
  let holdSnapshot = true
  const fixture = http.createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      assert.equal(request.url, '/v2/pipeline')
      assert.equal(request.headers.authorization, 'Bearer isolated-fixture-token')
      const payload = JSON.parse(body)
      const results = [], errors = [], success = []
      let snapshot = false
      const accepts = condition => !condition || (condition.type === 'ok' ? success[condition.step] === true : !accepts(condition.cond))
      for (const step of payload.requests[0].batch.steps) {
        if (!accepts(step.condition)) { results.push(null); errors.push(null); success.push(false); continue }
        try {
          const statement = remote.prepare(step.stmt.sql)
          const values = step.stmt.args.map(value => value.type === 'null' ? null : ['integer', 'float'].includes(value.type) ? Number(value.value) : value.value)
          const rows = statement.reader ? statement.all(...values) : (statement.run(...values), [])
          const columns = statement.reader ? statement.columns().map(column => ({ name: column.name })) : []
          results.push({ cols: columns, rows: rows.map(row => columns.map(column => {
            const value = row[column.name]
            return value === null ? { type: 'null' } : typeof value === 'number' ? { type: 'integer', value: String(value) } : { type: 'text', value }
          })), affected_row_count: 0, last_insert_rowid: null })
          errors.push(null); success.push(true)
          snapshot ||= /^SELECT \* FROM "people"/.test(step.stmt.sql)
        } catch (error) { results.push(null); errors.push({ message: error.message }); success.push(false) }
      }
      if (holdSnapshot && snapshot) { reachedSnapshot(); return }
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ baton: null, base_url: null, results: [
        { type: 'ok', response: { type: 'batch', result: { step_results: results, step_errors: errors } } },
        { type: 'ok', response: { type: 'close' } }
      ] }))
    } catch (error) { response.writeHead(500); response.end(error.message) }
  })
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    try { if (s) await s.close() } finally {
      fixture.closeAllConnections()
      await new Promise(resolve => fixture.close(resolve))
      remote.close()
    }
  })
  const syncUrl = `http://127.0.0.1:${fixture.address().port}`
  const hash = createHash('sha256').update(syncUrl.toLowerCase()).digest('hex').slice(0, 20)
  const cloudDatabase = path.join(location.directory, `doneline-workspace-${hash}.db`)
  copySnapshot(cloudDatabase)
  fs.writeFileSync(path.join(location.directory, 'config.json'), JSON.stringify({ syncUrl, authToken: 'isolated-fixture-token' }))
  s = await connect(location)
  const heldTimeout = setTimeout(() => reachedSnapshot('timeout'), 10000)
  assert.notEqual(await held, 'timeout', 'Fixture must hold an actual remote snapshot')
  clearTimeout(heldTimeout)
  const writtenAt = Date.now()
  const task = await s.tool('add_todo', { title: 'Durable while snapshot held', person_id: people[1].id }, true)
  assert.ok(Date.now() - writtenAt < 1800, 'Local write must acknowledge before the held network request times out')
  const status = await s.tool('status')
  assert.equal(status.sync.cloud, true)
  assert.equal(status.sync.state, 'syncing')
  assert.ok(status.sync.pending >= 1)
  assert.ok(!JSON.stringify(status).includes('isolated-fixture-token'), 'Status must not expose workspace credentials')
  await s.close()
  const independent = new Database(cloudDatabase)
  try {
    assert.equal(independent.prepare('SELECT title FROM todos WHERE id=?').get(task.id).title, task.title)
    assert.ok(independent.prepare('SELECT COUNT(*) AS n FROM __sync_outbox').get().n >= 1)
    assert.equal(independent.prepare("SELECT value FROM __sync_meta WHERE key='lease'").get(), undefined, 'EOF shutdown must release this process’s sync lease')
  } finally { independent.close() }
  holdSnapshot = false
  s = await connect(location)
  const synchronized = await s.tool('sync_workspace')
  assert.equal(synchronized.synced, true)
  assert.equal(synchronized.sync.pending, 0)
  assert.equal(remote.prepare('SELECT title FROM todos WHERE id=?').get(task.id).title, task.title)
  assert.ok((await s.tool('list_todos')).some(row => row.id === task.id))
  await s.close()
})

test('invalid tool inputs return protocol errors without persisting partial items', async () => {
  const location = workspace()
  const s = await connect(location)
  const invalid = [
    ['add_todo', { title: ' ', due_at: '2026-10-14' }, /title|empty|blank/i],
    ['add_todo', { title: 'Impossible day', due_at: '2026-02-30T09:00' }, /invalid|date/i],
    ['add_todo', { title: 'Unknown owner', person_id: 'missing' }, /profile/i],
    ['add_todo', { title: 'Unknown goal', goal_id: 'missing' }, /goal/i],
    ['add_todo', { title: 'Missing repeat', repeat_days: [4] }, /repeat|daily|weekly/i],
    ['add_event', { title: 'Negative event', starts_at: '2026-10-14T11:00', ends_at: '2026-10-14T10:00' }, /end|after/i],
    ['set_note', { day: '2026-02-30', body: 'bad day' }, /date/i],
    ['append_note', { day: '2026-10-14', person_id: 'missing', body: 'bad person' }, /profile/i],
    ['list_note_days', { limit: -1 }, /limit|number|greater/i],
    ['search', { query: 'x', limit: 51 }, /50|limit|less/i],
    ['search', { query: 'x'.repeat(201) }, /200|long|character/i],
    ['update_event', { id: 'missing', scope: 'unknown' }, /scope|enum|invalid/i]
  ]
  for (const [name, args, pattern] of invalid) await s.error(name, args, pattern)
  assert.deepEqual(await s.tool('list_todos'), [])
  assert.deepEqual(await s.tool('list_events'), [])
  assert.deepEqual(await s.tool('list_note_days'), [])
  await s.close()
})
