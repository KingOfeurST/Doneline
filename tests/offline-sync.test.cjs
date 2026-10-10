const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { test, after } = require('node:test')
const { spawn } = require('node:child_process')
const { buildSync } = require('esbuild')
const Database = require('libsql')

const workspace = path.resolve(__dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-offline-sync-'))
process.env.DONELINE_DIR = path.join(temporary, 'local')
const compiled = path.join(temporary, 'core.cjs')
const syncCompiled = path.join(temporary, 'sync.cjs')
for (const [entry, outfile] of [['core/index.ts', compiled], ['core/offlineSync.ts', syncCompiled]]) {
  buildSync({ entryPoints: [path.join(workspace, entry)], bundle: true, platform: 'node', format: 'cjs', external: ['libsql'],
    banner: { js: `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});` }, outfile, logLevel: 'silent' })
}
const core = require(compiled)
const sync = require(syncCompiled)
const local = core.getDb()
const remote = new Database(path.join(temporary, 'remote.db'))
let activeRemote = remote
remote.pragma('foreign_keys=ON')
let loseNextAcknowledgement = false
let holdNextSnapshot = null
let requests = 0
let unavailable = false
let largestWriteBatch = 0
let writeBatches = 0
let loseWriteBatch = 0
function condition(cond, success) {
  if (!cond) return true
  if (cond.type === 'ok') return success[cond.step] === true
  if (cond.type === 'not') return !condition(cond.cond, success)
  throw new Error('Unsupported fixture condition')
}
const server = http.createServer(async (req, res) => {
  requests++
  let body = ''
  for await (const chunk of req) body += chunk
  if (unavailable) { res.writeHead(503); res.end('Offline fixture'); return }
  const payload = JSON.parse(body)
  assert.equal(req.url, '/v2/pipeline')
  assert.equal(req.headers.authorization, 'Bearer fixture-token')
  const request = payload.requests[0]
  assert.equal(request.type, 'batch')
  const results = [], errors = [], success = []
  let writes = false, snapshot = false
  for (let i = 0; i < request.batch.steps.length; i++) {
    const step = request.batch.steps[i]
    if (!condition(step.condition, success)) { results.push(null); errors.push(null); success.push(false); continue }
    try {
      const stmt = activeRemote.prepare(step.stmt.sql)
      const args = step.stmt.args.map((v) => v.type === 'null' ? null : v.type === 'integer' || v.type === 'float' ? Number(v.value) : v.value)
      const rows = stmt.reader ? stmt.all(...args) : (stmt.run(...args), [])
      const cols = stmt.reader ? stmt.columns().map((c) => ({ name: c.name })) : []
      results.push({ cols, rows: rows.map((row) => cols.map((c) => {
        const value = row[c.name]
        return value === null ? { type: 'null' } : typeof value === 'number' ? { type: 'integer', value: String(value) } : { type: 'text', value }
      })), affected_row_count: 0, last_insert_rowid: null })
      errors.push(null); success.push(true)
      writes ||= /INSERT.*doneline_sync_operations\(id\)/.test(step.stmt.sql)
      snapshot ||= /^SELECT \* FROM "people"/.test(step.stmt.sql)
    } catch (error) { results.push(null); errors.push({ message: error.message }); success.push(false) }
  }
  if (writes) { writeBatches++; largestWriteBatch=Math.max(largestWriteBatch,request.batch.steps.length) }
  if ((loseNextAcknowledgement && writes) || (writes && writeBatches===loseWriteBatch)) { loseNextAcknowledgement = false; loseWriteBatch=0; res.destroy(); return }
  if (holdNextSnapshot && snapshot) { const wait = holdNextSnapshot; holdNextSnapshot = null; await wait() }
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify({ baton: null, base_url: null, results: [{ type: 'ok', response: { type: 'batch', result: { step_results: results, step_errors: errors } } }, { type: 'ok', response: { type: 'close' } }] }))
})
const ready = new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const cfg = async () => { await ready; return { syncUrl: `http://127.0.0.1:${server.address().port}`, authToken: 'fixture-token' } }
sync.installSyncJournal(local)
for (const person of core.listPeople()) local.prepare('UPDATE people SET name=name WHERE id=?').run(person.id)
const owner = core.listPeople()[0].id
function runChild(name, script, directory, extra = {}) {
  const file=path.join(temporary,`${name}.cjs`)
  fs.writeFileSync(file,script)
  const env={...process.env,DONELINE_DIR:directory,...extra}
  delete env.DONELINE_DB
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[file],{cwd:temporary,env,windowsHide:true})
    let stdout='',stderr=''
    child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value)
    child.on('error',reject)
    child.on('exit',code=>{try{code===0?resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))):reject(Error(stderr))}catch(error){reject(error)}})
  })
}

