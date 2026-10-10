const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const yaml = require('js-yaml')

async function checksum(file) {
  const hash = createHash('sha512')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('base64')
}

function safeName(name) {
  assert.equal(typeof name, 'string', 'An update file needs a filename')
  assert.match(name, /^[A-Za-z0-9._-]+$/, `Unsafe update filename: ${name}`)
  assert.equal(path.basename(name), name)
  return name
}

async function prepareRelease(source, destination, version = require('../package.json').version) {
  const platforms = ['windows-x64', 'mac-x64', 'mac-arm64']
  const assets = new Map()
  const manifests = new Map()
  for (const platform of platforms) {
    const directory = path.join(source, `doneline-${platform}`)
    const manifestName = platform === 'windows-x64' ? 'latest.yml' : 'latest-mac.yml'
    const info = yaml.load(fs.readFileSync(path.join(directory, manifestName), 'utf8'))
    assert.equal(info.version, version, `${platform} version does not match the release`)
    assert.ok(Array.isArray(info.files) && info.files.length, `${platform} has no update files`)
    const urls = new Set()
    for (const entry of info.files) {
      safeName(entry.url)
      assert.ok(!urls.has(entry.url), `Duplicate update entry: ${entry.url}`)
      urls.add(entry.url)
      assert.match(entry.sha512, /^[A-Za-z0-9+/]{86}==$/, `Invalid checksum: ${entry.url}`)
      const file = path.join(directory, entry.url)
      const stat = fs.lstatSync(file)
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Expected an installer: ${entry.url}`)
      assert.equal(await checksum(file), entry.sha512, `Checksum mismatch: ${entry.url}`)
      if (entry.size !== undefined) assert.equal(stat.size, entry.size, `Size mismatch: ${entry.url}`)
    }
    const suffix = platform === 'windows-x64' ? '.exe' : `-${platform.slice(4)}.zip`
    assert.ok(info.files.some((entry) => entry.url.endsWith(suffix)), `${platform} installer is missing`)
    if (platform !== 'windows-x64') {
      assert.ok(info.files.some((entry) => entry.url.endsWith(`-${platform.slice(4)}.dmg`)), `${platform} DMG is missing`)
    }
    assert.ok(urls.has(info.path), `${platform} legacy update path is missing`)
    assert.equal(info.sha512, info.files.find((entry) => entry.url === info.path).sha512)
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('.yml')) {
        assert.equal(name, manifestName, `Unexpected update manifest: ${name}`)
        continue
      }
      safeName(name)
      assert.match(name, /\.(exe|dmg|zip|blockmap)$/i, `Unexpected release asset: ${name}`)
      const file = path.join(directory, name)
      assert.ok(fs.lstatSync(file).isFile(), `Expected a release file: ${name}`)
      assert.ok(!assets.has(name), `Colliding release asset: ${name}`)
      assets.set(name, file)
    }
    manifests.set(platform, info)
  }

  const macFiles = ['mac-x64', 'mac-arm64'].flatMap((platform) => manifests.get(platform).files)
    .sort((a, b) => Number(!a.url.endsWith('.zip')) - Number(!b.url.endsWith('.zip')) || Number(a.url.includes('arm64')) - Number(b.url.includes('arm64')) || a.url.localeCompare(b.url))
  const primary = macFiles.find((file) => file.url.endsWith('-x64.zip'))
  // electron-updater compares this with os.release(), which uses Darwin versions.
  const macMajor = Number(require('../package.json').build.mac.minimumSystemVersion.split('.')[0])
  const mac = { ...manifests.get('mac-x64'), files: macFiles, path: primary.url, sha512: primary.sha512, minimumSystemVersion: `${macMajor + 9}.0.0` }
  assert.equal(new Set(macFiles.map((file) => file.url)).size, macFiles.length, 'Mac updater file collision')
  if (fs.existsSync(destination)) assert.equal(fs.readdirSync(destination).length, 0, 'Release staging directory must be empty')
  fs.mkdirSync(destination, { recursive: true })
  for (const [name, file] of assets) fs.copyFileSync(file, path.join(destination, name))
  fs.writeFileSync(path.join(destination, 'latest.yml'), yaml.dump(manifests.get('windows-x64')))
  fs.writeFileSync(path.join(destination, 'latest-mac.yml'), yaml.dump(mac))
  console.log(`Verified ${version}: Windows x64, Mac x64 and Mac arm64; ${assets.size} assets with complete updater metadata.`)
  return { windows: manifests.get('windows-x64'), mac }
}

module.exports = { prepareRelease, checksum }
if (require.main === module) {
  const [, , source, destination] = process.argv
  assert.ok(source && destination, 'Usage: node scripts/prepare-release.cjs downloaded release-publish')
  prepareRelease(path.resolve(source), path.resolve(destination)).catch((error) => { console.error(error.message); process.exitCode = 1 })
}
