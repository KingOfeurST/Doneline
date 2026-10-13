// Real production app + independent CLI processes sharing a private offline DB.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-external-writes-'))
  const env = { ...process.env, TZ: 'Europe/Paris', DONELINE_EXTERNAL_TEST_DIR: directory,
    DONELINE_DIR: path.join(directory, 'data'), DONELINE_DB: path.join(directory, 'data', 'shared.db'),
    DONELINE_USER_DATA_DIR: path.join(directory, 'profile') }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  try {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename], {
      env, stdio: 'inherit', windowsHide: true, timeout: 60000 })
    if (result.error) throw result.error
    assert.equal(result.status, 0, 'External MCP writes must refresh the actual app')
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('doneline-external-writes-'))
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
} else {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const { buildSync } = require('esbuild')
  const { spawn } = require('node:child_process')
  const root = path.resolve(__dirname, '..')
  const directory = process.env.DONELINE_EXTERNAL_TEST_DIR
  const output = path.join(directory, 'out')
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.disableHardwareAcceleration()
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true })
  const shim = path.join(directory, 'updater.ts')
  fs.writeFileSync(shim, "const moduleName='electron-updater'; export default require(moduleName)")
  const banner = { js: `module.paths.unshift(${JSON.stringify(path.join(root, 'node_modules'))});` }
  buildSync({ entryPoints: [path.join(root, 'src/main/index.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron', 'libsql'], alias: { tsdav: path.join(root, 'tests/fixtures/stalled-dav.cjs'), 'electron-updater': shim },
    banner, outfile: path.join(output, 'main/index.js'), logLevel: 'silent' })
  buildSync({ entryPoints: [path.join(root, 'src/preload/index.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: path.join(output, 'preload/index.js'), logLevel: 'silent' })
  buildSync({ stdin: { contents: "import React from 'react'; import {createRoot} from 'react-dom/client'; import App from './src/renderer/src/App'; window.__errors=[];window.addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));createRoot(document.getElementById('root')).render(<App/>);",
    resolveDir: root, loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    outfile: path.join(output, 'renderer/app.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(output, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="app.js"></script>')
  for (const name of ['server', 'cli']) buildSync({ entryPoints: [path.join(root, `mcp/${name}.ts`)],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', banner,
    outfile: path.join(directory, 'agents', `${name}.cjs`), logLevel: 'silent' })

  let releaseWrite
  let blockWrites = false
  let writeEntered = false
  const writeGate = new Promise(resolve => { releaseWrite = resolve })
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, channel === 'notes:set' ? async (...args) => {
    if (blockWrites) { writeEntered = true; await writeGate }
    return listener(...args)
  } : listener)
  require(path.join(output, 'main/index.js'))

  async function until(predicate, label, timeout = 8000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await predicate()) return; await wait(30) }
    throw new Error('Timed out waiting for ' + label)
  }
  async function cli(tool, args) {
    const file = path.join(directory, 'request.json')
    fs.writeFileSync(file, JSON.stringify(args), 'utf8')
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(directory, 'agents/cli.cjs'), 'call', tool, '--input', file], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('close', code => {
        try {
          assert.equal(code, 0, `CLI ${tool} failed: ${stderr}`)
          const result = JSON.parse(stdout)
          assert.equal(result.ok, true)
          resolve(result)
        } catch (error) { reject(error) }
      })
    })
  }

  async function run() {
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows()[0] && !BrowserWindow.getAllWindows()[0].webContents.isLoading(), 'production window')
    const window = BrowserWindow.getAllWindows()[0]
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' })
    const evaluate = (fn, arg) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(arg)})`)
    await evaluate(() => document.querySelector('#root > div')?.click())
    await until(() => evaluate(() => !!document.querySelector('textarea:not(:disabled)')), 'Today note')
    const identity = await evaluate(async () => ({ day: await doneline.today(), self: await doneline.presence.getSelf(), cloud: (await doneline.workspace.status()).cloud }))
    assert.equal(identity.cloud, false, 'External-write check must work without cloud sync')
    const first = await cli('add_todo', { title: 'Assistant task 🧭', due_at: `${identity.day}T17:00` })
    assert.equal(first.local_receipt.saved_locally, true)
    await until(() => evaluate(() => document.body.textContent.includes('Assistant task 🧭') && !!document.querySelector('[aria-label="1 todos left"]')), 'external task and count')
    await cli('append_note', { day: identity.day, body: 'Assistant note café 🌙' })
    await until(() => evaluate(() => document.querySelector('textarea').value === 'Assistant note café 🌙'), 'external note')

    blockWrites = true
    const draft = 'My draft must stay visible while an assistant updates tasks.'
    await evaluate(body => {
      const editor = document.querySelector('textarea')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(editor, body)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    }, draft)
    await until(() => writeEntered, 'held local note save')
    await cli('add_todo', { title: 'Second assistant task', due_at: `${identity.day}T18:00` })
    await until(() => evaluate(() => !!document.querySelector('[aria-label="2 todos left"]')), 'refresh during a pending note save')
    assert.equal(await evaluate(() => document.querySelector('textarea').value), draft)
    blockWrites = false
    releaseWrite()
    await until(() => evaluate(async input => (await doneline.notes.get(input.day, input.self)).body === input.draft,
      { ...identity, draft }), 'latest draft saved')
    await cli('delete_todo', { id: first.data.id })
    await until(() => evaluate(() => !document.body.textContent.includes('Assistant task 🧭') && !!document.querySelector('[aria-label="1 todos left"]')), 'external task deletion')
    const friend = await evaluate(async input => (await doneline.people.list()).find(person => person.id !== input.self).id, identity)
    await cli('set_note', { day: identity.day, person_id: friend, body: 'The selected profile changed from the CLI.' })
    // Preferences live outside SQLite; selecting the profile must refresh even
    // when it has no task/event mutation to advance the database revision.
    await wait(650)
    await cli('select_profile', { person_id: friend })
    await wait(650)
    await evaluate(() => {
      const input = document.querySelector('input[placeholder^="Quick add"]')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Uses selected assistant profile')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Add').click())
    await until(() => evaluate(async () => (await doneline.todos.list()).some(todo => todo.title === 'Uses selected assistant profile')), 'task from the selected profile')
    const selectedTask = await evaluate(async () => (await doneline.todos.list()).find(todo => todo.title === 'Uses selected assistant profile'))
    assert.equal(selectedTask.person_id, friend, 'App defaults must follow the externally selected profile')
    assert.deepEqual(await evaluate(() => window.__errors), [])
    console.log('External MCP/CLI app checks passed: offline task/count/note refresh, pending draft protection, deletion and selected-profile refresh.')
    app.quit()
  }
  run().catch(error => { console.error(error); releaseWrite(); app.exit(1) })
}
