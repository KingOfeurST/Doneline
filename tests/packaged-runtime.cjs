/** Smoke the shipped Electron executable, ASAR and native database.
 * node tests/packaged-runtime.cjs [--app <exe-or-app-bundle>] [--launch]
 * DONELINE_PACKAGED_APP also selects an executable or .app bundle.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const pkg = require('../package.json')
const productName = pkg.build.productName

function macExecutable(bundle) {
  const directory = path.join(bundle, 'Contents', 'MacOS')
  const plist = path.join(bundle, 'Contents', 'Info.plist')
  const xml = fs.existsSync(plist) ? fs.readFileSync(plist, 'utf8') : ''
  const name = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(xml)?.[1]
  if (name) {
    assert.equal(path.basename(name), name, 'Invalid CFBundleExecutable')
    return path.join(directory, name.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
  }
  // Electron-builder normally writes XML. For a binary plist, use the exact
  // product executable rather than accidentally selecting an Electron helper.
  const expected = path.join(directory, productName)
  if (fs.existsSync(expected)) return expected
  throw new Error('Cannot find the main executable in ' + bundle)
}

function resolveApplication(value) {
  const location = path.resolve(value)
  const executable = location.endsWith('.app') ? macExecutable(location) : location
  const resources = path.basename(path.dirname(executable)) === 'MacOS'
    ? path.join(path.dirname(executable), '..', 'Resources')
    : path.join(path.dirname(executable), 'resources')
  assert.ok(fs.statSync(executable).isFile(), 'Missing packaged executable: ' + executable)
  const archive = path.resolve(resources, 'app.asar')
  assert.ok(fs.statSync(archive).isFile(), 'Missing packaged app.asar: ' + archive)
  return { executable, archive }
}

function discoverApplication(platform = process.platform, arch = process.arch, output = path.join(root, 'release')) {
  const directories = platform === 'darwin'
    ? (arch === 'arm64' ? ['mac-arm64', 'mac-universal', 'mac'] : ['mac', 'mac-x64', 'mac-universal'])
    : platform === 'win32' ? (arch === 'arm64' ? ['win-arm64-unpacked', 'win-unpacked'] : ['win-unpacked', 'win-x64-unpacked'])
      : ['linux-unpacked', 'linux-' + arch + '-unpacked']
  for (const directory of directories) {
    const folder = path.join(output, directory)
    if (!fs.existsSync(folder)) continue
    if (platform === 'darwin') {
      const bundles = fs.readdirSync(folder).filter((name) => name.endsWith('.app'))
      if (bundles.length === 1) return path.join(folder, bundles[0])
      if (bundles.includes(productName + '.app')) return path.join(folder, productName + '.app')
    } else {
      const executable = path.join(folder, platform === 'win32' ? productName + '.exe' : pkg.name)
      if (fs.existsSync(executable)) return executable
    }
  }
  throw new Error('No packaged ' + platform + '/' + arch + ' app found. Package it first, or pass --app <executable-or-app-bundle>.')
}

function isolatedEnvironment(directory) {
  const env = { ...process.env, DONELINE_DIR: path.join(directory, 'data'), DONELINE_DB: ':memory:', DONELINE_USER_DATA_DIR: path.join(directory, 'profile') }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_PATH', 'NODE_OPTIONS', 'LIBSQL_JS_DEV']) delete env[name]
  return env
}

/** Read the binary's declared OS floor instead of assuming Electron's floor applies to addons. */
function machOMinimumVersion(binary, arch) {
  const cpu = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : 0
  assert.ok(cpu, 'Unsupported Mac architecture: ' + arch)
  const magic = binary.readUInt32BE(0)
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const stride = magic === 0xcafebabf ? 32 : 20
    let selected
    for (let i = 0; i < binary.readUInt32BE(4); i++) {
      const offset = 8 + i * stride
      if (binary.readUInt32BE(offset) !== cpu) continue
      const start = magic === 0xcafebabf ? Number(binary.readBigUInt64BE(offset + 8)) : binary.readUInt32BE(offset + 8)
      const size = magic === 0xcafebabf ? Number(binary.readBigUInt64BE(offset + 16)) : binary.readUInt32BE(offset + 12)
      selected = binary.subarray(start, start + size)
    }
    assert.ok(selected, 'Universal native addon has no ' + arch + ' slice')
    binary = selected
  }
  assert.equal(binary.readUInt32LE(0), 0xfeedfacf, 'Expected a 64-bit little-endian Mac native addon')
  assert.equal(binary.readUInt32LE(4), cpu, 'Native addon has the wrong CPU architecture')
  let offset = 32
  let minimum
  for (let i = 0; i < binary.readUInt32LE(16); i++) {
    const command = binary.readUInt32LE(offset)
    const size = binary.readUInt32LE(offset + 4)
    assert.ok(size >= 8 && offset + size <= binary.length, 'Invalid Mach-O command')
    if (command === 0x32) minimum = binary.readUInt32LE(offset + 12) // LC_BUILD_VERSION
    if (command === 0x24) minimum = binary.readUInt32LE(offset + 8) // LC_VERSION_MIN_MACOSX
    offset += size
  }
  assert.notEqual(minimum, undefined, 'Native addon does not declare a minimum macOS version')
  return [(minimum >>> 16) & 65535, (minimum >>> 8) & 255, minimum & 255].join('.')
}