after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); core.closeDb(); remote.close() })

test('offline task and note mutations commit locally with a durable journal; retry sends them', async () => {
  const configuration = await cfg()
  await sync.syncOfflineWorkspace(local, configuration)
  const task = core.createTodo({ title: 'Saved offline', person_id: owner })
  core.setDailyNote('2026-10-10', 'Offline note survives ✓', owner)
  const started = Date.now()
  await assert.rejects(sync.syncOfflineWorkspace(local, { ...configuration, syncUrl: 'http://127.0.0.1:1' }))
  assert.ok(Date.now() - started < 2000)
  assert.equal(core.getDailyNote('2026-10-10', owner).body, 'Offline note survives ✓')
  assert.ok(sync.pendingSyncChanges(local) >= 2)
  const independent = new Database(core.dbPath())
  assert.equal(independent.prepare('SELECT title FROM todos WHERE id=?').get(task.id).title, 'Saved offline')
  independent.close()
  await sync.syncOfflineWorkspace(local, configuration)
  assert.equal(remote.prepare('SELECT body FROM daily_notes WHERE day=? AND person_id=?').get('2026-10-10', owner).body, 'Offline note survives ✓')
  assert.equal(sync.pendingSyncChanges(local), 0)
})

test('a lost server acknowledgement retries idempotently and preserves a newer remote edit', async () => {
  const configuration = await cfg()
  const task = core.createTodo({ title: 'First version', person_id: owner })
  loseNextAcknowledgement = true
  await assert.rejects(sync.syncOfflineWorkspace(local, configuration))
  assert.equal(remote.prepare('SELECT title FROM todos WHERE id=?').get(task.id).title, 'First version')
  remote.prepare('UPDATE todos SET title=? WHERE id=?').run('Other device updated it', task.id)
  await sync.syncOfflineWorkspace(local, configuration)
  assert.equal(core.listTodos().find((t) => t.id === task.id).title, 'Other device updated it')
  assert.equal(sync.pendingSyncChanges(local), 0)
})

