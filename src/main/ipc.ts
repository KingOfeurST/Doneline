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
import { registerSearchHandlers } from './searchHandlers.js'
import { listPlannedTodos } from '../../core/todos.js'
import { ensureTodoInstancesForRange } from '../../core/recurrence.js'
import { getWorkspaceSyncStatus, onWorkspaceSyncStatus } from '../../core/db.js'
import { createBackup, listBackups, restoreBackup } from '../../core/backups.js'
import { listTrash, restoreTrash } from '../../core/trash.js'
import { getEventSeriesContext, updateEventSeries, type EventEditPatch, type EventEditScope } from '../../core/eventSeries.js'
import { withCalendarSyncPaused } from '../../core/caldav.js'

/**
 * Register every IPC handler. `onWorkspaceChange` lets the main process restart
 * its background-sync loop after the workspace connection is changed.
 */
export function registerIpc(onWorkspaceChange: () => void): void {
  let dataTransition = false
  const stableWorkspace = () => {
    if (dataTransition) throw new Error('The workspace is being changed or restored. Please retry when it finishes.')
  }
  const transition = async <T>(operation: () => Promise<T>): Promise<T> => {
    stableWorkspace()
    dataTransition = true
    try { return await operation() }
    finally { dataTransition = false }
  }
  // Prevent renderer calls from using a database in the middle of a workspace
  // change or restore. Failed note writes remain pending for retry in the UI.
  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => {
      stableWorkspace()
      return listener(event, ...args)
    })
  }
  registerSearchHandlers({ handle })
  handle(CH.workspaceSyncStatus, () => getWorkspaceSyncStatus())
  onWorkspaceSyncStatus((status) => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send(EVT.workspaceSyncStatus, status)
  })
  // Fire-and-forget push so a local change reaches the shared workspace right
  // away (shrinks the last-write-wins conflict window from ~8s to near zero).
  const changed = () => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(EVT.workspaceChanged)
  }
  const push = () => {
    changed()
    void cloudSync().then((synced) => { if (synced) changed() }).catch(() => {})
  }

  handle(CH.today, () => localDay())

  // People
  handle(CH.peopleList, () => listPeople())
  handle(CH.personCreate, (_e, input) => {
    const r = createPerson(input)
    push()
    return r
  })
  handle(CH.personUpdate, (_e, id, patch) => {
    const r = updatePerson(id, patch)
    push()
    return r
  })
  handle(CH.personDelete, (_e, id) => {
    deletePerson(id)
    push()
  })

  // Goals
  handle(CH.goalsList, (_e, opts) => listGoals(opts))
  handle(CH.goalCreate, (_e, input) => {
    const r = createGoal(input)
    push()
    return r
  })
  handle(CH.goalUpdate, (_e, id, patch) => {
    const r = updateGoal(id, patch)
    push()
    return r
  })
  handle(CH.goalDelete, (_e, id) => {
    deleteGoal(id)
    push()
  })

  // Todos
  handle(CH.todosList, (_e, opts) => listTodos(opts))
  handle(CH.todosToday, (_e, day?: string, personId?: string) => {
    const date = day ?? localDay()
    ensureTodoInstancesForDate(date)
    return listTodayTodos(date, personId)
  })
  handle(CH.todosArchived, (_e, personId?: string) => listArchivedTodos(personId))
  handle(CH.todosPlanned, (_e, day?: string, personId?: string) => {
    const date = day ?? localDay()
    const until = new Date(`${date}T12:00:00`)
    until.setDate(until.getDate() + 30)
    ensureTodoInstancesForRange(date, localDay(until))
    return listPlannedTodos(date, personId)
  })
  handle(CH.maintenanceRun, () => { const result = runMaintenance(); push(); return result })
  handle(CH.todoCreate, (_e, input) => {
    const r = createTodo(input)
    if (r.recurrence) ensureTodoInstancesForDate(localDay())
    push()
    return r
  })
  handle(CH.todoUpdate, (_e, id, patch) => {
    const r = updateTodo(id, patch)
    if (r?.recurrence) ensureTodoInstancesForDate(localDay())
    push()
    return r
  })
  handle(CH.todoToggle, (_e, id, done?: boolean) => {
    const r = setTodoDone(id, done, getSelfPersonId() ?? primaryPersonId())
    push()
    return r
  })
  handle(CH.todoDelete, (_e, id) => {
    const trashId = deleteTodo(id)
    push()
    return { trashId }
  })
  handle(CH.todoReorder, (_e, updates: { id: string; position: number }[]) => {
    reorderTodos(updates)
    push()
  })
  handle(CH.todoTemplatesList, () => listTodoTemplates())
  handle(CH.todosForGoal, (_e, goalId: string) => listTodosForGoal(goalId))
  handle(CH.todoTemplateDelete, (_e, id: string) => {
    const trashId = deleteTodo(id)
    push()
    return { trashId }
  })

  // Events
  handle(CH.eventSeriesContext, (_e, id: string) => getEventSeriesContext(id))
  handle(CH.eventUpdateScoped, (_e, id: string, patch: EventEditPatch, scope: EventEditScope) => {
    const previous = getEvent(id)
    const result = updateEventSeries(id, patch, scope)
    push()
    if (result) queueCalendarSync(result.person_id, push)
    if (previous && previous.person_id !== result?.person_id) queueCalendarSync(previous.person_id, push)
    return result
  })
  handle(CH.dataListBackups, () => listBackups())
  handle(CH.dataCreateBackup, () => { stableWorkspace(); return createBackup() })
  handle(CH.dataRestoreBackup, (_e, id: string) => transition(async () => {
    const result = await withCalendarSyncPaused(() => restoreBackup(id))
    push()
    queueCalendarSync(undefined, push)
    return result
  }))
  handle(CH.trashList, (_e, personId?: string) => listTrash(personId))
  handle(CH.trashRestore, (_e, id: string) => {
    stableWorkspace()
    const result = restoreTrash(id)
    push()
    queueCalendarSync(result.personId, push)
    return result
  })
  handle(CH.eventTemplates, (_e, opts) => listEventTemplates(opts))
  handle(CH.itemsPreviewRemoval, (_e, input) => previewRemoval(input))
  handle(CH.itemsRemoveRange, (_e, input) => {
    const result = removeRange(input)
    push()
    queueCalendarSync(undefined, push)
    return result
  })
  handle(CH.eventSeriesDelete, (_e, id: string) => {
    const series = getEvent(id)
    if (!series?.recurrence) throw new Error('This repeat rule no longer exists.')
    const trashId = deleteEvent(id)
    push()
    queueCalendarSync(series.person_id, push)
    return { trashId }
  })
  handle(CH.eventsList, (_e, opts) => listEvents(opts))
  handle(CH.eventsDay, (_e, day?: string, personId?: string) =>
    listDayEvents(day ?? localDay(), personId)
  )
  handle(CH.eventCreate, (_e, input) => {
    const ev = createEvent(input)
    push() // propagate to the shared workspace
    queueCalendarSync(ev.person_id, push)
    return ev
  })
  handle(CH.eventUpdate, (_e, id, patch) => {
    const previous = getEvent(id)
    const r = updateEvent(id, patch)
    push()
    if (r) queueCalendarSync(r.person_id, push)
    if (previous && previous.person_id !== r?.person_id) queueCalendarSync(previous.person_id, push)
    return r
  })
  handle(CH.eventDelete, (_e, id) => {
    const event = getEvent(id)
    const trashId = deleteEvent(id)
    push()
    if (event) queueCalendarSync(event.person_id, push)
    return { trashId }
  })

  // CalDAV (per person)
  handle(CH.calGetConfig, (_e, personId: string) => {
    const cfg = getCalDavConfig(personId)
    if (!cfg) return null
    // Never leak the password to the renderer.
    return { serverUrl: cfg.serverUrl, username: cfg.username, calendarName: cfg.calendarName }
  })
  handle(CH.calSetConfig, (_e, personId: string, cfg: CalDavConfig) => {
    setCalDavConfig(personId, cfg)
    return true
  })
  handle(CH.calClear, (_e, personId: string) => {
    clearCalDavConfig(personId)
    return true
  })
  handle(CH.calTest, (_e, cfg: CalDavConfig) => testConnection(cfg))
  handle(CH.calSync, async (_e, personId: string) => {
    const result = await syncCalendar(personId)
    push()
    return result
  })

  // Cloud workspace
  handle(CH.workspaceStatus, () => {
    const cfg = getSyncConfig()
    return { cloud: isCloud(), syncUrl: cfg?.syncUrl ?? null }
  })
  handle(CH.workspaceMyCode, () => {
    const cfg = getSyncConfig()
    return cfg ? encodeConnectCode(cfg) : null
  })
  handle(CH.workspaceConnect, (_e, input: { code?: string; syncUrl?: string; authToken?: string }) => transition(async () => {
    let cfg: SyncConfig | null = null
    if (input.code) cfg = decodeConnectCode(input.code)
    else if (input.syncUrl && input.authToken) cfg = { syncUrl: input.syncUrl, authToken: input.authToken }
    if (!cfg) throw new Error('Invalid connect code or missing URL/token.')
    await testWorkspace(cfg) // throws on bad credentials / unreachable
    const previous = getSyncConfig()
    try { await withCalendarSyncPaused(async () => { setSyncConfig(cfg); await reopenDb() }) }
    catch (error) {
      if (previous) setSyncConfig(previous)
      else clearSyncConfig()
      await withCalendarSyncPaused(() => reopenDb())
      throw error
    }
    onWorkspaceChange()
    changed()
    return { cloud: true, syncUrl: cfg.syncUrl, code: encodeConnectCode(cfg) }
  }))
  handle(CH.workspaceDisconnect, () => transition(async () => {
    await withCalendarSyncPaused(async () => { clearSyncConfig(); await reopenDb() })
    onWorkspaceChange()
    changed()
    return { cloud: false }
  }))
  handle(CH.workspaceSync, async () => {
    const synced = await cloudSync()
    if (synced) changed()
    return { synced }
  })

  // Notifications
  handle(CH.notifGet, () => getNotifPrefs())
  handle(CH.notifSet, (_e, prefs: NotifPrefs) => {
    setNotifPrefs(prefs)
    reloadNotifications()
    return true
  })
  handle(CH.notifTest, () => {
    testNotification()
    return true
  })

  // Presence & co-focus
  handle(CH.selfGet, () => getSelfPersonId() ?? primaryPersonId())
  handle(CH.selfRaw, () => getSelfPersonId()) // null if never explicitly set
  handle(CH.selfSet, (_e, personId: string) => {
    const previous = getSelfPersonId() ?? primaryPersonId()
    setSelfPersonId(personId)
    if (previous !== personId) setPresence(previous, { status: 'idle' })
    push()
    return true
  })
  handle(CH.presenceList, () => listPresence())
  handle(
    CH.presenceUpdate,
    (_e, p: { status: 'focusing' | 'idle'; phase?: 'focus' | 'break' | null; task_title?: string | null; ends_at?: string | null }) => {
      const self = getSelfPersonId() ?? primaryPersonId()
      setPresence(self, p)
      void cloudSync().catch(() => {})
      return true
    }
  )
  handle(
    CH.nudgeSend,
    (_e, toPerson: string, message: string, kind: 'message' | 'buzz' = 'message') => {
      const self = getSelfPersonId() ?? primaryPersonId()
      const n = sendNudge(self, toPerson, message, kind)
      push()
      return n
    }
  )
  handle(CH.nudgesUnseen, () =>
    unseenNudgesFor(getSelfPersonId() ?? primaryPersonId())
  )
  handle(CH.nudgeSeen, (_e, id: string) => {
    markNudgeSeen(id)
    push()
    return true
  })
  handle(CH.nudgeWasSeen, (_e, id: string) => nudgeWasSeen(id))

  // Daily note
  handle(CH.notesGet, (_e, day: string, personId?: string) =>
    getDailyNote(day, personId ?? (getSelfPersonId() ?? primaryPersonId()))
  )
  handle(CH.notesSet, (_e, day: string, body: string, personId?: string) => {
    const n = setDailyNote(day, body, personId ?? (getSelfPersonId() ?? primaryPersonId()))
    push()
    return n
  })
  handle(CH.inviteSend, (_e, toPerson: string, focusMin: number, breakMin: number) => {
    const self = getSelfPersonId() ?? primaryPersonId()
    sendFocusInvite(self, toPerson, focusMin, breakMin)
    push()
    return true
  })
  handle(CH.invitesPending, () => pendingInvitesFor(getSelfPersonId() ?? primaryPersonId()))
  handle(CH.inviteSeen, (_e, id: string) => {
    markInviteSeen(id)
    push()
    return true
  })
  handle(CH.inviteAccept, (_e, id: string) => {
    acceptInvite(id)
    push()
    return true
  })
  handle(CH.inviteStart, (_e, id: string) => {
    const startedAt = startCoFocus(id)
    push()
    return startedAt
  })
  handle(CH.inviteActive, () => activeInviteFor(getSelfPersonId() ?? primaryPersonId()) ?? null)

  // Focus stats
  handle(
    CH.focusRecord,
    (_e, input: { personId?: string; taskId?: string | null; durationSeconds: number; startedAt: string; endedAt: string }) => {
      recordFocusSession({ ...input, personId: input.personId ?? getSelfPersonId() ?? primaryPersonId() })
      push()
      return true
    }
  )
  handle(CH.focusStats, (_e, personId?: string) =>
    focusStats(personId ?? getSelfPersonId() ?? primaryPersonId())
  )
  handle(CH.focusSharedStreak, (_e, personIds: string[]) => sharedFocusStreak(personIds))
  handle(CH.focusTargetGet, () => getDailyTarget())
  handle(CH.focusTargetSet, (_e, n: number) => {
    setDailyTarget(n)
    return true
  })

  // Reactions
  handle(CH.reactionsToggle, (_e, todoId: string, emoji: string) => {
    const self = getSelfPersonId() ?? primaryPersonId()
    const added = toggleReaction(todoId, self, emoji)
    push()
    return added
  })
  handle(CH.reactionsList, (_e, todoId: string) => listReactionsForTodo(todoId))
}
