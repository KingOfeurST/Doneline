const assert = require('node:assert/strict')
const version = require('../package.json').version
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Release tag must match package.json')
}
console.log(`Release version: ${version}`)
