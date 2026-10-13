/** Local planning helpers shared by the MCP tools and their CLI client. */
import {
  activeDbPath, dataDir, getDb, getDailyNote, getEventSeriesContext,
  getPerson, getSelfPersonId, getTodo, getWorkspaceSyncStatus, listEvents,
  listGoals, listPeople, listTodos, localDay, parseLocalDate, calendarDayDifference,
  ensureTodoInstancesForRange, ensureEventInstancesForRange,
  ensureRemoteCalendarInstancesForRange, getCalDavConfig, previewRecurrence,
  setDailyNote, type CalEvent, type Recurrence, type TodoWithGoal
} from '../core/index.js'
import { version } from '../package.json'

/** Never expose the sync error's endpoint, request body, or credentials. */
export function syncSummary() {
  const { state, cloud, pending, lastSyncedAt } = getWorkspaceSyncStatus()
  return { state, cloud, pending, lastSyncedAt }
}

export function workspaceStatus(personId: string) {
  const now = new Date()
  const profiles = listPeople()
  return {
    name: 'doneline', version, day: localDay(now), now: now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utc_offset_minutes: -now.getTimezoneOffset(),
    profile: getPerson(personId) ?? null,
    selected_profile_id: getSelfPersonId(), profiles,
    database_path: activeDbPath(), data_directory: dataDir(), sync: syncSummary(),
    calendars: profiles.map(person => ({ person_id: person.id, connected: !!getCalDavConfig(person.id) }))
  }
}

export function requirePerson(personId: string, allowAll = false): void {
  if (allowAll && personId === 'all') return
  if (!getPerson(personId)) throw new Error('Select an existing profile.')
}

/** Calendar-day bounds are validated before generating any rows. */
export function boundedRange(fromDay: string, toDay: string) {
  const from = parseLocalDate(fromDay)
  const to = parseLocalDate(toDay)
  const days = calendarDayDifference(from, to) + 1
  if (days < 1) throw new Error('The range must end on or after it starts.')
  if (days > 366) throw new Error('Choose an instance range of 366 days or less.')
  return { from, to, days }
}

export function generateInstances(fromDay: string, toDay: string) {
  const { from, to } = boundedRange(fromDay, toDay)
  const exclusiveEnd = new Date(to); exclusiveEnd.setDate(exclusiveEnd.getDate() + 1)
  return getDb().transaction(() => ({
    todos: ensureTodoInstancesForRange(from, to),
    events: ensureEventInstancesForRange(from, to) + ensureRemoteCalendarInstancesForRange(from, exclusiveEnd)
  })).immediate()
}

function completedFor(todo: TodoWithGoal, personId: string): boolean {
  return todo.goal_shared === 1 && personId !== 'all'
    ? !!todo.done_by?.split(',').includes(personId)
    : !!todo.completed_at
}

function counts(todos: TodoWithGoal[], events: CalEvent[], personId: string) {
  return {
    todos: todos.length,
    open_todos: todos.filter(todo => !completedFor(todo, personId)).length,
    completed_todos: todos.filter(todo => completedFor(todo, personId)).length,
    events: events.length
  }
}

/** Snapshot the materialized local rows; generate=false is a pure read. */
export function planningSnapshot(fromDay: string, toDay: string, personId: string, generate: boolean) {
  requirePerson(personId, true)
  const { from, to } = boundedRange(fromDay, toDay)
  const generated = generate ? generateInstances(fromDay, toDay) : { todos: 0, events: 0 }
  const todos = listTodos({ includeCompleted: true, personId })
  // Passing date bounds to listEvents itself generates rows, so filter this
  // existing snapshot to honor the explicit generate_instances=false option.
  const events = listEvents({ personId })
  const days = []
  for (let date = new Date(from); date <= to; date.setDate(date.getDate() + 1)) {
    const start = new Date(date)
    const end = new Date(date); end.setDate(end.getDate() + 1)
    const inDay = (value: string) => new Date(value) >= start && new Date(value) < end
    const dayTodos = todos.filter(todo => todo.due_at ? inDay(todo.due_at) : !!todo.completed_at && inDay(todo.completed_at))
    const dayEvents = events.filter(event => new Date(event.starts_at) < end && new Date(event.ends_at) > start)
    days.push({ day: localDay(date), todos: dayTodos, events: dayEvents, counts: counts(dayTodos, dayEvents, personId) })
  }
  const backlog = {
    overdue: todos.filter(todo => !completedFor(todo, personId) && !!todo.due_at && new Date(todo.due_at) < from),
    undated: todos.filter(todo => !completedFor(todo, personId) && !todo.due_at)
  }
  const rangeTodos = [...new Map(days.flatMap(day => day.todos).map(todo => [todo.id, todo])).values()]
  const rangeEvents = [...new Map(days.flatMap(day => day.events).map(event => [event.id, event])).values()]
  return {
    from_day: fromDay, to_day: toDay, person_id: personId, days, backlog,
    counts: { ...counts(rangeTodos, rangeEvents, personId), overdue: backlog.overdue.length, undated: backlog.undated.length },
    goals: listGoals({ personId }), generated
  }
}