function versionOrder(version) {
  assert.ok(/^\d+\.\d+(?:\.\d+)?$/.test(version), 'Invalid minimum macOS version: ' + version)
  const parts = version.split('.').map(Number)
  return parts[0] * 65536 + parts[1] * 256 + (parts[2] || 0)
}

function runNativeProbe(application, directory) {
  const script = path.join(directory, 'probe.cjs')
  fs.writeFileSync(script, [
    "const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');",
    'const archive = ' + JSON.stringify(application.archive) + ';',
    "const load = require('node:module').createRequire(path.join(archive,'package.json'));",
    "assert.ok(process.versions.electron, 'Probe must use the shipped Electron runtime');",
    "function packaged(name) { const file=load.resolve(name); assert.ok(file.startsWith(archive+path.sep)||file.startsWith(archive+'.unpacked'+path.sep),name+' resolved outside package: '+file); return load(name); }",
    "const Database = packaged('libsql');",
    "const target = packaged('@neon-rs/load').currentTarget();",
    "const native = load.resolve('@libsql/' + target);",
    "assert.ok(native.startsWith(archive+path.sep)||native.startsWith(archive+'.unpacked'+path.sep), 'Native addon resolved outside package');",
    "const unpackedNative = native.startsWith(archive+path.sep) ? native.replace(archive,archive+'.unpacked') : native;",
    "assert.ok(fs.existsSync(unpackedNative), 'Native database addon must be unpacked: '+unpackedNative);",
    machOMinimumVersion.toString(),
    versionOrder.toString(),
    'const declaredMacMinimum = ' + JSON.stringify(pkg.build.mac.minimumSystemVersion) + ';',
    "if (process.platform==='darwin') { const nativeMinimum=machOMinimumVersion(fs.readFileSync(unpackedNative),process.arch); assert.ok(versionOrder(nativeMinimum)<=versionOrder(declaredMacMinimum),'Native libSQL requires macOS '+nativeMinimum+' but app declares '+declaredMacMinimum); const plist=fs.readFileSync(path.join(path.dirname(archive),'..','Info.plist'),'utf8'); const bundleMinimum=/<key>LSMinimumSystemVersion<\\/key>\\s*<string>([^<]+)<\\/string>/.exec(plist)?.[1]; assert.ok(bundleMinimum,'Packaged Info.plist must declare LSMinimumSystemVersion'); assert.equal(versionOrder(bundleMinimum),versionOrder(declaredMacMinimum),'Packaged Info.plist minimum differs from build configuration'); console.log('Mac OS floor passed: native '+nativeMinimum+', application '+bundleMinimum); }",
    "const db = new Database(':memory:'); db.exec('CREATE TABLE probe (n INTEGER); INSERT INTO probe VALUES (1)');",
    "db.transaction(() => db.prepare('INSERT INTO probe VALUES (?)').run(2)).immediate();",
    "assert.equal(db.prepare('SELECT SUM(n) AS n FROM probe').get().n,3); db.close();",
    "const ical = packaged('ical.js'); const ICAL = ical.default || ical;",
    "assert.equal(new ICAL.Component(ICAL.parse('BEGIN:VCALENDAR\\r\\nVERSION:2.0\\r\\nEND:VCALENDAR\\r\\n')).name,'vcalendar');",
    "const pkg=load('./package.json'); assert.equal(pkg.version," + JSON.stringify(pkg.version) + ');',
    "for (const file of ['out/main/index.js','out/preload/index.js','out/renderer/index.html']) assert.ok(fs.existsSync(path.join(archive,file)), 'Missing packaged entry: '+file);",
    "console.log('Packaged runtime passed: '+process.platform+'/'+process.arch+', Electron '+process.versions.electron+', libSQL '+target+', version '+pkg.version);"
  ].join('\n'))
  const env = { ...isolatedEnvironment(directory), ELECTRON_RUN_AS_NODE: '1' }
  const result = spawnSync(application.executable, [script], { cwd: directory, env, windowsHide: true, timeout: 30000, encoding: 'utf8' })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'Packaged runtime failed, signal ' + (result.signal || 'none'))
  assert.ok(result.stdout.includes('Packaged runtime passed:'))
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
async function until(read, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await delay(100) }
  throw new Error('Timed out: ' + label)
}

