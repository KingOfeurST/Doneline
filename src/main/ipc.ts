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
  listArchivedTodos,
  runMaintenance,
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
  getSelfPersonId,
  setSelfPersonId,
  primaryPersonId,
  setPresence,
  listPresence,
  sendNudge,
  sendFocusInvite,
  pendingInvitesFor,
  markInviteSeen,
  acceptInvite,
  startCoFocus,
  activeInviteFor,
  recordFocusSession,
  focusStats,
  sharedFocusStreak,
  getDailyTarget,
  setDailyTarget,
  toggleReaction,
  listReactionsForTodo,
  reorderTodos,
  listActivity,
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
  // Fire-and-forget push so a local change reaches the shared workspace right
  // away (shrinks the last-write-wins conflict window from ~8s to near zero).
  const push = () => void cloudSync().catch(() => {})

  ipcMain.handle(CH.today, () => localDay())

  // People
  ipcMain.handle(CH.peopleList, () => listPeople())
  ipcMain.handle(CH.personCreate, (_e, input) => {
    const r = createPerson(input)
    push()
    return r
  })
  ipcMain.handle(CH.personUpdate, (_e, id, patch) => {
    const r = updatePerson(id, patch)
    push()
    return r
  })
  ipcMain.handle(CH.personDelete, (_e, id) => {
    deletePerson(id)
    push()
  })

  // Goals
  ipcMain.handle(CH.goalsList, (_e, opts) => listGoals(opts))
  ipcMain.handle(CH.goalCreate, (_e, input) => {
    const r = createGoal(input)
    push()
    return r
  })
  ipcMain.handle(CH.goalUpdate, (_e, id, patch) => {
    const r = updateGoal(id, patch)
    push()
    return r
  })
  ipcMain.handle(CH.goalDelete, (_e, id) => {
    deleteGoal(id)
    push()
  })

  // Todos
  ipcMain.handle(CH.todosList, (_e, opts) => listTodos(opts))
  ipcMain.handle(CH.todosToday, (_e, day?: string, personId?: string) =>
    listTodayTodos(day ?? localDay(), personId)
  )
  ipcMain.handle(CH.todosArchived, (_e, personId?: string) => listArchivedTodos(personId))
  ipcMain.handle(CH.maintenanceRun, () => runMaintenance())
  ipcMain.handle(CH.todoCreate, (_e, input) => {
    const r = createTodo(input)
    push()
    return r
  })
  ipcMain.handle(CH.todoUpdate, (_e, id, patch) => {
    const r = updateTodo(id, patch)
    push()
    return r
  })
  ipcMain.handle(CH.todoToggle, (_e, id, done?: boolean) => {
    const r = setTodoDone(id, done, getSelfPersonId() ?? primaryPersonId())
    push()
    return r
  })
  ipcMain.handle(CH.todoDelete, (_e, id) => {
    deleteTodo(id)
    push()
  })
  ipcMain.handle(CH.todoReorder, (_e, updates: { id: string; position: number }[]) => {
    reorderTodos(updates)
    push()
  })

  // Events
  ipcMain.handle(CH.eventsList, (_e, opts) => listEvents(opts))
  ipcMain.handle(CH.eventsDay, (_e, day?: string, personId?: string) =>
    listDayEvents(day ?? localDay(), personId)
  )
  ipcMain.handle(CH.eventCreate, async (_e, input) => {
    const ev = createEvent(input)
    push() // propagate to the shared workspace
    // Best-effort push to calendar; never block the UI on a network error.
    try {
      await pushEvent(ev.id)
    } catch (err) {
      console.error('[doneline] pushEvent failed:', err)
    }
    return ev
  })
  ipcMain.handle(CH.eventUpdate, (_e, id, patch) => {
    const r = updateEvent(id, patch)
    push()
    return r
  })
  ipcMain.handle(CH.eventDelete, (_e, id) => {
    deleteEvent(id)
    push()
  })

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

  // Presence & co-focus
  ipcMain.handle(CH.selfGet, () => getSelfPersonId() ?? primaryPersonId())
  ipcMain.handle(CH.selfRaw, () => getSelfPersonId()) // null if never explicitly set
  ipcMain.handle(CH.selfSet, (_e, personId: string) => {
    setSelfPersonId(personId)
    return true
  })
  ipcMain.handle(CH.presenceList, () => listPresence())
  ipcMain.handle(
    CH.presenceUpdate,
    async (_e, p: { status: 'focusing' | 'idle'; phase?: 'focus' | 'break' | null; task_title?: string | null; ends_at?: string | null }) => {
      const self = getSelfPersonId() ?? primaryPersonId()
      setPresence(self, p)
      await cloudSync().catch(() => {}) // push promptly so the friend sees it
      return true
    }
  )
  ipcMain.handle(CH.nudgeSend, async (_e, toPerson: string, message: string) => {
    const self = getSelfPersonId() ?? primaryPersonId()
    sendNudge(self, toPerson, message)
    await cloudSync().catch(() => {})
    return true
  })
  ipcMain.handle(CH.inviteSend, async (_e, toPerson: string, focusMin: number, breakMin: number) => {
    const self = getSelfPersonId() ?? primaryPersonId()
    sendFocusInvite(self, toPerson, focusMin, breakMin)
    await cloudSync().catch(() => {})
    return true
  })
  ipcMain.handle(CH.invitesPending, () => pendingInvitesFor(getSelfPersonId() ?? primaryPersonId()))
  ipcMain.handle(CH.inviteSeen, async (_e, id: string) => {
    markInviteSeen(id)
    await cloudSync().catch(() => {})
    return true
  })
  ipcMain.handle(CH.inviteAccept, async (_e, id: string) => {
    acceptInvite(id)
    await cloudSync().catch(() => {})
    return true
  })
  ipcMain.handle(CH.inviteStart, async (_e, id: string) => {
    const startedAt = startCoFocus(id)
    await cloudSync().catch(() => {})
    return startedAt
  })
  ipcMain.handle(CH.inviteActive, () => activeInviteFor(getSelfPersonId() ?? primaryPersonId()) ?? null)

  // Focus stats
  ipcMain.handle(
    CH.focusRecord,
    async (_e, input: { taskId?: string | null; durationSeconds: number; startedAt: string; endedAt: string }) => {
      recordFocusSession({ personId: getSelfPersonId() ?? primaryPersonId(), ...input })
      await cloudSync().catch(() => {})
      return true
    }
  )
  ipcMain.handle(CH.focusStats, (_e, personId?: string) =>
    focusStats(personId ?? getSelfPersonId() ?? primaryPersonId())
  )
  ipcMain.handle(CH.focusSharedStreak, (_e, personIds: string[]) => sharedFocusStreak(personIds))
  ipcMain.handle(CH.focusTargetGet, () => getDailyTarget())
  ipcMain.handle(CH.focusTargetSet, (_e, n: number) => {
    setDailyTarget(n)
    return true
  })

  // Reactions
  ipcMain.handle(CH.reactionsToggle, async (_e, todoId: string, emoji: string) => {
    const self = getSelfPersonId() ?? primaryPersonId()
    const added = toggleReaction(todoId, self, emoji)
    await cloudSync().catch(() => {})
    return added
  })
  ipcMain.handle(CH.reactionsList, (_e, todoId: string) => listReactionsForTodo(todoId))

  // Activity log
  ipcMain.handle(CH.activityList, (_e, limit?: number) => listActivity(limit))
}
