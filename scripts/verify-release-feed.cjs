const assert = require('node:assert/strict')
const semver = require('semver')
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider')
const { MacUpdater } = require('electron-updater/out/MacUpdater')
const { findFile } = require('electron-updater/out/providers/Provider')
const version = require('../package.json').version

const executor = {
  async request(options) {
    const url = `${options.protocol || 'https:'}//${options.hostname}${options.port ? ':' + options.port : ''}${options.path}`
    const response = await fetch(url, { headers: { 'User-Agent': 'Doneline-release-verification', ...options.headers }, signal: AbortSignal.timeout(30000) })
    assert.ok(response.ok, `Updater feed request failed: ${response.status} ${url}`)
    return response.text()
  },
}

async function main() {
  for (const platform of ['win32', 'darwin']) {
    const updater = { allowPrerelease: false, currentVersion: new semver.SemVer('0.3.2'), fullChangelog: false, channel: null }
    const provider = new GitHubProvider({ provider: 'github', owner: 'KingOfeurST', repo: 'Doneline' }, updater, { platform, executor })
    const info = await provider.getLatestVersion()
    assert.equal(info.version, version, `${platform} updater must discover the new version`)
    assert.equal(info.tag, `v${version}`)
    const files = provider.resolveFiles(info)
    const selected = platform === 'win32' ? [findFile(files, 'exe')] : [false, true].map((arm) => {
      const file = findFile(MacUpdater.filterFilesForArch(files, arm), 'zip')
      assert.ok(file.url.pathname.includes(arm ? '-arm64.zip' : '-x64.zip'), 'Mac updater selected the wrong architecture')
      return file
    })
    for (const file of selected) {
      assert.ok(file.url.pathname.includes(`/v${version}/`))
      const response = await fetch(file.url, { method: 'HEAD', signal: AbortSignal.timeout(30000) })
      assert.ok(response.ok, `Installer is unavailable: ${file.url}`)
      if (file.info.size) assert.equal(Number(response.headers.get('content-length')), file.info.size)
      console.log(`${platform}: ${version} → ${file.url.pathname.split('/').pop()} (${response.status})`)
    }
  }
  console.log('Public GitHub updater feed passed for Windows, Intel Mac and Apple Silicon Mac.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
