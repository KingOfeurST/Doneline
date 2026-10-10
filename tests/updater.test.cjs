const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const { buildSync } = require('esbuild')

const output = path.resolve(__dirname, '../out/tests/updater.cjs')
buildSync({ entryPoints: [path.resolve(__dirname, '../src/main/updates.ts')], bundle: true,
  platform: 'node', format: 'cjs', outfile: output, logLevel: 'silent' })
const { UpdateController, hasDeveloperIdSignature } = require(output)

function fixture(options = {}) {
  const updater = new EventEmitter()
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.checks = 0
  updater.installs = 0
  updater.checkForUpdates = async () => {
    updater.checks++
    if (options.check) return options.check(updater)
    updater.emit('update-not-available')
    return { isUpdateAvailable: false, updateInfo: { version: '0.3.4' } }
  }
  updater.quitAndInstall = () => { updater.installs++; options.install?.(updater) }
  const emitted = []
  const external = []
  const quitting = []
  let interval
  let stopped = false
  const controller = new UpdateController({ updater, platform: options.platform ?? 'win32',
    isPackaged: options.packaged ?? true,
    detectMacAutoInstall: options.detect ?? (async () => options.signed ?? false),
    emit: (status) => emitted.push(status),
    openExternal: async (url) => { external.push(url); await options.open?.() },
    setQuitting: (value) => quitting.push(value),
    prepareForInstall: options.prepare,
    schedule: (callback, milliseconds) => {
      assert.equal(milliseconds, 6 * 60 * 60 * 1000)
      interval = callback
      return () => { stopped = true }
    } })
  return { controller, updater, emitted, external, quitting,
    tick: () => interval?.(), stopped: () => stopped }
}

test('unsigned Mac checks releases without downloading or invoking Squirrel', async () => {
  const f = fixture({ platform: 'darwin', check: async (updater) => {
    updater.emit('update-available', { version: '0.3.4' })
    return { isUpdateAvailable: true, updateInfo: { version: '0.3.4' } }
  } })
  await f.controller.start()
  assert.equal(f.updater.autoDownload, false)
  assert.equal(f.updater.autoInstallOnAppQuit, false)
  assert.deepEqual(await f.controller.status(), { state: 'available', version: '0.3.4', canAutoInstall: false })
  await f.controller.install()
  assert.deepEqual(f.external, ['https://github.com/KingOfeurST/Doneline/releases/latest'])
  assert.equal(f.updater.installs, 0)
  assert.deepEqual(f.quitting, [])
  f.controller.dispose()
})

test('Developer ID signed Mac enables native updates; failed verification stays manual', async () => {
  const signed = fixture({ platform: 'darwin', signed: true })
  assert.equal((await signed.controller.status()).canAutoInstall, true)
  assert.equal(signed.updater.autoDownload, true)
  signed.controller.dispose()
  const failed = fixture({ platform: 'darwin', detect: async () => { throw Error('codesign failed') } })
  assert.equal((await failed.controller.status()).canAutoInstall, false)
  assert.equal(failed.updater.autoDownload, false)
  failed.controller.dispose()
})

test('signature detection requires Developer ID and a real team identity', () => {
  assert.equal(hasDeveloperIdSignature('Authority=Developer ID Application: Chris (A123456789)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=A123456789\n'), true)
  assert.equal(hasDeveloperIdSignature('Signature=adhoc\nTeamIdentifier=not set\n'), false)
  assert.equal(hasDeveloperIdSignature('Authority=Apple Development: Chris\nTeamIdentifier=A123456789\n'), false)
  assert.equal(hasDeveloperIdSignature('Authority=Developer ID Application: Chris\nTeamIdentifier=not set\n'), false)
})

test('startup downloaded status is retained and only a ready update may install once', async () => {
  const f = fixture()
  await f.controller.start()
  await assert.rejects(f.controller.install(), /Download an update/)
  assert.equal(f.updater.installs, 0)
  f.updater.emit('update-downloaded', { version: '0.3.4' })
  const status = await f.controller.status()
  assert.deepEqual(status, { state: 'downloaded', version: '0.3.4', canAutoInstall: true })
  status.state = 'idle'
  assert.equal((await f.controller.status()).state, 'downloaded')
  await f.controller.check()
  assert.equal(f.updater.checks, 1)
  await Promise.all([f.controller.install(), f.controller.install()])
  assert.equal(f.updater.installs, 1)
  assert.deepEqual(f.quitting, [true])
  f.controller.dispose()
})

test('concurrent checks share a request and check failures become retained errors', async () => {
  let reject
  const f = fixture({ check: () => new Promise((_resolve, rejection) => { reject = rejection }) })
  const first = f.controller.check()
  const second = f.controller.check()
  await new Promise(setImmediate)
  assert.equal(f.updater.checks, 1)
  reject(Error('Offline'))
  const statuses = await Promise.all([first, second])
  assert.ok(statuses.every((status) => status.state === 'error' && status.message === 'Offline'))
  f.controller.dispose()
})

