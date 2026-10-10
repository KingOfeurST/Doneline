// Behavioural test of the Doneline MCP server against a throwaway database.
// Proves the two bugs that mattered: writes going to the wrong profile, and
// zone-less dates landing on the wrong day.
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const DIR = path.join(os.tmpdir(), 'doneline-mcp-test')
fs.rmSync(DIR, { recursive: true, force: true })
fs.mkdirSync(DIR, { recursive: true })

function startServer() {
  const p = spawn('node', [path.join(__dirname, '..', 'out', 'mcp', 'server.cjs')], {
    env: { ...process.env, DONELINE_DIR: DIR },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buf = ''
  const pending = new Map()
  p.stdout.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (!line.trim()) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
  })
  p.stderr.on('data', () => {})
  let id = 0
  const call = (method, params) =>
    new Promise((res) => {
      const myId = ++id
      pending.set(myId, res)
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
      setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); res({ timeout: true }) } }, 15000)
    })
  return { p, call }
}

const tool = async (call, name, args) => {
  const r = await call('tools/call', { name, arguments: args || {} })
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
  await new Promise((r) => setTimeout(r, 1500))
  const tools = (await s.call('tools/list', {}))?.result?.tools || []
  console.log(`\nTOOLS: ${tools.length}`)
  const names = tools.map((t) => t.name)
  for (const want of ['update_goal','delete_goal','update_event','delete_event','get_note','set_note','list_note_days','list_recurring','delete_recurring','list_goal_todos','rename_person','shared_focus_streak'])
    check(`tool present: ${want}`, names.includes(want))

  const people = await tool(s.call, 'list_people')
  console.log(`\nprofiles: ${people.map((p) => p.name + '=' + p.id.slice(0, 8)).join(', ')}`)
  const [first, second] = people
  s.p.kill()
  await new Promise((r) => setTimeout(r, 400))

  // ---- set "This is me" to the SECOND profile, the case that was broken ----
  fs.writeFileSync(path.join(DIR, 'prefs.json'), JSON.stringify({ selfPersonId: second.id }))
  s = startServer()
  await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } })
  await new Promise((r) => setTimeout(r, 1500))

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

  s.p.kill()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
})()
