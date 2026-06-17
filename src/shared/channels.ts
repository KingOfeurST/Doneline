/** IPC channel names shared between the Electron main process and the preload. */
export const CH = {
  peopleList: 'people:list',
  personCreate: 'people:create',
  personUpdate: 'people:update',
  personDelete: 'people:delete',

  goalsList: 'goals:list',
  goalCreate: 'goals:create',
  goalUpdate: 'goals:update',
  goalDelete: 'goals:delete',

  todosList: 'todos:list',
  todosToday: 'todos:today',
  todosArchived: 'todos:archived',
  todoCreate: 'todos:create',
  todoUpdate: 'todos:update',
  todoToggle: 'todos:toggle',
  todoDelete: 'todos:delete',

  eventsList: 'events:list',
  eventsDay: 'events:day',
  eventCreate: 'events:create',
  eventUpdate: 'events:update',
  eventDelete: 'events:delete',

  calGetConfig: 'caldav:getConfig',
  calSetConfig: 'caldav:setConfig',
  calClear: 'caldav:clear',
  calTest: 'caldav:test',
  calSync: 'caldav:sync',

  workspaceStatus: 'workspace:status',
  workspaceConnect: 'workspace:connect',
  workspaceDisconnect: 'workspace:disconnect',
  workspaceSync: 'workspace:sync',
  workspaceMyCode: 'workspace:myCode',

  notifGet: 'notif:get',
  notifSet: 'notif:set',
  notifTest: 'notif:test',

  maintenanceRun: 'app:maintenance',
  toggleFullscreen: 'app:toggleFullscreen',

  presenceUpdate: 'presence:update',
  presenceList: 'presence:list',
  selfGet: 'presence:selfGet',
  selfSet: 'presence:selfSet',
  selfRaw: 'presence:selfRaw',
  nudgeSend: 'presence:nudge',
  inviteSend: 'presence:invite',
  invitesPending: 'presence:invitesPending',
  inviteSeen: 'presence:inviteSeen',
  inviteAccept: 'presence:inviteAccept',
  inviteStart: 'presence:inviteStart',
  inviteActive: 'presence:inviteActive',

  today: 'app:today'
} as const

/** Main → renderer push event fired after a background sync changes data. */
export const EVT = {
  workspaceChanged: 'workspace:changed'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
