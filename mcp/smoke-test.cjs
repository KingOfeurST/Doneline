// Behavioural test of the Doneline MCP server against a throwaway database.
// Proves the two bugs that mattered: writes going to the wrong profile, and
// zone-less dates landing on the wrong day.
process.env.TZ = 'Europe/Paris'
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-mcp-test-'))
const servers = []

function startServer() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'out', 'mcp', 'server.cjs')], {
    env: { ...process.env, TZ: 'Europe/Paris', DONELINE_DIR: DIR, DONELINE_DB: path.join(DIR, 'doneline.db') },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  })
  servers.push(p)
  p.closed = new Promise((resolve) => p.once('close', resolve))
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.id && pending.has(m.id)) {
        const request = pending.get(m.id)
        clearTimeout(request.timer)
        pending.delete(m.id)
        request.resolve(m)
      }
    }
  })
  let stderr = ''
  p.stderr.on('data', (data) => { stderr += data })
  p.on('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`MCP exited before responding: ${stderr}`)) }
    pending.clear()
  })
  let id = 0
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const timer = setTimeout(() => { pending.delete(myId); reject(new Error(`MCP timeout: ${method}; ${stderr}`)) }, 15000)
      pending.set(myId, { resolve, reject, timer })
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
    })
  return { p, call }
}

const tool = async (call, name, args) => {
  const r = await call('tools/call', { name, arguments: args || {} })
  if (r.error || r.result?.isError) throw new Error(`Tool ${name} failed: ${JSON.stringify(r)}`)
  const t = r?.result?.content?.[0]?.text
  try { return JSON.parse(t) } catch { return { raw: t, err: r?.error } }
}

const localDayStr = (d) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

