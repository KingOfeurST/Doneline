import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths.js'
import { getDb } from './db.js'

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
    return notificationValues(parsed.notifications)
  } catch {
    return { ...DEFAULT_NOTIF_PREFS }
  }
}

export function setNotifPrefs(prefs: NotifPrefs): void {
  if (!prefs || typeof prefs !== 'object') throw new Error('Invalid notification settings.')
  for (const key of ['enabled', 'eventsEnabled', 'todosEnabled', 'morningEnabled'] as const) {
    if (typeof prefs[key] !== 'boolean') throw new Error('Notification switches must be true or false.')
  }
  if (!Number.isFinite(prefs.eventLeadMin) || prefs.eventLeadMin < 1 || prefs.eventLeadMin > 120) {
    throw new Error('Event reminders must be between 1 and 120 minutes before the event.')
  }
  if (!validTime(prefs.morningTime)) throw new Error('Choose a valid morning time.')
  writeMerged({ notifications: notificationValues(prefs) })
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

/** Corrupt or old preference files must not disable scheduling accidentally. */
function notificationValues(value: unknown): NotifPrefs {
  const input = value && typeof value === 'object' ? value as Partial<NotifPrefs> : {}
  const result = { ...DEFAULT_NOTIF_PREFS }
  for (const key of ['enabled', 'eventsEnabled', 'todosEnabled', 'morningEnabled'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key]
  }
  if (typeof input.eventLeadMin === 'number' && Number.isFinite(input.eventLeadMin) && input.eventLeadMin >= 1 && input.eventLeadMin <= 120) {
    result.eventLeadMin = Math.round(input.eventLeadMin)
  }
  if (validTime(input.morningTime)) result.morningTime = input.morningTime
  return result
}

const DEFAULT_DAILY_TARGET = 4

/** Daily focus-session target (device-local). */
export function getDailyTarget(): number {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as { dailyTarget?: number }
    const n = parsed.dailyTarget
    return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.min(20, Math.round(n)) : DEFAULT_DAILY_TARGET
  } catch {
    return DEFAULT_DAILY_TARGET
  }
}

export function setDailyTarget(n: number): void {
  if (!Number.isFinite(n)) throw new Error('Choose a valid daily focus target.')
  writeMerged({ dailyTarget: Math.min(20, Math.max(1, Math.round(n))) })
}

/** Which workspace profile this device represents (for presence/nudges). */
export function getSelfPersonId(): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(prefsFile(), 'utf8')) as { selfPersonId?: string }
    const id = parsed.selfPersonId
    if (typeof id !== 'string' || !id || !getDb().prepare('SELECT 1 FROM people WHERE id = ?').get(id)) return null
    return id
  } catch {
    return null
  }
}

export function setSelfPersonId(personId: string): void {
  if (typeof personId !== 'string' || !getDb().prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) {
    throw new Error('Select an existing profile.')
  }
  writeMerged({ selfPersonId: personId })
}

function writeMerged(patch: Record<string, unknown>): void {
  let existing: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
  } catch {
    /* new file */
  }
  fs.writeFileSync(prefsFile(), JSON.stringify({ ...existing, ...patch }, null, 2), 'utf8')
}