test('typing while a snapshot downloads keeps the latest local note and syncs it next', async () => {
  const configuration = await cfg()
  let reached, release
  const atSnapshot = new Promise((resolve) => { reached = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  holdNextSnapshot = () => { reached(); return wait }
  const running = sync.syncOfflineWorkspace(local, configuration)
  await atSnapshot
  core.setDailyNote('2026-10-10', 'Typed during sync', owner)
  release(); await running
  assert.equal(core.getDailyNote('2026-10-10', owner).body, 'Typed during sync')
  assert.ok(sync.pendingSyncChanges(local) > 0)
  await sync.syncOfflineWorkspace(local, configuration)
  assert.equal(remote.prepare('SELECT body FROM daily_notes WHERE day=? AND person_id=?').get('2026-10-10', owner).body, 'Typed during sync')
})

test('failed remote batch rolls back all mutations and leaves local retry data intact', async () => {
  const configuration = await cfg()
  await assert.rejects(sync.remoteTransaction(configuration, [{ sql: "INSERT INTO settings VALUES ('rollback-proof','yes')" }, { sql: 'INSERT INTO nonexistent_table VALUES (1)' }]))
  assert.equal(remote.prepare("SELECT * FROM settings WHERE key='rollback-proof'").get(), undefined)
  assert.equal(remote.inTransaction, false)
  const before = requests
  local.prepare("INSERT INTO trash_items VALUES ('private-trash','task','item',?,'Private trash',?,'{}')").run(owner, new Date().toISOString())
  assert.equal(sync.pendingSyncChanges(local), 0)
  await sync.syncOfflineWorkspace(local, configuration)
  assert.ok(requests > before)
  assert.equal(remote.prepare("SELECT name FROM sqlite_master WHERE name='trash_items'").get(), undefined)
})

test('configured cloud workspace reopens offline and acknowledges notes without network delay', async () => {
  const configuration = await cfg()
  const child = path.join(temporary, 'child.cjs')
  fs.writeFileSync(child, `module.paths.unshift(${JSON.stringify(path.join(workspace, 'node_modules'))});\n` + String.raw`
const core=require('./core.cjs');
(async()=>{
  if(process.env.PHASE==='online')core.setSyncConfig({syncUrl:process.env.WORKSPACE_URL,authToken:'fixture-token'});
  const started=Date.now();await core.initDb();
  const person=core.listPeople()[0];const note=core.setDailyNote('2026-10-12',process.env.PHASE,person.id);
  console.log(JSON.stringify({elapsed:Date.now()-started,body:note.body,status:require('./core.cjs').isCloud()}));
  core.closeDb();
})().catch(e=>{console.error(e);process.exitCode=1});`)
  const run = (phase) => new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, [child], { cwd: temporary, env: { ...process.env, DONELINE_DIR: path.join(temporary, 'configured'), PHASE: phase, WORKSPACE_URL: configuration.syncUrl }, windowsHide: true })
    let stdout='', stderr='';process_.stdout.on('data',d=>stdout+=d);process_.stderr.on('data',d=>stderr+=d)
    process_.on('error',reject);process_.on('exit',code=>code===0?resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))):reject(new Error(stderr)))
  })
  assert.equal((await run('online')).body, 'online')
  // Keep the fixture listening but reject cloud access: cache reads/writes must
  // still finish without waiting for even the first background HTTP response.
  unavailable = true
  let result
  try { result = await run('offline') } finally { unavailable = false }
  assert.equal(result.body, 'offline');assert.equal(result.status,true);assert.ok(result.elapsed < 2000)
})

test('concurrent reactions reconcile by author/emoji, including a pending deletion during pull', async () => {
  const configuration = await cfg()
  const task = core.createTodo({ title: 'Reaction race', person_id: owner })
  await sync.syncOfflineWorkspace(local, configuration)
  remote.prepare('INSERT INTO reactions(id,todo_id,person_id,emoji) VALUES (?,?,?,?)').run('other-device-reaction',task.id,owner,'👏')
  core.toggleReaction(task.id,owner,'👏')
  await sync.syncOfflineWorkspace(local, configuration)
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM reactions WHERE todo_id=?').get(task.id).n,1)
  assert.equal(core.listReactionsForTodo(task.id).length,1)
  assert.equal(core.listReactionsForTodo(task.id)[0].id,remote.prepare('SELECT id FROM reactions WHERE todo_id=?').get(task.id).id)
  let reached, release
  const atSnapshot=new Promise(resolve=>{reached=resolve})
  const held=new Promise(resolve=>{release=resolve})
  holdNextSnapshot=()=>{reached();return held}
  const running=sync.syncOfflineWorkspace(local,configuration)
  await atSnapshot
  core.toggleReaction(task.id,owner,'👏')
  release();await running
  assert.equal(core.listReactionsForTodo(task.id).length,0,'an older snapshot must not resurrect my reaction')
  assert.ok(sync.pendingSyncChanges(local)>0)
  await sync.syncOfflineWorkspace(local,configuration)
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM reactions WHERE todo_id=?').get(task.id).n,0)
})