;(async () => {
  let pass = 0, fail = 0
  const check = (label, ok, detail) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`)
    ok ? pass++ : fail++
  }

  // ---- boot once to seed the DB, read the profiles ----
  let s = startServer()
  await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  const tools = (await s.call('tools/list', {}))?.result?.tools || []
  console.log(`\nTOOLS: ${tools.length}`)
  const names = tools.map((t) => t.name)
  for (const want of ['update_goal','delete_goal','update_event','delete_event','get_note','set_note','list_note_days','list_recurring','delete_recurring','list_goal_todos','rename_person','shared_focus_streak','remove_items_in_range'])
    check(`tool present: ${want}`, names.includes(want))

  const people = await tool(s.call, 'list_people')
  console.log(`\nprofiles: ${people.map((p) => p.name + '=' + p.id.slice(0, 8)).join(', ')}`)
  const [first, second] = people
  s.p.kill()
  await s.p.closed

  // ---- set "This is me" to the SECOND profile, the case that was broken ----
  fs.writeFileSync(path.join(DIR, 'prefs.json'), JSON.stringify({ selfPersonId: second.id }))
  s = startServer()
  await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })

  console.log('\n--- BUG 1: writes must go to the current profile, not the first one ---')
  const td = await tool(s.call, 'add_todo', { title: 'ownership probe' })
  check('add_todo files under self', td.person_id === second.id,
    `got ${td.person_id === second.id ? second.name : first.name}, self is ${second.name}`)
  const gl = await tool(s.call, 'add_goal', { title: 'ownership goal' })
  check('add_goal files under self', gl.person_id === second.id)
  const evOwn = await tool(s.call, 'add_event', { title: 'ownership event', starts_at: '2026-06-15T10:00', ends_at: '2026-06-15T11:00' })
  check('add_event files under self', evOwn.person_id === second.id)

  console.log('\n--- BUG 2: a 23:30 local time must stay on its own day ---')
  const today = localDayStr(new Date())
  const late = await tool(s.call, 'add_todo', { title: 'late night task', due_at: `${today}T23:30` })
  const storedUtc = late.due_at
  check('due_at stored as UTC ISO with Z', /Z$/.test(storedUtc || ''), storedUtc)
  const back = new Date(storedUtc)
  check('round-trips to 23:30 local', back.getHours() === 23 && back.getMinutes() === 30,
    `${back.getHours()}:${String(back.getMinutes()).padStart(2, '0')} local`)
  const todayView = await tool(s.call, 'list_today')
  check('appears in list_today, not tomorrow',
    (todayView.todos || []).some((t) => t.id === late.id),
    `${(todayView.todos || []).length} todos today`)

  console.log('\n--- all-day: a bare date means local midnight ---')
  const ad = await tool(s.call, 'add_event', { title: 'all day', starts_at: today, ends_at: today, all_day: true })
  const adStart = new Date(ad.starts_at)
  check('bare date becomes local midnight', adStart.getHours() === 0 && localDayStr(adStart) === today,
    `${ad.starts_at} -> local ${localDayStr(adStart)} ${adStart.getHours()}h`)

  console.log('\n--- notes round-trip ---')
  await tool(s.call, 'set_note', { body: 'wrote this through MCP', day: today })
  const note = await tool(s.call, 'get_note', { day: today })
  check('get_note reads back what set_note wrote', note.body === 'wrote this through MCP', JSON.stringify(note.body))
  check('note belongs to self', note.person_id === second.id)
  const days = await tool(s.call, 'list_note_days')
  check('list_note_days finds the day', Array.isArray(days) && days.includes(today), JSON.stringify(days))

  console.log('\n--- goal edit + goal detail ---')
  const g2 = await tool(s.call, 'update_goal', { id: gl.id, title: 'renamed goal' })
  check('update_goal renames', g2.title === 'renamed goal')
  await tool(s.call, 'update_todo', { id: td.id, goal_id: gl.id })
  const detail = await tool(s.call, 'list_goal_todos', { goal_id: gl.id })
  check('list_goal_todos returns open/done/templates',
    Array.isArray(detail.open) && Array.isArray(detail.done) && Array.isArray(detail.templates),
    `open=${detail.open?.length} done=${detail.done?.length}`)

  console.log('\n--- recurring rules are visible and stoppable ---')
  const rec = await tool(s.call, 'add_todo', { title: 'daily standup', repeat: 'daily' })
  const listed = await tool(s.call, 'list_recurring')
  check('list_recurring shows the new rule', (listed.todos || []).some((t) => t.id === rec.id),
    `${listed.todos?.length} todo rules, ${listed.events?.length} event rules`)
  await tool(s.call, 'delete_recurring', { id: rec.id, kind: 'todo' })
  const after = await tool(s.call, 'list_recurring')
  check('delete_recurring stops it', !(after.todos || []).some((t) => t.id === rec.id))

  console.log('\n--- event edit + delete ---')
  const ev2 = await tool(s.call, 'update_event', { id: evOwn.id, title: 'moved event', starts_at: '2026-06-16T14:00' })
  check('update_event changes title and time', ev2.title === 'moved event' && /Z$/.test(ev2.starts_at || ''), ev2.starts_at)
  const del = await tool(s.call, 'delete_event', { id: evOwn.id })
  check('delete_event reports deletion', del.deleted === evOwn.id)

  console.log('\n--- bounded Thursday repeats and reviewed range removal ---')
  const bounded = await tool(s.call, 'add_event', { title: 'Bounded Thursday', starts_at: '2026-10-01T09:00', ends_at: '2026-10-01T10:00', repeat: 'weekly', repeat_days: [4], repeat_from: '2026-10-01', repeat_until: '2026-10-22' })
  const occurrences = await tool(s.call, 'list_events', { from: '2026-09-01', to: '2026-12-01' })
  check('repeat dates materialize only four bounded Thursdays', occurrences.filter(e => e.recur_parent === bounded.id).length === 4)
  const preview = await tool(s.call, 'remove_items_in_range', { kind: 'events', from_day: '2026-10-08', to_day: '2026-10-15', title_contains: 'bounded thursday' })
  check('range preview returns two inclusive matches', preview.events?.length === 2 && preview.expected_ids?.length === 2)
  const removed = await tool(s.call, 'remove_items_in_range', { kind: 'events', from_day: '2026-10-08', to_day: '2026-10-15', title_contains: 'bounded thursday', preview: false, expected_ids: preview.expected_ids })
  check('reviewed range removal deletes only matches', removed.removed?.events === 2)
  const retained = await tool(s.call, 'list_events', { from: '2026-09-01', to: '2026-12-01' })
  check('removed recurring occurrences do not regenerate', retained.filter(e => e.recur_parent === bounded.id).length === 2)
  const remainingRule = await tool(s.call, 'list_recurring')
  check('repeat rule continues outside removed range', remainingRule.events.some(e => e.id === bounded.id))
  await tool(s.call, 'update_event', { id: bounded.id, repeat_until: '2026-10-29' })
  const changedRule = (await tool(s.call, 'list_recurring')).events.find(e => e.id === bounded.id)
  check('editing bounds preserves deleted dates', JSON.parse(changedRule.recurrence).excludedDates.includes('2026-10-08'))
  const invalid = await s.call('tools/call', { name: 'add_todo', arguments: { title: 'Impossible day', due_at: '2026-02-30T09:00' } })
  check('invalid calendar dates return a tool error', invalid.result?.isError === true)

  s.p.kill()
  await s.p.closed
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail ? 1 : 0
})().catch((error) => { console.error(error); process.exitCode = 1 }).finally(async () => {
  for (const server of servers) {
    if (server.exitCode === null && server.signalCode === null) server.kill()
    await server.closed
  }
  if (path.dirname(path.resolve(DIR)) !== path.resolve(os.tmpdir()) || !path.basename(DIR).startsWith('doneline-mcp-test-')) throw new Error('Unexpected test cleanup directory')
  fs.rmSync(DIR, { recursive: true, force: true })
})
