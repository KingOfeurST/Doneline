import { getDb } from './db.js'

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
    return JSON.parse(raw) as CalDavConfig
  } catch {
    return null
  }
}

export function setCalDavConfig(personId: string, cfg: CalDavConfig): void {
  setSetting(calDavKey(personId), JSON.stringify(cfg))
}

export function clearCalDavConfig(personId: string): void {
  deleteSetting(calDavKey(personId))
}