test('a new edit recovers a remotely deleted parent without overwriting existing parents or retrying acknowledged recovery', async () => {
  const configuration=await cfg()
  const goal=core.createGoal({title:'Recover this goal',person_id:owner})
  const task=core.createTodo({title:'Recover this task',goal_id:goal.id,person_id:owner})
  await sync.syncOfflineWorkspace(local,configuration)
  remote.prepare('DELETE FROM goals WHERE id=?').run(goal.id)
  core.updateTodo(task.id,{title:'New local edit'})
  await sync.syncOfflineWorkspace(local,configuration)
  assert.equal(remote.prepare('SELECT title FROM goals WHERE id=?').get(goal.id).title,'Recover this goal')
  assert.equal(remote.prepare('SELECT goal_id FROM todos WHERE id=?').get(task.id).goal_id,goal.id)
  remote.prepare('UPDATE goals SET title=? WHERE id=?').run('Another device renamed it',goal.id)
  core.updateTodo(task.id,{title:'Second local edit'})
  await sync.syncOfflineWorkspace(local,configuration)
  assert.equal(core.getGoal(goal.id).title,'Another device renamed it','parent recovery must never clobber a live parent')
  core.updateTodo(task.id,{title:'Acknowledgement lost'})
  loseNextAcknowledgement=true
  await assert.rejects(sync.syncOfflineWorkspace(local,configuration))
  remote.prepare('DELETE FROM todos WHERE id=?').run(task.id)
  remote.prepare('DELETE FROM goals WHERE id=?').run(goal.id)
  await sync.syncOfflineWorkspace(local,configuration)
  assert.equal(remote.prepare('SELECT id FROM goals WHERE id=?').get(goal.id),undefined,'acknowledged parent recovery cannot resurrect a later deletion')
  assert.equal(core.getTodo(task.id),undefined)
})

test('large queues use bounded batches and retry a lost later acknowledgement without undoing a newer cloud edit', async () => {
  const configuration=await cfg()
  const tasks=Array.from({length:235},(_,index)=>core.createTodo({title:`Batch task ${index}`,person_id:owner}))
  const firstBatch=writeBatches
  largestWriteBatch=0
  loseWriteBatch=firstBatch+2
  await assert.rejects(sync.syncOfflineWorkspace(local,configuration))
  assert.ok(sync.pendingSyncChanges(local)>0)
  assert.ok(sync.pendingSyncChanges(local)<235,'successfully acknowledged earlier batch leaves no stale retry entries')
  assert.ok(largestWriteBatch<=303,`write packet was unexpectedly large: ${largestWriteBatch}`)
  remote.prepare('UPDATE todos SET title=? WHERE id=?').run('Cloud edit after lost batch receipt',tasks[150].id)
  await sync.syncOfflineWorkspace(local,configuration)
  assert.equal(sync.pendingSyncChanges(local),0)
  assert.equal(core.getTodo(tasks[150].id).title,'Cloud edit after lost batch receipt')
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM todos WHERE title LIKE ?').get('Batch task %').n,234)
})

test('lease ownership is verified after a delayed snapshot before any local replacement', async () => {
  const configuration=await cfg()
  let reached,release,owned=true
  const atSnapshot=new Promise(resolve=>{reached=resolve})
  const held=new Promise(resolve=>{release=resolve})
  holdNextSnapshot=()=>{reached();return held}
  const before=core.getDailyNote('2026-10-10',owner).body
  const running=sync.syncOfflineWorkspace(local,configuration,()=>{if(!owned)throw Error('Lease was stolen')})
  await atSnapshot
  owned=false
  release()
  await assert.rejects(running,/Lease was stolen/)
  assert.equal(core.getDailyNote('2026-10-10',owner).body,before)
})

