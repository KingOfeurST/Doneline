// Real main, sandboxed preload and note editor: quit during the save debounce,
// then reopen a fresh Electron process with the same private file DB/profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

if (!process.versions.electron) {
  const { test } = require('node:test')
  const { spawnSync } = require('node:child_process')
  test('actual Electron quit and window close persist the latest note across restart', { timeout: 65000 }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-note-quit-'))
    const env = { ...process.env, TZ: 'Europe/Paris', DONELINE_NOTE_QUIT_DIR: directory,
      DONELINE_DIR: path.join(directory, 'data'), DONELINE_DB: path.join(directory, 'data', 'notes.db'),
      DONELINE_USER_DATA_DIR: path.join(directory, 'profile') }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    try {
      for (const phase of ['quit', 'read-quit', 'close', 'read-close']) {
        const result = spawnSync(require('electron'), [__filename, phase], { env, stdio: 'inherit', windowsHide: true, timeout: 15000 })
        if (result.error) throw result.error
        assert.equal(result.status, 0, `Electron note phase ${phase} failed`)
      }
    } finally {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
      assert.ok(path.basename(directory).startsWith('doneline-note-quit-'))
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
} else {
  const { app, BrowserWindow, ipcMain, dialog } = require('electron')
  const { buildSync } = require('esbuild')
  const root = path.resolve(__dirname, '..')
  const directory = process.env.DONELINE_NOTE_QUIT_DIR
  const phase = process.argv[2]
  const expected = mode => `A note typed just before ${mode}.\nUnicode: café 🌙\nFinal keystrokes while saving.`
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  app.disableHardwareAcceleration()
  fs.mkdirSync(path.join(directory, 'data'), { recursive: true })
  const output = path.join(directory, 'out')
  // Match Rollup's CommonJS default interop for electron-updater in this esbuild fixture.
  const updaterShim = path.join(directory, 'updater.ts')
  fs.writeFileSync(updaterShim, "const moduleName = 'electron-updater'; export default require(moduleName)")
  buildSync({ entryPoints: [path.join(root, 'src/main/index.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron', 'libsql'], alias: { tsdav: path.join(root, 'tests/fixtures/stalled-dav.cjs'), 'electron-updater': updaterShim },
    banner: { js: `module.paths.unshift(${JSON.stringify(path.join(root, 'node_modules'))});` },
    outfile: path.join(output, 'main/index.js'), logLevel: 'silent' })
  buildSync({ entryPoints: [path.join(root, 'src/preload/index.ts')], bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: path.join(output, 'preload/index.js'), logLevel: 'silent' })
  buildSync({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from './src/renderer/src/App';
    window.__noteErrors=[]; window.addEventListener('unhandledrejection',e=>window.__noteErrors.push(String(e.reason)));
    createRoot(document.getElementById('root')).render(<App/>);`, resolveDir: root, loader: 'tsx' },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: path.join(output, 'renderer/app.js'),
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
  fs.writeFileSync(path.join(output, 'renderer/index.html'), '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="app.js"></script>')

  let failureNotices = 0
  dialog.showMessageBox = async () => { failureNotices++; return { response: 0, checkboxChecked: false } }
  let rejectWrites = false
  let acknowledged = 0
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, channel === 'notes:set' ? async (...args) => {
    if (rejectWrites) throw new Error('Fixture disk write failed')
    await wait(300)
    const saved = await listener(...args)
    acknowledged++
    return saved
  } : listener)
  require(path.join(output, 'main/index.js'))

  async function run() {
    await app.whenReady()
    let window
    for (let attempts = 0; attempts < 150; attempts++) {
      window = BrowserWindow.getAllWindows()[0]
      if (window && !window.webContents.isLoading()) break
      await wait(20)
    }
    assert.ok(window, 'Production main created a window')
    const evaluate = (fn, argument) => window.webContents.executeJavaScript(`(${fn.toString()})(${JSON.stringify(argument)})`)
    // Dismiss the real splash and wait for the production Today editor to load.
    await evaluate(() => document.querySelector('#root > div')?.click())
    let loaded = false
    for (let attempts = 0; attempts < 200; attempts++) {
      loaded = await evaluate(() => !!document.querySelector('textarea:not(:disabled)'))
      if (loaded) break
      await wait(20)
    }
    assert.ok(loaded, 'Production Today note loaded')
    const identity = await evaluate(async () => ({ personId: (await window.doneline.people.list())[0].id, day: await window.doneline.today() }))
    const type = body => evaluate(body => {
      const editor = document.querySelector('textarea:not(:disabled)')
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      set.call(editor, body)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    }, body)

    if (phase.startsWith('read-')) {
      const mode = phase.slice(5)
      const note = await evaluate(async input => window.doneline.notes.get(input.day, input.personId), identity)
      assert.equal(note.body, expected(mode), 'SQLite contains every final keystroke after a fresh process starts')
      assert.equal(await evaluate(() => document.querySelector('textarea:not(:disabled)').value), expected(mode), 'Reopened editor shows the saved note')
      assert.equal(await evaluate(input => localStorage.getItem(`doneline.noteDraft:${input.day}:${input.personId}`), identity), null, 'Acknowledged draft has been cleared')
      assert.deepEqual(await evaluate(() => window.__noteErrors), [], 'No unhandled renderer save errors')
      console.log(`PASS: actual Electron reopened ${mode} note from private SQLite database`)
      app.quit()
      return
    }

    if (phase === 'quit') {
      // Failed local writes must keep the app and its visible draft alive.
      rejectWrites = true
      await type('Draft that must survive a failed quit')
      app.quit()
      for (let attempts = 0; attempts < 100 && !failureNotices; attempts++) await wait(10)
      assert.equal(failureNotices, 1, 'The quit failure is explained')
      assert.equal(window.isDestroyed(), false, 'Failed note acknowledgement cancels quit')
      assert.equal(await evaluate(() => document.querySelector('textarea').value), 'Draft that must survive a failed quit')
      rejectWrites = false
    }
    await type(expected(phase).replace('Final keystrokes while saving.', 'First draft.'))
    const started = Date.now()
    const finalEdit = setTimeout(() => { void type(expected(phase)).catch(error => { console.error(error); app.exit(1) }) }, 60)
    app.on('will-quit', () => {
      clearTimeout(finalEdit)
      try {
        assert.ok(Date.now() - started >= 550, 'Quit waited through both delayed local acknowledgements')
        assert.ok(acknowledged >= 2, 'Newer edit made during quit also received a save acknowledgement')
        console.log(`PASS: actual Electron ${phase} waited for latest debounced note save`)
      } catch (error) { console.error(error); app.exit(1) }
    })
    if (phase === 'close') {
      // Cmd+W normally keeps a macOS app running; quit only after its guarded close.
      if (process.platform === 'darwin') window.once('closed', () => app.quit())
      window.close()
    }
    else app.quit()
  }
  void run().catch(error => { console.error(error); app.exit(1) })
}