test('update installation waits for editors to save before closing their windows', async () => {
  let finishSave
  let flushes = 0
  const f = fixture({ prepare: () => {
    flushes++
    return new Promise((resolve) => { finishSave = resolve })
  } })
  await f.controller.status()
  f.updater.emit('update-downloaded', { version: '0.3.5' })
  const install = f.controller.install()
  await new Promise(setImmediate)
  await f.controller.install()
  assert.equal(flushes, 1)
  assert.equal(f.updater.installs, 0)
  assert.deepEqual(f.quitting, [])
  finishSave()
  await install
  assert.equal(f.updater.installs, 1)
  assert.deepEqual(f.quitting, [true])
  f.controller.dispose()
})

test('failed editor flush prevents update installation and reports its failure', async () => {
  const f = fixture({ prepare: async () => { throw Error('Note save failed') } })
  await f.controller.status()
  f.updater.emit('update-downloaded', { version: '0.3.5' })
  await assert.rejects(f.controller.install(), /Note save failed/)
  assert.equal(f.updater.installs, 0)
  assert.equal((await f.controller.status()).message, 'Note save failed')
  assert.ok(!f.quitting.includes(true))
  f.controller.dispose()
})

test('an updater failure during editor saving cannot install an invalidated update', async () => {
  let finishSave
  const f = fixture({ prepare: () => new Promise((resolve) => { finishSave = resolve }) })
  await f.controller.status()
  f.updater.emit('update-downloaded', { version: '0.3.5' })
  const install = f.controller.install()
  await new Promise(setImmediate)
  f.updater.emit('error', Error('Update became unavailable'))
  finishSave()
  await assert.rejects(install, /Update became unavailable/)
  assert.equal(f.updater.installs, 0)
  assert.ok(!f.quitting.includes(true))
  f.controller.dispose()
})

test('download rejection is consumed after a successful check and prevents installation', async () => {
  let rejectDownload
  const f = fixture({ check: async (updater) => {
    updater.emit('update-available', { version: '0.3.4' })
    return { isUpdateAvailable: true, updateInfo: { version: '0.3.4' },
      downloadPromise: new Promise((_resolve, reject) => { rejectDownload = reject }) }
  } })
  await f.controller.check()
  f.updater.emit('download-progress', { percent: 22.7 })
  assert.equal((await f.controller.status()).percent, 23)
  rejectDownload(Error('Download failed'))
  await new Promise(setImmediate)
  assert.equal((await f.controller.status()).state, 'error')
  assert.equal((await f.controller.status()).message, 'Download failed')
  await assert.rejects(f.controller.install(), /Download an update/)
  f.controller.dispose()
})

test('installer errors restore normal quit behavior and remove ready state', async () => {
  const f = fixture({ install: (updater) => updater.emit('error', Error('Installer refused')) })
  await f.controller.status()
  f.updater.emit('update-downloaded', { version: '0.3.4' })
  await f.controller.install()
  assert.deepEqual(f.quitting, [true, false])
  assert.equal((await f.controller.status()).message, 'Installer refused')
  await assert.rejects(f.controller.install(), /Download an update/)
  f.controller.dispose()
})

test('failed manual downloads-page action reports the error', async () => {
  const f = fixture({ platform: 'darwin', open: async () => { throw Error('Browser unavailable') } })
  await assert.rejects(f.controller.install(), /Browser unavailable/)
  assert.equal((await f.controller.status()).message, 'Browser unavailable')
  f.controller.dispose()
})

test('periodic checks run while open and dispose removes timers and listeners', async () => {
  const f = fixture()
  await f.controller.start()
  assert.equal(f.updater.checks, 1)
  f.tick()
  await new Promise(setImmediate)
  assert.equal(f.updater.checks, 2)
  f.controller.dispose()
  assert.equal(f.stopped(), true)
  assert.equal(f.updater.listenerCount('update-downloaded'), 0)
  f.tick()
  await new Promise(setImmediate)
  assert.equal(f.updater.checks, 2)
})

test('development builds never check, schedule, install or open external pages', async () => {
  const f = fixture({ packaged: false })
  await f.controller.start()
  assert.deepEqual(await f.controller.check(), { state: 'dev', canAutoInstall: false })
  await assert.rejects(f.controller.install(), /installed app/)
  assert.equal(f.updater.checks, 0)
  assert.equal(f.updater.installs, 0)
  assert.equal(f.stopped(), false)
  assert.deepEqual(f.external, [])
  f.controller.dispose()
})