test('an open database keeps its original workspace URL/path across a pending configuration transition', async () => {
  const configuration=await cfg()
  const result=await runChild('boundary',String.raw`
const core=require('./core.cjs');
(async()=>{
  core.setSyncConfig({syncUrl:process.env.WORKSPACE_URL,authToken:'fixture-token'});
  await core.initDb();const original=core.activeDbPath();
  core.setSyncConfig({syncUrl:'http://127.0.0.1:1',authToken:'other-workspace'});
  const whileOpen=core.activeDbPath();const person=core.listPeople()[0];
  core.setDailyNote('2026-10-15','Original workspace only',person.id);
  await core.cloudSync();const backup=core.createBackup();
  core.closeDb();console.log(JSON.stringify({original,whileOpen,afterClose:core.activeDbPath(),backup,owner:person.id}));
})().catch(error=>{console.error(error);process.exitCode=1});`,path.join(temporary,'boundary'),{WORKSPACE_URL:configuration.syncUrl})
  assert.equal(result.whileOpen,result.original)
  assert.notEqual(result.afterClose,result.original)
  assert.equal(remote.prepare('SELECT body FROM daily_notes WHERE day=? AND person_id=?').get('2026-10-15',result.owner).body,'Original workspace only')
  const expectedFolder=require('node:crypto').createHash('sha256').update(path.resolve(result.original)).digest('hex').slice(0,20)
  assert.ok(fs.existsSync(path.join(temporary,'boundary','backups',expectedFolder,result.backup.id+'.doneline-backup.json')))
})

test('legacy replica imports committed WAL notes atomically and preserves its source; a different workspace never imports it again', async () => {
  // The read-only file URI must encode filesystem names rather than treating
  // spaces or a literal # as URL syntax.
  const directory=path.join(temporary,'legacy # with spaces')
  fs.mkdirSync(directory,{recursive:true})
  const sourceFile=path.join(directory,'doneline-replica.db')
  const source=new Database(sourceFile)
  source.pragma('journal_mode=WAL')
  source.exec(`CREATE TABLE people(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT '#2f7a4d',emoji TEXT NOT NULL DEFAULT '🙂',position INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE daily_notes(day TEXT NOT NULL,person_id TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(day,person_id));`)
  source.prepare('INSERT INTO people(id,name) VALUES (?,?)').run('legacy-owner','Legacy owner')
  source.prepare('INSERT INTO daily_notes(day,person_id,body) VALUES (?,?,?)').run('2026-10-10','legacy-owner','Committed in the legacy WAL')
  const hash=file=>require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const before={database:hash(sourceFile),wal:hash(sourceFile+'-wal')}
  try {
    const script=String.raw`
const core=require('./core.cjs');
(async()=>{core.setSyncConfig({syncUrl:process.env.WORKSPACE_URL,authToken:'offline'});let failure='';try{await core.initDb()}catch(error){failure=error.message}const people=core.listPeople();const note=core.getDailyNote('2026-10-10','legacy-owner');const opened=core.activeDbPath();core.closeDb();console.log(JSON.stringify({people,note,opened,failure}));})().catch(error=>{console.error(error);process.exitCode=1});`
    const imported=await runChild('legacy-first',script,directory,{WORKSPACE_URL:'http://127.0.0.1:1'})
    assert.equal(imported.failure,'')
    assert.equal(imported.people[0].id,'legacy-owner')
    assert.equal(imported.note.body,'Committed in the legacy WAL')
    assert.equal(hash(sourceFile),before.database)
    assert.equal(hash(sourceFile+'-wal'),before.wal)
    assert.equal(fs.readdirSync(directory).some(name=>name.includes('.importing-')),false)
    const other=await runChild('legacy-second',script,directory,{WORKSPACE_URL:'http://127.0.0.1:2'})
    assert.ok(other.failure)
    assert.notEqual(other.opened,imported.opened)
    assert.equal(other.people.length,0)
    assert.equal(other.note.body,'')
    const retained=new Database(imported.opened)
    assert.equal(retained.prepare('SELECT body FROM daily_notes WHERE day=?').get('2026-10-10').body,'Committed in the legacy WAL')
    retained.close()
  } finally {source.close()}
})

