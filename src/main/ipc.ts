import { ipcMain, BrowserWindow } from 'electron'
import { CH, EVT } from '../shared/channels.js'
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
  ensureTodoInstancesForDate,
  createTodo,
  updateTodo,
  setTodoDone,
  deleteTodo,
  listEvents,
  listEventTemplates,
  getEvent,
  previewRemoval,
  removeRange,
  listDayEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getCalDavConfig,
  setCalDavConfig,
  clearCalDavConfig,
  testConnection,
  syncCalendar,
  queueCalendarSync,
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
  unseenNudgesFor,
  markNudgeSeen,
  nudgeWasSeen,
  getDailyNote,
  setDailyNote,
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
  listTodoTemplates,
  listTodosForGoal,
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
  const changed = () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EVT.workspaceChanged)
  }
  const push = () => {
    changed()
    void cloudSync().then((synced) => { if (synced) changed() }).catch(() => {})
  }

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
  ipcMain.handle(CH.todosToday, (_e, day?: string, personId?: string) => {
    const date = day ?? localDay()
    ensureTodoInstancesForDate(date)
    return listTodayTodos(date, personId)
  })
  ipcMain.handle(CH.todosArchived, (_e, personId?: string) => listArchivedTodos(personId))
  ipcMain.handle(CH.maintenanceRun, () => { const result = runMaintenance(); push(); return result })
  ipcMain.handle(CH.todoCreate, (_e, input) => {
    const r = createTodo(input)
    if (r.recurrence) ensureTodoInstancesForDate(localDay())
    push()
    return r
  })
  ipcMain.handle(CH.todoUpdate, (_e, id, patch) => {
    const r = updateTodo(id, patch)
    if (r?.recurrence) ensureTodoInstancesForDate(localDay())
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
  ipcMain.handle(CH.todoTemplatesList, () => listTodoTemplates())
  ipcMain.handle(CH.todosForGoal, (_e, goalId: string) => listTodosForGoal(goalId))
  ipcMain.handle(CH.todoTemplateDelete, (_e, id: string) => {
    deleteTodo(id)
    push()
  })

  // Events
  ipcMain.handle(CH.eventTemplates, (_e, opts) => listEventTemplates(opts))
  ipcMain.handle(CH.itemsPreviewRemoval, (_e, input) => previewRemoval(input))
  ipcMain.handle(CH.itemsRemoveRange, (_e, input) => {
    const result = removeRange(input)
    push()
    queueCalendarSync(undefined, push)
    return result
  })
  ipcMain.handle(CH.eventSeriesDelete, (_e, id: string) => {
    const series = getEvent(id)
    if (!series?.recurrence) throw new Error('This repeat rule no longer exists.')
    deleteEvent(id)
    push()
    queueCalendarSync(series.person_id, push)
  })
  ipcMain.handle(CH.eventsList, (_e, opts) => listEvents(opts))
  ipcMain.handle(CH.eventsDay, (_e, day?: string, personId?: string) =>
    listDayEvents(day ?? localDay(), personId)
  )
  ipcMain.handle(CH.eventCreate, (_e, input) => {
    const ev = createEvent(input)
    push() // propagate to the shared workspace
    queueCalendarSync(ev.person_id, push)
    return ev
  })
  ipcMain.handle(CH.eventUpdate, (_e, id, patch) => {
    const previous = getEvent(id)
    const r = updateEvent(id, patch)
    push()
    if (r) queueCalendarSync(r.person_id, push)
    if (previous && previous.person_id !== r?.person_id) queueCalendarSync(previous.person_id, push)
    return r
  })
  ipcMain.handle(CH.eventDelete, (_e, id) => {
    const event = getEvent(id)
    deleteEvent(id)
    push()
    if (event) queueCalendarSync(event.person_id, push)
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
  ipcMain.handle(CH.calSync, async (_e, personId: string) => {
    const result = await syncCalendar(personId)
    push()
    return result
  })

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
    changed()
    return { cloud: true, syncUrl: cfg.syncUrl, code: encodeConnectCode(cfg) }
  })
  ipcMain.handle(CH.workspaceDisconnect, async () => {
    clearSyncConfig()
    await reopenDb()
    onWorkspaceChange()
    changed()
    return { cloud: false }
  })
  ipcMain.handle(CH.workspaceSync, async () => {
    const synced = await cloudSync()
    if (synced) changed()
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
    const previous = getSelfPersonId() ?? primaryPersonId()
    setSelfPersonId(personId)
    if (previous !== personId) setPresence(previous, { status: 'idle' })
    push()
    return true
  })
  ipcMain.handle(CH.presenceList, () => listPresence())
  ipcMain.handle(
    CH.presenceUpdate,
    (_e, p: { status: 'focusing' | 'idle'; phase?: 'focus' | 'break' | null; task_title?: string | null; ends_at?: string | null }) => {
      const self = getSelfPersonId() ?? primaryPersonId()
      setPresence(self, p)
      void cloudSync().catch(() => {})
      return true
    }
  )
  ipcMain.handle(
    CH.nudgeSend,
    (_e, toPerson: string, message: string, kind: 'message' | 'buzz' = 'message') => {
      const self = getSelfPersonId() ?? primaryPersonId()
      const n = sendNudge(self, toPerson, message, kind)
      push()
      return n
    }
  )
  ipcMain.handle(CH.nudgesUnseen, () =>
    unseenNudgesFor(getSelfPersonId() ?? primaryPersonId())
  )
  ipcMain.handle(CH.nudgeSeen, (_e, id: string) => {
    markNudgeSeen(id)
    push()
    return true
  })
  ipcMain.handle(CH.nudgeWasSeen, (_e, id: string) => nudgeWasSeen(id))

  // Daily note
  ipcMain.handle(CH.notesGet, (_e, day: string, personId?: string) =>
    getDailyNote(day, personId ?? (getSelfPersonId() ?? primaryPersonId()))
  )
  ipcMain.handle(CH.notesSet, (_e, day: string, body: string, personId?: string) => {
    const n = setDailyNote(day, body, personId ?? (getSelfPersonId() ?? primaryPersonId()))
    push()
    return n
  })
  ipcMain.handle(CH.inviteSend, (_e, toPerson: string, focusMin: number, breakMin: number) => {
    const self = getSelfPersonId() ?? primaryPersonId()
    sendFocusInvite(self, toPerson, focusMin, breakMin)
    push()
    return true
  })
  ipcMain.handle(CH.invitesPending, () => pendingInvitesFor(getSelfPersonId() ?? primaryPersonId()))
  ipcMain.handle(CH.inviteSeen, (_e, id: string) => {
    markInviteSeen(id)
    push()
    return true
  })
  ipcMain.handle(CH.inviteAccept, (_e, id: string) => {
    acceptInvite(id)
    push()
    return true
  })
  ipcMain.handle(CH.inviteStart, (_e, id: string) => {
    const startedAt = startCoFocus(id)
    push()
    return startedAt
  })
  ipcMain.handle(CH.inviteActive, () => activeInviteFor(getSelfPersonId() ?? primaryPersonId()) ?? null)

  // Focus stats
  ipcMain.handle(
    CH.focusRecord,
    (_e, input: { personId?: string; taskId?: string | null; durationSeconds: number; startedAt: string; endedAt: string }) => {
      recordFocusSession({ ...input, personId: input.personId ?? getSelfPersonId() ?? primaryPersonId() })
      push()
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
  ipcMain.handle(CH.reactionsToggle, (_e, todoId: string, emoji: string) => {
    const self = getSelfPersonId() ?? primaryPersonId()
    const added = toggleReaction(todoId, self, emoji)
    push()
    return added
  })
  ipcMain.handle(CH.reactionsList, (_e, todoId: string) => listReactionsForTodo(todoId))
}
