const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const yaml = require('js-yaml')
const { prepareRelease, checksum } = require('../scripts/prepare-release.cjs')

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doneline-release-test-'))
  const source = path.join(directory, 'downloaded')
  for (const platform of ['windows-x64', 'mac-x64', 'mac-arm64']) {
    const target = path.join(source, `doneline-${platform}`)
    fs.mkdirSync(target, { recursive: true })
    const names = platform === 'windows-x64' ? ['Doneline-Setup-0.3.3.exe'] : [`Doneline-0.3.3-${platform.slice(4)}.zip`, `Doneline-0.3.3-${platform.slice(4)}.dmg`]
    const files = []
    for (const name of names) {
      const file = path.join(target, name)
      fs.writeFileSync(file, `Test installer ${name}`)
      files.push({ url: name, sha512: await checksum(file), size: fs.statSync(file).size })
    }
    fs.writeFileSync(path.join(target, platform === 'windows-x64' ? 'latest.yml' : 'latest-mac.yml'), yaml.dump({ version: '0.3.3', files, path: files[0].url, sha512: files[0].sha512 }))
  }
  return { directory, source, destination: path.join(directory, 'staged') }
}
function clean(directory) {
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith('doneline-release-test-'))
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

test('release staging combines both Mac architectures with verified Windows metadata', async () => {
  const f = await fixture()
  try {
    const { mac } = await prepareRelease(f.source, f.destination, '0.3.3')
    assert.equal(mac.files.length, 4)
    assert.equal(mac.path, 'Doneline-0.3.3-x64.zip')
    assert.equal(mac.minimumSystemVersion, '23.0.0')
    assert.ok(mac.files.some((file) => file.url.endsWith('-arm64.zip')))
    assert.equal(fs.readdirSync(f.destination).length, 7)
  } finally { clean(f.directory) }
})

test('corrupted installer, missing architecture and version mismatch block the whole release', async () => {
  for (const mode of ['corrupt', 'missing', 'version']) {
    const f = await fixture()
    try {
      if (mode === 'corrupt') fs.appendFileSync(path.join(f.source, 'doneline-mac-arm64', 'Doneline-0.3.3-arm64.zip'), 'bad')
      if (mode === 'missing') fs.renameSync(path.join(f.source, 'doneline-mac-arm64'), path.join(f.source, 'wrong-platform'))
      await assert.rejects(prepareRelease(f.source, f.destination, mode === 'version' ? '0.3.4' : '0.3.3'))
      assert.ok(!fs.existsSync(f.destination), 'Failed verification must not produce publishable files')
    } finally { clean(f.directory) }
  }
})
