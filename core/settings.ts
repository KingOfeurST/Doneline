import { getDb } from './db.js'
import { getPerson } from './people.js'

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row ? row.value : null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

export function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
}

export interface CalDavConfig {
  serverUrl: string
  username: string
  password: string
  calendarUrl?: string
  calendarName?: string
}

// CalDAV is configured per person, so each profile connects their own calendar.
const calDavKey = (personId: string) => `caldav:${personId}`

export function getCalDavConfig(personId: string): CalDavConfig | null {
  const raw = getSetting(calDavKey(personId))
  if (!raw) return null
  try {
    return validCalDavConfig(JSON.parse(raw))
  } catch {
    return null
  }
}

export function setCalDavConfig(personId: string, cfg: CalDavConfig): void {
  if (!getPerson(personId)) throw new Error('Select an existing profile.')
  const next = validCalDavConfig(cfg)
  const previous = getCalDavConfig(personId)
  const replacing = previous && (previous.serverUrl !== next.serverUrl || previous.username !== next.username ||
    (previous.calendarUrl && previous.calendarUrl !== next.calendarUrl))
  const db = getDb()
  db.transaction(() => {
    if (replacing) {
      // These clean snapshots still exist in the old remote calendar. Pending
      // edits/deletions retain their old URL and never move into the new account.
      db.prepare("DELETE FROM events WHERE person_id = ? AND source = 'caldav' AND calendar_dirty = 0").run(personId)
      db.prepare('DELETE FROM calendar_resources WHERE person_id = ?').run(personId)
    }
    setSetting(calDavKey(personId), JSON.stringify(next))
  }).immediate()
}

function validCalDavConfig(value: unknown): CalDavConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid calendar connection settings.')
  const input = value as Partial<CalDavConfig>
  const serverUrl = typeof input.serverUrl === 'string' && input.serverUrl.trim() ? input.serverUrl.trim() : 'https://caldav.icloud.com'
  if (typeof input.username !== 'string' || !input.username.trim() || typeof input.password !== 'string' || !input.password) {
    throw new Error('Enter your calendar account and app-specific password.')
  }
  function validUrl(url: string): string {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error('Enter a valid calendar URL.') }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Calendar URLs must use HTTPS or HTTP.')
    return parsed.href
  }
  return { serverUrl: validUrl(serverUrl), username: input.username.trim(), password: input.password,
    ...(typeof input.calendarUrl === 'string' && input.calendarUrl ? { calendarUrl: validUrl(input.calendarUrl) } : {}),
    ...(typeof input.calendarName === 'string' ? { calendarName: input.calendarName } : {}) }
}

export function clearCalDavConfig(personId: string): void {
  deleteSetting(calDavKey(personId))
}
