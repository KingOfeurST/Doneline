const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { test, after } = require('node:test')
const { buildSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-cli-control-'))
for (const name of ['server', 'cli']) buildSync({ entryPoints: [path.join(root, `mcp/${name}.ts`)],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  banner: { js: `module.paths.unshift(${JSON.stringify(path.join(root, 'node_modules'))});` },
  outfile: path.join(temporary, `${name}.cjs`), logLevel: 'silent' })
let number = 0
function workspace() {
  const directory = path.join(temporary, `workspace-${++number}`)
  fs.mkdirSync(directory)
  return { directory, database: path.join(directory, 'doneline.db') }
}
function run(location, args, input, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(temporary, 'cli.cjs'), ...args], {
    env: { ...process.env, TZ: 'Europe/Paris', DONELINE_DIR: location.directory, DONELINE_DB: location.database, ...extraEnv },
    cwd: temporary, encoding: 'utf8', input, windowsHide: true, timeout: 20000 })
  if (result.error) throw result.error
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : null }
}
function call(location, tool, args = {}) {
  const result = run(location, ['call', tool, '--stdin'], JSON.stringify(args))
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(result.json.ok, true)
  return result.json
}
after(() => {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(temporary).startsWith('doneline-cli-control-'))
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('CLI file and stdin inputs preserve quotes, newlines and Unicode across fresh processes', () => {
  const location = workspace()
  const status = run(location, ['status'])
  assert.equal(status.status, 0, status.stderr)
  assert.equal(status.stderr, '', 'Protocol startup must not contaminate CLI output')
  assert.equal(status.json.data.database_path, location.database)
  const title = 'Read café notes 🌙 — "quoted" and $literal'
  const notes = "Line one\nLine two with 'quotes', `backticks`, and $(literal text)."
  const inputFile = path.join(location.directory, 'request café # with spaces.json')
  fs.writeFileSync(inputFile, '\uFEFF' + JSON.stringify({ title, notes }), 'utf8')
  const added = run(location, ['call', 'add_todo', '--input', inputFile])
  assert.equal(added.status, 0, added.stderr)
  assert.equal(added.json.data.title, title)
  assert.equal(added.json.local_receipt.saved_locally, true)
  assert.equal(call(location, 'get_todo', { id: added.json.data.id }).data.notes, notes)
  call(location, 'append_note', { day: '2026-10-13', body: 'Original café 🌙' })
  call(location, 'append_note', { day: '2026-10-13', body: 'Second line' })
  assert.equal(call(location, 'get_note', { day: '2026-10-13' }).data.body, 'Original café 🌙\nSecond line')
  const searched = run(location, ['search', 'cafe'])
  assert.equal(searched.status, 0, searched.stderr)
  assert.ok(searched.json.data.todos.some(todo => todo.id === added.json.data.id))
  assert.ok(searched.json.data.notes.some(note => note.day === '2026-10-13'))
})

test('CLI batch stops on failure and retains completed results and recoverable deletion receipts', () => {
  const location = workspace()
  const result = run(location, ['batch', '--stdin'], JSON.stringify([
    { tool: 'add_todo', args: { title: 'Saved first task' } },
    { tool: 'update_todo', args: { id: 'missing', title: 'Must fail' } },
    { tool: 'add_todo', args: { title: 'Must never run' } }
  ]))
  assert.equal(result.status, 1)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.completed, 1)
  assert.equal(result.json.results.length, 2)
  assert.equal(result.json.results[0].local_receipt.saved_locally, true)
  assert.equal(result.json.results[1].ok, false)
  const todos = call(location, 'list_todos').data
  assert.deepEqual(todos.map(todo => todo.title), ['Saved first task'])
  const removed = call(location, 'delete_todo', { id: todos[0].id }).data
  assert.equal(typeof removed.trash_id, 'string')
  call(location, 'restore_trash', { id: removed.trash_id })
  assert.equal(call(location, 'get_todo', { id: todos[0].id }).data.title, 'Saved first task')
})

test('CLI validates every batch tool name before mutations and emits useful nonzero JSON errors', () => {
  const location = workspace()
  const unknown = run(location, ['batch', '--stdin'], JSON.stringify([
    { tool: 'add_todo', args: { title: 'Must not run before typo' } },
    { tool: 'not_a_tool', args: {} }
  ]))
  assert.equal(unknown.status, 1)
  assert.equal(unknown.json, null)
  assert.match(JSON.parse(unknown.stderr).error, /Tool not found/)
  assert.deepEqual(call(location, 'list_todos').data, [])
  const invalid = run(location, ['call', 'add_todo', '--stdin'], 'not JSON')
  assert.equal(invalid.status, 1)
  assert.match(JSON.parse(invalid.stderr).error, /valid JSON/)
  const schema = run(location, ['call', 'add_todo', '--stdin'], JSON.stringify({ title: 123 }))
  assert.equal(schema.status, 1)
  assert.equal(schema.json.ok, false)
  assert.deepEqual(call(location, 'list_todos').data, [])
})

test('CLI workspace override cannot accidentally write through an inherited database path', () => {
  const first = workspace()
  const second = workspace()
  const result = run(first, ['status', '--data-dir', second.directory])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.json.data.database_path, second.database)
  assert.equal(fs.existsSync(first.database), false)
  assert.equal(fs.existsSync(second.database), true)
  const tools = run(second, ['tools', 'update_event'])
  assert.equal(tools.status, 0, tools.stderr)
  assert.deepEqual(tools.json.tools[0].inputSchema.properties.scope.enum, ['occurrence', 'future', 'series'])
  const plan = run(second, ['week', '2026-10-19'])
  assert.equal(plan.status, 0, plan.stderr)
  assert.equal(plan.json.data.days.length, 7)
  assert.equal(plan.json.data.from_day, '2026-10-19')
  assert.equal(plan.json.data.to_day, '2026-10-25')
})
