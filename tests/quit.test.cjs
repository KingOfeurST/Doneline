const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const output = path.resolve(__dirname, '../out/tests/quit.cjs')
buildSync({ entryPoints: [path.resolve(__dirname, '../src/main/quit.ts')], bundle: true,
  platform: 'node', format: 'cjs', outfile: output, logLevel: 'silent' })
const { QuitCoordinator } = require(output)

function windowFixture(id = 1) {
  const sent = []
  let flushes = 0
  return { sent, get flushes() { return flushes }, window: { isDestroyed: () => false,
    webContents: { id, isDestroyed: () => false, send: (channel, requestId) => sent.push({ channel, requestId }),
      session: { flushStorageData: () => flushes++ } } } }
}

test('quit accepts only the requested renderer acknowledgement and coalesces repeated attempts', async () => {
  const coordinator = new QuitCoordinator(200)
  const fixture = windowFixture()
  const first = coordinator.prepare([fixture.window])
  assert.equal(coordinator.prepare([fixture.window]), first)
  const requestId = fixture.sent[0].requestId
  let settled = false
  first.then(() => { settled = true })
  coordinator.acknowledge(2, { requestId })
  coordinator.acknowledge(1, { requestId: 'old-request' })
  await Promise.resolve()
  assert.equal(settled, false)
  coordinator.acknowledge(1, { requestId })
  await first
  assert.equal(fixture.flushes, 1)
})

test('save failure rejects quit and allows a fresh retry', async () => {
  const coordinator = new QuitCoordinator(200)
  const fixture = windowFixture()
  const pending = coordinator.prepare([fixture.window])
  const rejection = assert.rejects(pending, /Disk full/)
  coordinator.acknowledge(1, { requestId: fixture.sent[0].requestId, error: 'Disk full' })
  await rejection
  const retry = coordinator.prepare([fixture.window])
  assert.notEqual(fixture.sent[0].requestId, fixture.sent[1].requestId)
  coordinator.acknowledge(1, { requestId: fixture.sent[1].requestId })
  await retry
  assert.equal(fixture.flushes, 2)
})

test('unresponsive renderer times out without accepting a late acknowledgement on retry', async () => {
  const coordinator = new QuitCoordinator(15)
  const fixture = windowFixture()
  await assert.rejects(coordinator.prepare([fixture.window]), /Saving notes took too long/)
  const retry = coordinator.prepare([fixture.window])
  let settled = false
  retry.then(() => { settled = true })
  coordinator.acknowledge(1, { requestId: fixture.sent[0].requestId })
  await Promise.resolve()
  assert.equal(settled, false)
  coordinator.acknowledge(1, { requestId: fixture.sent[1].requestId })
  await retry
})

test('every live window must finish before quitting, destroyed windows are skipped', async () => {
  const coordinator = new QuitCoordinator(200)
  const first = windowFixture(1)
  const second = windowFixture(2)
  const destroyed = windowFixture(3)
  destroyed.window.isDestroyed = () => true
  const pending = coordinator.prepare([first.window, second.window, destroyed.window])
  let settled = false
  pending.then(() => { settled = true })
  coordinator.acknowledge(1, { requestId: first.sent[0].requestId })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(destroyed.sent.length, 0)
  coordinator.acknowledge(2, { requestId: second.sent[0].requestId })
  await pending
})
