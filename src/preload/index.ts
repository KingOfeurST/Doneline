import { contextBridge, ipcRenderer } from 'electron'
import { CH, EVT } from '../shared/channels.js'
import type { DonelineAPI } from '../shared/api.js'

const api: DonelineAPI = {
  today: () => ipcRenderer.invoke(CH.today),

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
    archived: (personId) => ipcRenderer.invoke(CH.todosArchived, personId),
    create: (input) => ipcRenderer.invoke(CH.todoCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.todoUpdate, id, patch),
    toggle: (id, done) => ipcRenderer.invoke(CH.todoToggle, id, done),
    remove: (id) => ipcRenderer.invoke(CH.todoDelete, id)
  },

  events: {
    list: (opts) => ipcRenderer.invoke(CH.eventsList, opts),
    day: (day, personId) => ipcRenderer.invoke(CH.eventsDay, day, personId),
    create: (input) => ipcRenderer.invoke(CH.eventCreate, input),
    update: (id, patch) => ipcRenderer.invoke(CH.eventUpdate, id, patch),
    remove: (id) => ipcRenderer.invoke(CH.eventDelete, id)
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

  presence: {
    getSelf: () => ipcRenderer.invoke(CH.selfGet),
    getSelfRaw: () => ipcRenderer.invoke(CH.selfRaw),
    setSelf: (personId) => ipcRenderer.invoke(CH.selfSet, personId),
    list: () => ipcRenderer.invoke(CH.presenceList),
    update: (p) => ipcRenderer.invoke(CH.presenceUpdate, p),
    nudge: (toPerson, message) => ipcRenderer.invoke(CH.nudgeSend, toPerson, message),
    invite: (toPerson, focusMin, breakMin) => ipcRenderer.invoke(CH.inviteSend, toPerson, focusMin, breakMin),
    pendingInvites: () => ipcRenderer.invoke(CH.invitesPending),
    markInviteSeen: (id) => ipcRenderer.invoke(CH.inviteSeen, id),
    acceptInvite: (id) => ipcRenderer.invoke(CH.inviteAccept, id),
    startInvite: (id) => ipcRenderer.invoke(CH.inviteStart, id),
    activeInvite: () => ipcRenderer.invoke(CH.inviteActive)
  }
}

contextBridge.exposeInMainWorld('doneline', api)
