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

  today: 'app:today'
} as const

/** Main → renderer push event fired after a background sync changes data. */
export const EVT = {
  workspaceChanged: 'workspace:changed'
} as const

export type Channel = (typeof CH)[keyof typeof CH]
