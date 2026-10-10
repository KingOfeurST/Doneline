import { contextBridge, ipcRenderer } from 'electron'
import { CH, EVT } from '../shared/channels.js'
import type { DonelineAPI, UpdateStatus, WorkspaceSyncStatus } from '../shared/api.js'

let prepareQuit: (() => Promise<void>) | null = null
ipcRenderer.on(EVT.prepareQuit, async (_event, requestId: unknown) => {
  if (typeof requestId !== 'string') return
  try {
    await prepareQuit?.()
    ipcRenderer.send(CH.quitReady, { requestId })
  } catch (error) {
    ipcRenderer.send(CH.quitReady, { requestId, error: error instanceof Error ? error.message : 'A note could not be saved.' })
  }
})

const api: DonelineAPI = {
  today: () => ipcRenderer.invoke(CH.today),
  platform: () => ipcRenderer.invoke(CH.appPlatform),

  lifecycle: {
    onPrepareQuit: (cb) => {
      prepareQuit = cb
      return () => { if (prepareQuit === cb) prepareQuit = null }
    }
  },

  notes: {
    get: (day, personId) => ipcRenderer.invoke(CH.notesGet, day, personId),
    set: (day, body, personId) => ipcRenderer.invoke(CH.notesSet, day, body, personId)
  },

  search: { query: (input) => ipcRenderer.invoke(CH.searchQuery, input) },
  data: {
    listBackups: () => ipcRenderer.invoke(CH.dataListBackups),
    createBackup: () => ipcRenderer.invoke(CH.dataCreateBackup),
    restoreBackup: (id) => ipcRenderer.invoke(CH.dataRestoreBackup, id)
  },
  trash: {
    list: (personId) => ipcRenderer.invoke(CH.trashList, personId),
    restore: (id) => ipcRenderer.invoke(CH.trashRestore, id)
  },

  people: {
    list: () => ipcRenderer.invoke(CH.peopleList),
    create: (input) => ipcRenderer.invoke(CH.personCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.personUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.personDelete, id)
  },

  goals: {
    list: (opts) => ipcRenderer.invoke(CH.goalsList, opts),
    create: (input) => ipcRenderer.invoke(CH.goalCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.goalUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.goalDelete, id)
  },

  todos: {
    list: (opts) => ipcRenderer.invoke(CH.todosList, opts),
    today: (day, personId) => ipcRenderer.invoke(CH.todosToday, day, personId),
    planned: (day, personId) => ipcRenderer.invoke(CH.todosPlanned, day, personId),
    archived: (personId) => ipcRenderer.invoke(CH.todosArchived, personId),
    create: (input) => ipcRenderer.invoke(CH.todoCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.todoUpdate, id, patch),
    toggle: (id, done) => ipcRenderer.invoke(CH.todoToggle, id, done),
    remove: (id) => ipcRenderer.invoke(CH.todoDelete, id),
    reorder: (updates) => ipcRenderer.invoke(CH.todoReorder, updates),
    templates: () => ipcRenderer.invoke(CH.todoTemplatesList),
    forGoal: (goalId) => ipcRenderer.invoke(CH.todosForGoal, goalId),
    removeTemplate: (id) => ipcRenderer.invoke(CH.todoTemplateDelete, id)
  },

  events: {
    seriesContext: (id) => ipcRenderer.invoke(CH.eventSeriesContext, id),
    updateScoped: (id, patch, scope) => ipcRenderer.invoke(CH.eventUpdateScoped, id, patch, scope),
    templates: (opts) => ipcRenderer.invoke(CH.eventTemplates, opts),
    list: (opts) => ipcRenderer.invoke(CH.eventsList, opts),
    day: (day, personId) => ipcRenderer.invoke(CH.eventsDay, day, personId),
    create: (input) => ipcRenderer.invoke(CH.eventCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.eventUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.eventDelete, id),
    removeSeries: (id) => ipcRenderer.invoke(CH.eventSeriesDelete, id)
  },

  items: {
    previewRemoval: (input) => ipcRenderer.invoke(CH.itemsPreviewRemoval, input),
    removeRange: (input) => ipcRenderer.invoke(CH.itemsRemoveRange, input)
  },

  caldav: {
    getConfig: (personId) => ipcRenderer.invoke(CH.calGetConfig, personId),
    setConfig: (personId, cfg) => ipcRenderer.invoke(CH.calSetConfig, personId, cfg),
    clear: (personId) => ipcRenderer.invoke(CH.calClear, personId),
    test: (cfg) => ipcRenderer.invoke(CH.calTest, cfg),
    sync: (personId) => ipcRenderer.invoke(CH.calSync, personId)
  },

  workspace: {
    status: () => ipcRenderer.invoke(CH.workspaceStatus),
    myCode: () => ipcRenderer.invoke(CH.workspaceMyCode),
    connect: (input) => ipcRenderer.invoke(CH.workspaceConnect, input),
    disconnect: () => ipcRenderer.invoke(CH.workspaceDisconnect),
    sync: () => ipcRenderer.invoke(CH.workspaceSync),
    syncStatus: () => ipcRenderer.invoke(CH.workspaceSyncStatus),
    onSyncStatus: (cb) => {
      const handler = (_event: Electron.IpcRendererEvent, status: WorkspaceSyncStatus) => cb(status)
      ipcRenderer.on(EVT.workspaceSyncStatus, handler)
      return () => { ipcRenderer.removeListener(EVT.workspaceSyncStatus, handler) }
    },
    onChanged: (cb) => {
      const handler = () => cb()
      ipcRenderer.on(EVT.workspaceChanged, handler)
      return () => ipcRenderer.removeListener(EVT.workspaceChanged, handler)
    }
  },

  notifications: {
    get: () => ipcRenderer.invoke(CH.notifGet),
    set: (prefs) => ipcRenderer.invoke(CH.notifSet, prefs),
    test: () => ipcRenderer.invoke(CH.notifTest)
  },

  maintenance: () => ipcRenderer.invoke(CH.maintenanceRun),
  toggleFullscreen: () => ipcRenderer.invoke(CH.toggleFullscreen),
  onTrayNewTodo: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('tray:new-todo', handler)
    return () => ipcRenderer.removeListener('tray:new-todo', handler)
  },

  updates: {
    version: () => ipcRenderer.invoke(CH.appVersion),
    status: () => ipcRenderer.invoke(CH.updateStatus),
    check: () => ipcRenderer.invoke(CH.updateCheck),
    install: () => ipcRenderer.invoke(CH.updateInstall),
    onStatus: (cb) => {
      const handler = (_e: unknown, s: UpdateStatus) => cb(s)
      ipcRenderer.on(EVT.updateStatus, handler)
      return () => ipcRenderer.removeListener(EVT.updateStatus, handler)
    }
  },

  focus: {
    record: (input) => ipcRenderer.invoke(CH.focusRecord, input),
    stats: (personId) => ipcRenderer.invoke(CH.focusStats, personId),
    sharedStreak: (personIds) => ipcRenderer.invoke(CH.focusSharedStreak, personIds),
    getTarget: () => ipcRenderer.invoke(CH.focusTargetGet),
    setTarget: (n) => ipcRenderer.invoke(CH.focusTargetSet, n),
    tray: (state) => ipcRenderer.send(CH.focusTray, state)
  },

  reactions: {
    toggle: (todoId, emoji) => ipcRenderer.invoke(CH.reactionsToggle, todoId, emoji),
    list: (todoId) => ipcRenderer.invoke(CH.reactionsList, todoId)
  },

  presence: {
    getSelf: () => ipcRenderer.invoke(CH.selfGet),
    getSelfRaw: () => ipcRenderer.invoke(CH.selfRaw),
    setSelf: (personId) => ipcRenderer.invoke(CH.selfSet, personId),
    list: () => ipcRenderer.invoke(CH.presenceList),
    update: (p) => ipcRenderer.invoke(CH.presenceUpdate, p),
    nudge: (toPerson, message, kind) => ipcRenderer.invoke(CH.nudgeSend, toPerson, message, kind),
    unseenNudges: () => ipcRenderer.invoke(CH.nudgesUnseen),
    markNudgeSeen: (id) => ipcRenderer.invoke(CH.nudgeSeen, id),
    nudgeWasSeen: (id) => ipcRenderer.invoke(CH.nudgeWasSeen, id),
    invite: (toPerson, focusMin, breakMin) => ipcRenderer.invoke(CH.inviteSend, toPerson, focusMin, breakMin),
    pendingInvites: () => ipcRenderer.invoke(CH.invitesPending),
    markInviteSeen: (id) => ipcRenderer.invoke(CH.inviteSeen, id),
    acceptInvite: (id) => ipcRenderer.invoke(CH.inviteAccept, id),
    startInvite: (id) => ipcRenderer.invoke(CH.inviteStart, id),
    activeInvite: () => ipcRenderer.invoke(CH.inviteActive)
  }
}

contextBridge.exposeInMainWorld('doneline', api)
