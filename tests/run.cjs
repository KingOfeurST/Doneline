const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'out', 'tests', 'ui-state.test.cjs')
buildSync({ entryPoints: [path.join(__dirname, 'ui-state.test.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: output })
const tests = fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.cjs') && !['renderer.test.cjs', 'ipc.test.cjs'].includes(name))
  .sort()
  .map((name) => path.join(__dirname, name))
function run(arguments_, timeout) {
  const result = spawnSync(process.execPath, arguments_, { cwd: root, stdio: 'inherit', windowsHide: true, timeout })
  if (result.error) console.error(result.error)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(['--test', ...tests, output], 120000)
run([path.join(__dirname, 'ipc.test.cjs')], 60000)
// Run Chromium separately: the test runner's forked workers should not share app processes.
run([path.join(__dirname, 'renderer.test.cjs')], 75000)
