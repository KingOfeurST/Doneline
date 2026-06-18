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
  writeMerged({ notifications: { ...DEFAULT_NOTIF_PREFS, ...prefs } })
}

const DEFAULT_DAILY_TARGET = 4

/** Daily focus-session target (device-local). */
export function getDailyTarget(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as { dailyTarget?: number }
    const n = Number(parsed.dailyTarget)
    return n >= 1 ? Math.min(20, Math.round(n)) : DEFAULT_DAILY_TARGET
  } catch {
    return DEFAULT_DAILY_TARGET
  }
}

export function setDailyTarget(n: number): void {
  writeMerged({ dailyTarget: Math.min(20, Math.max(1, Math.round(n))) })
}

/** Which workspace profile this device represents (for presence/nudges). */
export function getSelfPersonId(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as { selfPersonId?: string }
    return parsed.selfPersonId ?? null
  } catch {
    return null
  }
}

export function setSelfPersonId(personId: string): void {
  writeMerged({ selfPersonId: personId })
}

function writeMerged(patch: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))
  } catch {
    /* new file */
  }
  fs.writeFileSync(prefsFile(), JSON.stringify({ ...existing, ...patch }, null, 2), 'utf8')
}
