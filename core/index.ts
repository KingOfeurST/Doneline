export * from './types.js'
export * from './people.js'
export * from './goals.js'
export * from './recurrence.js'
export * from './presence.js'
export * from './focusStats.js'
export * from './todos.js'
export * from './events.js'
export * from './settings.js'
export * from './caldav.js'
export * from './reactions.js'
export * from './activityLog.js'
export {
  getSyncConfig,
  setSyncConfig,
  clearSyncConfig,
  encodeConnectCode,
  decodeConnectCode,
  type SyncConfig
} from './config.js'
export {
  getNotifPrefs,
  setNotifPrefs,
  getSelfPersonId,
  setSelfPersonId,
  getDailyTarget,
  setDailyTarget,
  DEFAULT_NOTIF_PREFS,
  type NotifPrefs
} from './prefs.js'
export { getDb, closeDb, initDb, reopenDb, cloudSync, isCloud, testWorkspace } from './db.js'
export { dataDir, dbPath } from './paths.js'

/** Local YYYY-MM-DD for "today" (or a given date). */
export function localDay(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}
