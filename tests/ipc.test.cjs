// Exercise the real sandboxed preload and IPC handlers against an isolated DB.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-ipc-test-'))
  const env = { ...process.env, TZ: 'Europe/Paris', DONELINE_IPC_TEST_DIR: directory, DONELINE_DIR: path.join(directory, 'data'), DONELINE_DB: ':memory:' }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 45000 })
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('doneline-ipc-test-'))
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const { buildSync } = require('esbuild')
  const temporary = process.env.DONELINE_IPC_TEST_DIR
  app.disableHardwareAcceleration()
  app.setPath('userData', path.join(temporary, 'profile'))
  const root = path.resolve(__dirname, '..')
  const main = path.join(temporary, 'ipc.cjs')
  const preload = path.join(temporary, 'preload.cjs')
  // Deliberately stalled network proves mutations return without awaiting sync.
  buildSync({ stdin: { contents: `export { registerIpc } from './src/main/ipc'; export { closeDb } from './core/db'; export { CH } from './src/shared/channels';`, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'libsql'],
    alias: { tsdav: path.join(root, 'tests/fixtures/stalled-dav.cjs') },
    banner: { js: `module.paths.unshift(${JSON.stringify(path.join(root, 'node_modules'))});` }, outfile: main, logLevel: 'silent' })
  buildSync({ entryPoints: [path.join(root, 'src/preload/index.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: preload, logLevel: 'silent' })
  const handlers = require(main)
  let window
  app.whenReady().then(async () => {
    handlers.registerIpc(() => {})
    // This bootstrap handler lives in main/index rather than registerIpc.
    ipcMain.handle(handlers.CH.appPlatform, () => process.platform)
    window = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await window.loadURL('about:blank')
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' })
    const html = path.join(temporary, 'index.html')
    fs.writeFileSync(html, '<!doctype html><html><body>Isolated IPC fixture</body></html>')
    await window.loadFile(html)
    const result = await window.webContents.executeJavaScript(`(async () => {
      const api = window.doneline;
      if (!api) throw Error('Sandboxed preload did not expose the API');
      const people = await api.people.list(); const self = people[1].id;
      await api.presence.setSelf(self);
      const selected = await api.presence.getSelf();
      const task = await api.todos.create({title:'Immediate task',person_id:self});
      const done = await api.todos.toggle(task.id,true);
      const reopened = await api.todos.toggle(task.id,false);
      const rule = await api.todos.create({title:'Thursday prep',person_id:self,due_at:'2026-10-01T08:15',recurrence:JSON.stringify({freq:'weekly',days:[4],startDate:'2026-10-01',endDate:'2026-10-22'})});
      const future = await api.todos.today('2026-10-22',self);
      await api.caldav.setConfig(self,{serverUrl:'https://example.test/',username:'fixture',password:'fixture-secret',calendarUrl:'https://example.test/calendar/'});
      const safeConfig = await api.caldav.getConfig(self);
      const start=performance.now();
      const event = await api.events.create({title:'Network can wait',person_id:self,starts_at:'2026-10-08T09:00',ends_at:'2026-10-08T10:00'});
      const elapsed=performance.now()-start;
      const edited = await api.events.update(event.id,{title:'Local edit'});
      const preview = await api.items.previewRemoval({kind:'events',fromDay:'2026-10-08',toDay:'2026-10-08',personId:self,title:'Local edit'});
      const removed = await api.items.removeRange({kind:'events',fromDay:'2026-10-08',toDay:'2026-10-08',personId:self,title:'Local edit',expectedIds:preview.events.map(e=>'events:'+e.id)});
      const after = await api.events.day('2026-10-08',self);
      return {platform:await api.platform(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,selected,self,done:!!done.completed_at,reopened:!reopened.completed_at,future:future.some(t=>t.recur_parent===rule.id),safeConfig,elapsed,edited:edited.title,removed,after:after.length};
    })()`)
    assert.equal(result.platform, process.platform)
    assert.equal(result.timezone, 'Europe/Paris')
    assert.equal(result.selected, result.self)
    assert.equal(result.done, true)
    assert.equal(result.reopened, true)
    assert.equal(result.future, true)
    assert.equal(result.safeConfig.password, undefined)
    assert.ok(result.elapsed < 500, `Local event creation waited ${result.elapsed} ms`)
    assert.equal(result.edited, 'Local edit')
    assert.deepEqual(result.removed, { events: 1, todos: 0 })
    assert.equal(result.after, 0)
    console.log('IPC checks passed: sandboxed API, completion/reopen, future recurrence, safe credentials, local-first event saves and reviewed removal.')
  }).catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => {
    window?.destroy()
    handlers.closeDb()
    app.exit(process.exitCode ?? 0)
  })
}
