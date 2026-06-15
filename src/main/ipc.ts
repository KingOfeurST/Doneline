import { ipcMain } from 'electron'
import { CH } from '../shared/channels.js'
import {
  listPeople,
  createPerson,
  updatePerson,
  deletePerson,
  listGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  listTodos,
  listTodayTodos,
  createTodo,
  updateTodo,
  setTodoDone,
  deleteTodo,
  listEvents,
  listDayEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getCalDavConfig,
  setCalDavConfig,
  clearCalDavConfig,
  testConnection,
  syncCalendar,
  pushEvent,
  localDay,
  getSyncConfig,
  setSyncConfig,
  clearSyncConfig,
  decodeConnectCode,
  encodeConnectCode,
  testWorkspace,
  reopenDb,
  cloudSync,
  isCloud,
  getNotifPrefs,
  setNotifPrefs,
  type CalDavConfig,
  type SyncConfig,
  type NotifPrefs
} from '../../core/index.js'
import { reloadNotifications, testNotification } from './notifications.js'

/**
 * Register every IPC handler. `onWorkspaceChange` lets the main process restart
 * its background-sync loop after the workspace connection is changed.
 */
export function registerIpc(onWorkspaceChange: () => void): void {
  ipcMain.handle(CH.today, () => localDay())

  // People
  ipcMain.handle(CH.peopleList, () => listPeople())
  ipcMain.handle(CH.personCreate, (_e, input) => createPerson(input))
  ipcMain.handle(CH.personUpdate, (_e, id, patch) => updatePerson(id, patch))
  ipcMain.handle(CH.personDelete, (_e, id) => deletePerson(id))

  // Goals
  ipcMain.handle(CH.goalsList, (_e, opts) => listGoals(opts))
  ipcMain.handle(CH.goalCreate, (_e, input) => createGoal(input))
  ipcMain.handle(CH.goalUpdate, (_e, id, patch) => updateGoal(id, patch))
  ipcMain.handle(CH.goalDelete, (_e, id) => deleteGoal(id))

  // Todos
  ipcMain.handle(CH.todosList, (_e, opts) => listTodos(opts))
  ipcMain.handle(CH.todosToday, (_e, day?: string, personId?: string) =>
    listTodayTodos(day ?? localDay(), personId)
  )
  ipcMain.handle(CH.todoCreate, (_e, input) => createTodo(input))
  ipcMain.handle(CH.todoUpdate, (_e, id, patch) => updateTodo(id, patch))
  ipcMain.handle(CH.todoToggle, (_e, id, done?: boolean) => setTodoDone(id, done))
  ipcMain.handle(CH.todoDelete, (_e, id) => deleteTodo(id))

  // Events
  ipcMain.handle(CH.eventsList, (_e, opts) => listEvents(opts))
  ipcMain.handle(CH.eventsDay, (_e, day?: string, personId?: string) =>
    listDayEvents(day ?? localDay(), personId)
  )
  ipcMain.handle(CH.eventCreate, async (_e, input) => {
    const ev = createEvent(input)
    // Best-effort push to calendar; never block the UI on a network error.
    try {
      await pushEvent(ev.id)
    } catch (err) {
      console.error('[doneline] pushEvent failed:', err)
    }
    return ev
  })
  ipcMain.handle(CH.eventUpdate, (_e, id, patch) => updateEvent(id, patch))
  ipcMain.handle(CH.eventDelete, (_e, id) => deleteEvent(id))

  // CalDAV (per person)
  ipcMain.handle(CH.calGetConfig, (_e, personId: string) => {
    const cfg = getCalDavConfig(personId)
    if (!cfg) return null
    // Never leak the password to the renderer.
    return { serverUrl: cfg.serverUrl, username: cfg.username, calendarName: cfg.calendarName }
  })
  ipcMain.handle(CH.calSetConfig, (_e, personId: string, cfg: CalDavConfig) => {
    setCalDavConfig(personId, cfg)
    return true
  })
  ipcMain.handle(CH.calClear, (_e, personId: string) => {
    clearCalDavConfig(personId)
    return true
  })
  ipcMain.handle(CH.calTest, (_e, cfg: CalDavConfig) => testConnection(cfg))
  ipcMain.handle(CH.calSync, (_e, personId: string) => syncCalendar(personId))

  // Cloud workspace
  ipcMain.handle(CH.workspaceStatus, () => {
    const cfg = getSyncConfig()
    return { cloud: isCloud(), syncUrl: cfg?.syncUrl ?? null }
  })
  ipcMain.handle(CH.workspaceMyCode, () => {
    const cfg = getSyncConfig()
    return cfg ? encodeConnectCode(cfg) : null
  })
  ipcMain.handle(CH.workspaceConnect, async (_e, input: { code?: string; syncUrl?: string; authToken?: string }) => {
    let cfg: SyncConfig | null = null
    if (input.code) cfg = decodeConnectCode(input.code)
    else if (input.syncUrl && input.authToken) cfg = { syncUrl: input.syncUrl, authToken: input.authToken }
    if (!cfg) throw new Error('Invalid connect code or missing URL/token.')
    await testWorkspace(cfg) // throws on bad credentials / unreachable
    setSyncConfig(cfg)
    await reopenDb()
    onWorkspaceChange()
    return { cloud: true, syncUrl: cfg.syncUrl, code: encodeConnectCode(cfg) }
  })
  ipcMain.handle(CH.workspaceDisconnect, async () => {
    clearSyncConfig()
    await reopenDb()
    onWorkspaceChange()
    return { cloud: false }
  })
  ipcMain.handle(CH.workspaceSync, async () => {
    const synced = await cloudSync()
    return { synced }
  })

  // Notifications
  ipcMain.handle(CH.notifGet, () => getNotifPrefs())
  ipcMain.handle(CH.notifSet, (_e, prefs: NotifPrefs) => {
    setNotifPrefs(prefs)
    reloadNotifications()
    return true
  })
  ipcMain.handle(CH.notifTest, () => {
    testNotification()
    return true
  })
}