test('two first devices bootstrap exactly one shared profile pair in an empty cloud workspace', async () => {
  const configuration=await cfg()
  const empty=new Database(':memory:')
  activeRemote=empty
  try {
    const script=String.raw`
const core=require('./core.cjs');
(async()=>{core.setSyncConfig({syncUrl:process.env.WORKSPACE_URL,authToken:'fixture-token'});await core.initDb();const people=core.listPeople();await core.cloudSync();core.closeDb();console.log(JSON.stringify(people.map(person=>({id:person.id,name:person.name}))));})().catch(error=>{console.error(error);process.exitCode=1});`
    const [first,second]=await Promise.all([
      runChild('bootstrap-a',script,path.join(temporary,'bootstrap-a'),{WORKSPACE_URL:configuration.syncUrl}),
      runChild('bootstrap-b',script,path.join(temporary,'bootstrap-b'),{WORKSPACE_URL:configuration.syncUrl})
    ])
    assert.equal(first.length,2)
    assert.deepEqual(first,second)
    assert.equal(empty.prepare('SELECT COUNT(*) AS n FROM people').get().n,2)
  } finally {activeRemote=remote;empty.close()}
})

test('different offline recurrence deletions merge by date; Undo restores only its own task/event occurrence', async () => {
  const configuration=await cfg()
  const rule=JSON.stringify({freq:'weekly',days:[4],startDate:'2026-10-01',endDate:'2026-10-22'})
  const at=(day,hour)=>new Date(`${day}T${String(hour).padStart(2,'0')}:00:00`).toISOString()
  const task=core.createTodo({title:'Offline repeating task',person_id:owner,due_at:at('2026-10-01',9),recurrence:rule})
  const event=core.createEvent({title:'Offline repeating event',person_id:owner,starts_at:at('2026-10-01',10),ends_at:at('2026-10-01',11),recurrence:rule})
  core.ensureTodoInstancesForRange('2026-10-01','2026-10-22')
  core.ensureEventInstancesForRange('2026-10-01','2026-10-22')
  await sync.syncOfflineWorkspace(local,configuration)
  // Load the same production core in a separate module/SQLite file. The two
  // journals remain independent while both clients are disconnected.
  const secondModule=path.join(temporary,'second-device.cjs')
  fs.copyFileSync(compiled,secondModule)
  const second=require(secondModule)
  const previousPath=process.env.DONELINE_DB
  process.env.DONELINE_DB=path.join(temporary,'second-device.db')
  let secondDb
  try {secondDb=second.getDb()} finally {
    if(previousPath===undefined)delete process.env.DONELINE_DB
    else process.env.DONELINE_DB=previousPath
  }
  try {
    sync.installSyncJournal(secondDb)
    await sync.syncOfflineWorkspace(secondDb,configuration)
    const instance=(db,table,parent,day)=>db.prepare(`SELECT id FROM ${table} WHERE recur_parent=? AND ${table==='todos'?'due_at':'starts_at'}=?`)
      .get(parent,at(day,table==='todos'?9:10)).id
    const taskUndo=core.deleteTodo(instance(local,'todos',task.id,'2026-10-08'))
    const eventUndo=core.deleteEvent(instance(local,'events',event.id,'2026-10-08'))
    second.deleteTodo(instance(secondDb,'todos',task.id,'2026-10-15'))
    second.deleteEvent(instance(secondDb,'events',event.id,'2026-10-15'))
    await sync.syncOfflineWorkspace(local,configuration)
    await sync.syncOfflineWorkspace(secondDb,configuration)
    await sync.syncOfflineWorkspace(local,configuration)
    for(const [kind,parent] of [['todos',task.id],['events',event.id]]) {
      const raw=JSON.parse(local.prepare(`SELECT recurrence FROM ${kind} WHERE id=?`).get(parent).recurrence)
      assert.deepEqual(raw.excludedDates,['2026-10-15'],'the second whole-row rule really overwrote the first JSON exclusion')
      assert.deepEqual(core.effectiveRuleExclusions(kind,parent,raw).excludedDates,['2026-10-08','2026-10-15'])
    }
    core.ensureTodoInstancesForRange('2026-10-01','2026-10-22')
    core.ensureEventInstancesForRange('2026-10-01','2026-10-22')
    assert.equal(local.prepare('SELECT COUNT(*) AS n FROM todos WHERE recur_parent=?').get(task.id).n,2)
    assert.equal(local.prepare('SELECT COUNT(*) AS n FROM events WHERE recur_parent=?').get(event.id).n,2)
    core.restoreTrash(taskUndo)
    core.restoreTrash(eventUndo)
    await sync.syncOfflineWorkspace(local,configuration)
    await sync.syncOfflineWorkspace(secondDb,configuration)
    await sync.syncOfflineWorkspace(local,configuration)
    for(const [kind,parent] of [['task',task.id],['event',event.id]]) {
      assert.deepEqual(remote.prepare('SELECT day,excluded FROM recurrence_exclusions WHERE kind=? AND parent_id=? ORDER BY day').all(kind,parent),
        [{day:'2026-10-08',excluded:0},{day:'2026-10-15',excluded:1}])
    }
    core.ensureTodoInstancesForRange('2026-10-01','2026-10-22')
    core.ensureEventInstancesForRange('2026-10-01','2026-10-22')
    assert.equal(local.prepare('SELECT COUNT(*) AS n FROM todos WHERE recur_parent=?').get(task.id).n,3)
    assert.equal(local.prepare('SELECT COUNT(*) AS n FROM events WHERE recur_parent=?').get(event.id).n,3)
    assert.deepEqual(JSON.parse(second.getTodo(task.id).recurrence).excludedDates,['2026-10-15'])
    assert.deepEqual(JSON.parse(second.getEvent(event.id).recurrence).excludedDates,['2026-10-15'])
  } finally {second.closeDb()}
})

