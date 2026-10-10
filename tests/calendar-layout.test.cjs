const assert = require('node:assert/strict')
const path = require('node:path')
const { buildSync } = require('esbuild')

const source = buildSync({
  entryPoints: [path.join(__dirname, '../src/renderer/src/lib/calendarLayout.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text
const compiled = { exports: {} }
new Function('module', 'exports', source)(compiled, compiled.exports)
const { localDay, nextDay, eventOverlapsDay, layoutTimedEvents } = compiled.exports
const originalZone = process.env.TZ
const event = (id, starts_at, ends_at) => ({ id, starts_at, ends_at })
const local = (day, hour, minute = 0) => {
  const date = localDay(day)
  date.setHours(hour, minute)
  return date.toISOString()
}

try {
  for (const timezone of ['UTC', 'Europe/Paris', 'America/Los_Angeles']) {
    process.env.TZ = timezone
    const day = localDay('2026-10-08')
    const midnightEnd = event('midnight', local('2026-10-07', 23), local('2026-10-08', 0))
    assert.equal(eventOverlapsDay(midnightEnd, day), false, `${timezone}: exclusive midnight end`)
    const overnight = event('overnight', local('2026-10-07', 23), local('2026-10-08', 2))
    const early = event('early', local('2026-10-08', 1), local('2026-10-08', 3))
    const late = event('late', local('2026-10-08', 23), local('2026-10-09', 1))
    const rows = layoutTimedEvents([late, early, overnight, midnightEnd], day)
    assert.equal(rows.length, 3)
    assert.equal(rows[0].event.id, 'overnight')
    assert.equal(rows[0].startMinute, 0)
    assert.equal(rows[0].endMinute, 120)
    assert.equal(rows[0].columns, 2)
    assert.equal(rows[1].column, 1)
    assert.equal(rows[2].startMinute, 1380)
    assert.equal(rows[2].endMinute, 1440)
    assert.equal(rows[2].columns, 1)

    const chain = layoutTimedEvents([
      event('a', local('2026-10-08', 9), local('2026-10-08', 10)),
      event('b', local('2026-10-08', 9, 30), local('2026-10-08', 10, 30)),
      event('c', local('2026-10-08', 10), local('2026-10-08', 11)),
      event('d', local('2026-10-08', 11), local('2026-10-08', 12))
    ], day)
    assert.deepEqual(chain.map((row) => row.columns), [2, 2, 2, 1], `${timezone}: overlapping chain shares columns`)
    assert.deepEqual(chain.map((row) => row.column), [0, 1, 0, 0])
    const short = layoutTimedEvents([
      event('short-a', local('2026-10-08', 9), local('2026-10-08', 9, 5)),
      event('short-b', local('2026-10-08', 9, 10), local('2026-10-08', 9, 15))
    ], day, 20)
    assert.deepEqual(short.map((row) => row.column), [0, 1], `${timezone}: short clickable blocks cannot cover adjacent events`)
  }
  process.env.TZ = 'Europe/Paris'
  assert.equal((nextDay(localDay('2026-03-29')) - localDay('2026-03-29')) / 3_600_000, 23)
  assert.equal((nextDay(localDay('2026-10-25')) - localDay('2026-10-25')) / 3_600_000, 25)
  const repeatedHour = layoutTimedEvents([event('fall-back', '2026-10-25T00:30:00.000Z', '2026-10-25T01:00:00.000Z')], localDay('2026-10-25'))
  assert.equal(repeatedHour[0].startMinute, 150)
  assert.equal(repeatedHour[0].endMinute, 180)
  console.log('Calendar layout checks passed (UTC, Paris, Los Angeles, DST, midnight boundaries, overlaps).')
} finally {
  if (originalZone === undefined) delete process.env.TZ
  else process.env.TZ = originalZone
}
