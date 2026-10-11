const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
// Electron can install its binary lazily on first require. Finish that once in
// this parent before parallel workers launch apps from the same extracted dist.
require('electron')
const output = path.join(root, 'out', 'tests', 'ui-state.test.cjs')
buildSync({ entryPoints: [path.join(__dirname, 'ui-state.test.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: output })
const electronTests = ['data-renderer.test.cjs', 'planning-search-renderer.test.cjs', 'note-quit.test.cjs', 'ipc.test.cjs', 'renderer.test.cjs']
const tests = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.cjs') && !electronTests.includes(name))
  .sort()
  .map((name) => path.join(__dirname, name))
function run(arguments_, timeout) {
  const result = spawnSync(process.execPath, arguments_, { cwd: root, stdio: 'inherit', windowsHide: true, timeout })
  if (result.error) console.error(result.error)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(['--test', ...tests, output], 120000)
// Chromium launches and production bundles are expensive on busy computers.
// Keep each integration family separate without loosening its assertions or deadlines.
for (const name of electronTests) run([path.join(__dirname, name)], name === 'ipc.test.cjs' ? 60000 : 75000)
