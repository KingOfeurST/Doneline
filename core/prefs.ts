import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths.js'

/**
 * Device-local app preferences (NOT synced to the shared workspace) — currently
 * just notification settings. Stored in `~/.doneline/prefs.json`.
 */
export interface NotifPrefs {
  enabled: boolean
  eventsEnabled: boolean
  eventLeadMin: number
  todosEnabled: boolean
  morningEnabled: boolean
  morningTime: string // "HH:MM"
}

export const DEFAULT_NOTIF_PREFS: NotifPrefs = {
  enabled: true,
  eventsEnabled: true,
  eventLeadMin: 10,
  todosEnabled: true,
  morningEnabled: true,
  morningTime: '08:00'
}

const prefsFile = () => path.join(dataDir(), 'prefs.json')

export function getNotifPrefs(): NotifPrefs {
  try {
    const raw = fs.readFileSync(prefsFile(), 'utf8')
    const parsed = JSON.parse(raw) as { notifications?: Partial<NotifPrefs> }
    return { ...DEFAULT_NOTIF_PREFS, ...(parsed.notifications ?? {}) }
  } catch {
    return { ...DEFAULT_NOTIF_PREFS }
  }
}

export function setNotifPrefs(prefs: NotifPrefs): void {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))
  } catch {
    /* new file */
  }
  const merged = { ...existing, notifications: { ...DEFAULT_NOTIF_PREFS, ...prefs } }
  fs.writeFileSync(prefsFile(), JSON.stringify(merged, null, 2), 'utf8')
}