async function connectProtocol(url) {
  const socket = new WebSocket(url)
  let nextId = 0
  const pending = new Map()
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out opening local debugger')), 5000)
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Local debugger connection failed')) }, { once: true })
  })
  socket.addEventListener('message', ({ data }) => {
    const response = JSON.parse(String(data))
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timeout)
    if (response.error) request.reject(new Error(response.error.message))
    else request.resolve(response.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Packaged app debugger closed')) }
    pending.clear()
  })
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method)) }, 10000)
        pending.set(id, { resolve, reject, timeout })
        socket.send(JSON.stringify({ id, method, params }))
      })
    }
  }
}

async function runLaunchProbe(application, directory) {
  const profile = path.join(directory, 'profile')
  const child = spawn(application.executable, [
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, '--disable-renderer-backgrounding'
  ], { cwd: directory, env: isolatedEnvironment(directory), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let exited = false
  let launchError
  child.on('error', (error) => { launchError = error })
  child.on('exit', () => { exited = true })
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-20000) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  let protocol
  try {
    const endpoint = await until(() => {
      if (launchError) throw launchError
      if (exited) throw new Error('Packaged app exited during startup:\n' + output)
      const match = /DevTools listening on (ws:\/\/(?:127\.0\.0\.1|localhost):\d+\/devtools\/browser\/[^\s]+)/.exec(output)
      // Chromium also writes this file on platforms where stderr is redirected.
      const activePort = path.join(profile, 'DevToolsActivePort')
      const port = match ? new URL(match[1]).port : fs.existsSync(activePort) ? fs.readFileSync(activePort, 'utf8').split('\n')[0].trim() : ''
      return /^\d+$/.test(port) ? 'http://127.0.0.1:' + port : null
    }, 'packaged app local debugger')
    const target = await until(async () => {
      if (exited) throw new Error('Packaged app exited before rendering:\n' + output)
      try {
        const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(2000) })
        if (!response.ok) return null
        const pages = await response.json()
        return pages.find((page) => page.type === 'page' && page.url.startsWith('file:') && page.url.includes('app.asar'))
      } catch { return null }
    }, 'packaged renderer page')
    protocol = await connectProtocol(target.webSocketDebuggerUrl)
    const evaluate = async (expression) => {
      const result = await protocol.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      return result.result.value
    }
    await until(() => evaluate("document.querySelector('h1')?.textContent === 'Today' && !!window.doneline && !!document.querySelector('[aria-label=\"0 todos left\"]')"), 'packaged Today view and empty task count')
    const state = await evaluate("(async()=>{ const api=window.doneline; const people=await api.people.list(); return {version:await api.updates.version(),people:people.length,self:await api.presence.getSelf(),ids:people.map(p=>p.id),workspace:await api.workspace.status(),todos:(await api.todos.today()).length,requireType:typeof window.require,processType:typeof window.process,heading:document.querySelector('h1').textContent}; })()")
    assert.equal(state.version, pkg.version)
    assert.equal(state.people, 2, 'Isolated startup seeds two profiles')
    assert.ok(state.ids.includes(state.self), 'Default self profile loads through packaged preload/IPC')
    assert.equal(state.workspace.cloud, false, 'Smoke must not connect to a real workspace')
    assert.equal(state.todos, 0, 'Smoke must not load real user tasks')
    assert.equal(state.requireType, 'undefined', 'Renderer must not expose Node require')
    assert.equal(state.processType, 'undefined', 'Renderer must not expose Node process')
    assert.ok(fs.existsSync(profile), 'App must use a private Chromium profile')
    console.log('Packaged launch passed: Today, sandboxed preload/IPC, empty isolated database and two seeded profiles.')
  } catch (error) {
    console.error(output)
    throw error
  } finally {
    protocol?.close()
    // Terminate only the process spawned above, never an existing user's app.
    if (!exited && child.pid) {
      child.kill('SIGTERM')
      await until(() => exited, 'test application shutdown', 5000).catch(async () => {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else child.kill('SIGKILL')
        await until(() => exited, 'test application forced shutdown', 5000)
      })
    }
  }
}

async function main() {
  const args = process.argv.slice(2)
  let explicit = process.env.DONELINE_PACKAGED_APP
  let launch = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--launch') launch = true
    else if (args[i] === '--app') { explicit = args[++i]; if (!explicit) throw new Error('--app requires an executable or .app bundle path.') }
    else if (!args[i].startsWith('-') && !explicit) explicit = args[i]
    else throw new Error('Unknown packaged smoke argument: ' + args[i])
  }
  const application = resolveApplication(explicit || discoverApplication())
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-packaged-test-'))
  try {
    runNativeProbe(application, directory)
    if (launch) await runLaunchProbe(application, directory)
  } finally {
    const resolved = path.resolve(directory)
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('doneline-packaged-test-'))
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

module.exports = { discoverApplication, resolveApplication, machOMinimumVersion, versionOrder }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