test('legacy JSON exclusions become durable date records on first cloud pull; backfill cannot undo an explicit restore', async () => {
  const configuration=await cfg()
  const task=core.createTodo({title:'Legacy exclusion',person_id:owner,due_at:new Date('2026-10-01T09:00:00').toISOString(),
    recurrence:JSON.stringify({freq:'weekly',days:[4],startDate:'2026-10-01',endDate:'2026-10-22',excludedDates:['2026-10-08']})})
  await sync.syncOfflineWorkspace(local,configuration)
  assert.equal(remote.prepare('SELECT COUNT(*) AS n FROM recurrence_exclusions WHERE parent_id=?').get(task.id).n,0)
  const result=await runChild('legacy-exclusion-pull',String.raw`
const core=require('./core.cjs');
(async()=>{core.setSyncConfig({syncUrl:process.env.WORKSPACE_URL,authToken:'fixture-token'});await core.initDb();console.log(JSON.stringify(core.getWorkspaceSyncStatus()));core.closeDb();})().catch(error=>{console.error(error);process.exitCode=1});`,
    path.join(temporary,'legacy-exclusion-pull'),{WORKSPACE_URL:configuration.syncUrl})
  assert.equal(result.pending,0)
  assert.deepEqual(remote.prepare('SELECT day,excluded FROM recurrence_exclusions WHERE parent_id=?').all(task.id),[{day:'2026-10-08',excluded:1}])
  await sync.syncOfflineWorkspace(local,configuration)
  core.setOccurrenceExclusion('todos',task.id,'2026-10-08',false)
  // An older template JSON can reappear after a whole-row conflict, but the
  // explicit independent Undo record must continue to win over that JSON.
  local.prepare('UPDATE todos SET recurrence=? WHERE id=?').run(task.recurrence,task.id)
  const before=sync.pendingSyncChanges(local)
  core.backfillRecurrenceExclusions(local)
  core.backfillRecurrenceExclusions(local)
  assert.equal(sync.pendingSyncChanges(local),before,'repeat backfill must not journal duplicate operations')
  assert.equal(local.prepare('SELECT excluded FROM recurrence_exclusions WHERE parent_id=?').get(task.id).excluded,0)
  assert.equal(JSON.parse(core.getTodo(task.id).recurrence).excludedDates,undefined)
  await sync.syncOfflineWorkspace(local,configuration)
})