/** Read and append under SQLite's write lock, including across app processes. */
export function appendDailyNote(day: string, body: string, personId: string, separator = '\n') {
  parseLocalDate(day)
  requirePerson(personId)
  return getDb().transaction(() => {
    const current = getDailyNote(day, personId)
    return setDailyNote(day, current.body ? `${current.body}${separator}${body}` : body, personId)
  }).immediate()
}

export function recurrencePreview(input: {
  id?: string; kind?: 'todo' | 'event'; anchor_day?: string;
  repeat?: 'none' | 'daily' | 'weekly'; repeat_days?: number[];
  repeat_from?: string | null; repeat_until?: string | null; limit?: number
}) {
  let recurrence: Recurrence | null = null
  let anchor = input.anchor_day
  let templateId: string | undefined
  if (input.id) {
    if (!input.kind) throw new Error('Provide kind when previewing an existing repeat rule.')
    if (input.kind === 'event') {
      const context = getEventSeriesContext(input.id)
      if (!context) throw new Error('Event not found.')
      if (context.remote) {
        if (input.repeat !== undefined || input.repeat_days !== undefined || input.repeat_from !== undefined || input.repeat_until !== undefined)
          throw new Error('Change Apple Calendar repeat weekdays or date bounds in Apple Calendar.')
        return { id: input.id, kind: input.kind, remote: true, dates: context.remoteDates ?? [], total: null,
          hasMore: true, scopes: context.scopes, limitation: context.limitation }
      }
      recurrence = context.recurrence
      anchor ??= localDay(new Date((context.template ?? context.event).starts_at))
      templateId = context.template?.id
    } else {
      const item = getTodo(input.id)
      if (!item) throw new Error('Todo not found.')
      const template = item.recur_parent ? getTodo(item.recur_parent) : item
      if (template?.recurrence) recurrence = JSON.parse(template.recurrence) as Recurrence
      const created = template?.created_at
      const createdUtc = created && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(created) ? `${created.replace(' ', 'T')}Z` : created
      anchor ??= template?.due_at ? localDay(new Date(template.due_at)) : localDay(new Date(createdUtc ?? new Date().toISOString()))
      templateId = template?.id
    }
    if (!recurrence) throw new Error('This item has no repeat rule.')
  }
  anchor ??= input.repeat_from ?? localDay()
  parseLocalDate(anchor)
  if (input.repeat === 'none') return { recurrence: null, anchor_day: anchor, dates: [], total: 0, hasMore: false }
  const frequency = input.repeat ?? recurrence?.freq
  if (!frequency) throw new Error('Choose daily or weekly repeat, or provide an existing repeat-rule id.')
  const rule: Recurrence = { ...recurrence, freq: frequency }
  if (frequency === 'weekly') rule.days = input.repeat_days ?? recurrence?.days ?? []
  else delete rule.days
  if (input.repeat_from !== undefined) { if (input.repeat_from) rule.startDate = input.repeat_from; else delete rule.startDate }
  if (input.repeat_until !== undefined) { if (input.repeat_until) rule.endDate = input.repeat_until; else delete rule.endDate }
  return { id: templateId, kind: input.kind, anchor_day: anchor, recurrence: rule, ...previewRecurrence(rule, anchor, { limit: input.limit ?? 12 }) }
}

/** Counts document the permanent profile cascade before confirmation. */
export function profileDeletionPreview(id: string) {
  requirePerson(id)
  const db = getDb()
  const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { count: number }).count
  if (listPeople().length <= 1) throw new Error('Cannot delete the last profile.')
  return {
    person: getPerson(id), permanent: true,
    counts: {
      todos: count('SELECT COUNT(*) count FROM todos WHERE person_id = ? OR recur_parent IN (SELECT id FROM todos WHERE person_id = ?)', id, id),
      events: count('SELECT COUNT(*) count FROM events WHERE person_id = ? OR recur_parent IN (SELECT id FROM events WHERE person_id = ?)', id, id),
      goals: count('SELECT COUNT(*) count FROM goals WHERE person_id = ?', id),
      notes: count('SELECT COUNT(*) count FROM daily_notes WHERE person_id = ?', id),
      focus_sessions: count('SELECT COUNT(*) count FROM focus_sessions WHERE person_id = ?', id)
    }
  }
}
