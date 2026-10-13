#!/usr/bin/env node
/**
 * Doneline MCP server.
 *
 * Exposes Chris's tasks, goals and calendar events to Claude over the same local
 * SQLite database the desktop app uses. Run with: `npm run mcp`.
 *
 * Add to Claude Code / Claude Desktop (see README) — it speaks stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { version } from '../package.json'
import { timestamp } from '../core/validation.js'
import {
  initDb,
  cloudSync,
  listPeople,
  createPerson,
  primaryPersonId,
  getSelfPersonId,
  setSelfPersonId,
  getPerson,
  deletePerson,
  listGoals,
  getGoal,
  createGoal,
  updateGoal,
  deleteGoal,
  listTodos,
  listTodayTodos,
  getTodo,
  reorderTodos,
  listArchivedTodos,
  createTodo,
  updateTodo,
  setTodoDone,
  deleteTodo,
  listTodoTemplates,
  listTodosForGoal,
  listEvents,
  listDayEvents,
  listEventTemplates,
  getEvent,
  createEvent,
  updateEventSeries,
  getEventSeriesContext,
  deleteEvent,
  syncCalendar,
  queueCalendarSync,
  withCalendarSyncPaused,
  previewRemoval,
  removeRange,
  ensureTodoInstancesForDate,
  ensureEventInstancesForRange,
  getCalDavConfig,
  runMaintenance,
  sendNudge,
  focusStats,
  sharedFocusStreak,
  getDailyNote,
  setDailyNote,
  listNoteDays,
  updatePerson,
  listTrash,
  restoreTrash,
  listBackups,
  createBackup,
  restoreBackup,
  parseLocalDate,
  localDay,
  type Recurrence,
  type CalEvent
} from '../core/index.js'
import { shutdownDb } from '../core/db.js'
import { searchWorkspace } from '../core/search.js'
import { appendDailyNote, generateInstances, planningSnapshot, profileDeletionPreview, recurrencePreview, requirePerson, syncSummary, workspaceStatus } from './control.js'

const server = new McpServer({
  name: 'doneline',
  version
})

function text(data: unknown): CallToolResult {
  const failed = !!data && typeof data === 'object' && 'error' in data
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: failed ? data as Record<string, unknown> : { result: data },
    ...(failed ? { isError: true } : {})
  }
}

/** Core validation messages are useful; transport/request details are not. */
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The operation failed.'
  if (/(?:https?|libsql):\/\/|authorization|bearer|password|auth.?token|credential|secret|\btoken\b/i.test(message))
    return 'The operation failed. Check the connection in Doneline Settings; saved local changes are retained.'
  return message.slice(0, 350)
}

const writeTools = new Set([
  'add_todo', 'complete_todo', 'update_todo', 'delete_todo', 'add_goal', 'add_person',
  'rename_person', 'add_event', 'update_event', 'delete_event', 'remove_items_in_range',
  'sync_calendar', 'run_maintenance', 'nudge_friend', 'update_goal', 'delete_goal',
  'delete_recurring', 'set_note', 'append_note', 'delete_note', 'select_profile',
  'generate_instances', 'plan_day', 'plan_week', 'restore_trash', 'create_backup',
  'restore_backup', 'delete_person', 'reorder_todos', 'list_today', 'list_events', 'list_trash'
])
const permanentTools = new Set(['delete_goal', 'delete_person', 'restore_backup', 'run_maintenance'])
let backgroundSync: Promise<void> | undefined
let closing = false

function scheduleSync(): void {
  if (closing) return
  backgroundSync = cloudSync().then(() => {}, () => {})
}

/** A local commit is acknowledged immediately; network replication is queued. */
function registerTool<S extends z.ZodRawShape>(name: string, description: string, schema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult> | CallToolResult) {
  server.registerTool(name, {
    description, inputSchema: z.object(schema).strict(),
    annotations: { readOnlyHint: !writeTools.has(name) && name !== 'sync_workspace', destructiveHint: permanentTools.has(name),
      openWorldHint: ['nudge_friend', 'sync_calendar', 'sync_workspace'].includes(name) }
  }, async (args) => {
    try {
      await initDb()
      const result = await handler(args as z.infer<z.ZodObject<S>>)
      const previewOnly = (name === 'delete_person' && args.confirm_delete !== true) ||
        (name === 'remove_items_in_range' && args.preview !== false) ||
        (['plan_day', 'plan_week'].includes(name) && args.generate_instances === false)
      if (!result.isError && writeTools.has(name) && !previewOnly) {
        scheduleSync()
        result.structuredContent = { ...result.structuredContent, local_receipt: { saved_locally: true, sync: syncSummary() } }
      }
      return result
    } catch (error) { return text({ error: safeError(error) }) }
  })
}

/** This device's profile id. Matches how the app resolves "me" (src/main/ipc.ts),
 *  so Claude writes to the profile the user is actually looking at. Defaulting
 *  to primaryPersonId() instead filed new items under whichever profile sorts
 *  first, which is a different person once "This is me" has been switched. */
const selfId = () => getSelfPersonId() ?? primaryPersonId()

/**
 * Normalise a date the model supplied into the UTC ISO the database expects.
 *
 * Date queries convert stored values with SQLite's 'localtime', which only works
 * because the convention is "UTC ISO with a Z". A zone-less string is wall-clock
 * time in the user's zone, so storing it verbatim shifted the item by the UTC
 * offset and it rendered on the wrong day. A bare date means local midnight,
 * matching how the app writes all-day events.
 */
function toUtcIso(value: string): string {
  return timestamp(value)
}

const utcOrNull = (v?: string | null) => (v ? toUtcIso(v) : null)

/** Build a recurrence JSON string from simple tool params. */
function recurrenceJson(repeat?: 'none' | 'daily' | 'weekly', days?: number[], from?: string | null, until?: string | null, existing?: string | null): string | null {
  if (repeat === 'none') return null
  const previous = existing ? JSON.parse(existing) as Recurrence : undefined
  const frequency = repeat ?? previous?.freq
  if (!frequency) {
    if (days !== undefined || from !== undefined || until !== undefined) throw new Error('Choose daily or weekly repeat before setting repeat dates.')
    return null
  }
  const rec: Recurrence = { ...previous, freq: frequency }
  if (frequency === 'weekly') rec.days = days ?? previous?.days ?? []
  else delete rec.days
  if (from !== undefined) { if (from) rec.startDate = from; else delete rec.startDate }
  if (until !== undefined) { if (until) rec.endDate = until; else delete rec.endDate }
  return JSON.stringify(rec)
}

const repeatSchema = {
  repeat_from: z.string().nullable().optional().describe('First allowed occurrence date, inclusive YYYY-MM-DD; defaults to the item date'),
  repeat_until: z.string().nullable().optional().describe('Last allowed occurrence date, inclusive YYYY-MM-DD; null means no end date'),
  repeat: z.enum(['none', 'daily', 'weekly']).optional().describe("Repeat rule; 'weekly' uses repeat_days"),
  repeat_days: z
    .array(z.number().int().min(0).max(6))
    .optional()
    .describe('Weekdays for weekly repeat (0=Sun … 6=Sat)')
}

// ---- People ----
registerTool(
  'list_people',
  'List the profiles (people) in Doneline. Use a person id to scope other tools; omitting it means everyone on read tools and the current profile on write tools.',
  {},
  async () => {
    return text(listPeople())
  }
)

// ---- Todos ----
registerTool(
  'list_todos',
  'List todos. By default only open (incomplete) todos for everyone are returned.',
  {
    include_completed: z.boolean().optional().describe('Include completed todos too'),
    person_id: z.string().optional().describe('Limit to one person; omit for everyone')
  },
  async ({ include_completed, person_id }) => {
    return text(listTodos({ includeCompleted: include_completed, personId: person_id }))
  }
)

registerTool(
  'list_today',
  "List today's todos and events in one snapshot (all people unless person_id is given).",
  { person_id: z.string().optional().describe('Limit to one person; omit for everyone') },
  async ({ person_id }) => {
    const day = localDay()
    ensureTodoInstancesForDate(day)
    return text({ day, todos: listTodayTodos(day, person_id), events: listDayEvents(day, person_id) })
  }
)

registerTool(
  'add_todo',
  'Add a todo. Optionally link a goal, a due date/time, a person id (defaults to the current profile), and a repeat rule (daily/weekly).',
  {
    title: z.string().describe('What needs doing'),
    person_id: z.string().optional().describe('Owner profile id; defaults to the current profile'),
    goal_id: z.string().optional().describe('Goal id to link this todo to'),
    due_at: z
      .string()
      .optional()
      .describe('Due date/time in local time, e.g. 2026-06-15T09:00 or 2026-06-15'),
    notes: z.string().optional(),
    ...repeatSchema
  },
  async ({ title, person_id, goal_id, due_at, notes, repeat, repeat_days, repeat_from, repeat_until }) => {
    const recurrence = recurrenceJson(repeat, repeat_days, repeat_from, repeat_until)
    const todo = createTodo({
      title,
      person_id: person_id ?? selfId(),
      goal_id: goal_id ?? null,
      due_at: utcOrNull(due_at),
      notes: notes ?? null,
      recurrence
    })
    // Only when a repeat rule was set, matching the app. runMaintenance also
    // archives and purges, so calling it on every add would quietly destroy
    // archived todos older than the retention window.
    if (recurrence) ensureTodoInstancesForDate(localDay())
    return text(todo)
  }
)

registerTool(
  'complete_todo',
  'Mark a todo done (or reopen it).',
  {
    id: z.string().describe('Todo id'),
    done: z.boolean().optional().describe('true = complete (default), false = reopen')
  },
  async ({ id, done }) => {
    const result = setTodoDone(id, done ?? true, selfId())
    return result ? text(result) : text({ error: 'Todo not found', id })
  }
)

registerTool(
  'update_todo',
  'Edit a todo: title, due date/time, notes, linked goal, owner, or its repeat rule.',
  {
    id: z.string(),
    title: z.string().optional(),
    due_at: z.string().nullable().optional().describe('Local date/time, or null to clear'),
    notes: z.string().nullable().optional(),
    goal_id: z.string().nullable().optional(),
    person_id: z.string().optional(),
    ...repeatSchema
  },
  async ({ id, title, due_at, notes, goal_id, person_id, repeat, repeat_days, repeat_from, repeat_until }) => {
    const changesRepeat = repeat !== undefined || repeat_days !== undefined || repeat_from !== undefined || repeat_until !== undefined
    const result = updateTodo(id, {
      title,
      due_at: due_at == null ? due_at : toUtcIso(due_at),
      notes,
      goal_id,
      person_id,
      recurrence: changesRepeat ? recurrenceJson(repeat, repeat_days, repeat_from, repeat_until, getTodo(id)?.recurrence) : undefined
    })
    if (result?.recurrence) ensureTodoInstancesForDate(localDay())
    return result ? text(result) : text({ error: 'Todo not found', id })
  }
)

registerTool(
  'list_archived_todos',
  'List archived (completed, swept) todos.',
  { person_id: z.string().optional() },
  async ({ person_id }) => {
    return text(listArchivedTodos(person_id))
  }
)

registerTool(
  'delete_todo',
  'Move a todo to Trash for 30 days. A repeat-rule template also removes unfinished occurrences; completed history is kept. Returns a trash_id for restore_trash.',
  { id: z.string() },
  async ({ id }) => {
    const trashId = deleteTodo(id)
    return trashId ? text({ deleted: id, trash_id: trashId }) : text({ error: 'Todo not found', id })
  }
)

// ---- Goals ----
registerTool(
  'list_goals',
  'List goals with their progress counts (all people unless person_id is given).',
  {
    person_id: z.string().optional().describe('Limit to one person; omit for everyone'),
    include_archived: z.boolean().optional().describe('Include archived goals too')
  },
  async ({ person_id, include_archived }) => {
    return text(listGoals({ personId: person_id, includeArchived: include_archived }))
  }
)

registerTool(
  'add_goal',
  'Create a goal. Set shared=true so every todo under it must be completed by both people.',
  {
    title: z.string(),
    person_id: z.string().optional().describe('Owner profile id; defaults to the current profile'),
    color: z.string().optional().describe('Hex color, e.g. #2f7a4d'),
    shared: z.boolean().optional().describe('Shared goal — todos need everyone to complete')
  },
  async ({ title, person_id, color, shared }) => {
    const goal = createGoal({ title, person_id: person_id ?? selfId(), color, shared })
    return text(goal)
  }
)

registerTool(
  'add_person',
  'Create a profile (person) in the workspace.',
  {
    name: z.string(),
    emoji: z.string().optional(),
    color: z.string().optional().describe('Hex color')
  },
  async ({ name, emoji, color }) => {
    const person = createPerson({ name, emoji, color })
    return text(person)
  }
)

registerTool(
  'rename_person',
  'Rename a profile or change its emoji/colour. Use delete_person to preview a permanent cascade and create a safety backup before deleting.',
  {
    id: z.string(),
    name: z.string().optional(),
    emoji: z.string().optional(),
    color: z.string().optional().describe('Hex color')
  },
  async ({ id, name, emoji, color }) => {
    const result = updatePerson(id, { name, emoji, color })
    return result ? text(result) : text({ error: 'Person not found', id })
  }
)

// ---- Events ----
registerTool(
  'list_events',
  'List calendar events, optionally within an ISO date range (all people unless person_id is given).',
  {
    from: z.string().optional().describe('Start of range, local time'),
    to: z.string().optional().describe('End of range, local time'),
    person_id: z.string().optional().describe('Limit to one person; omit for everyone')
  },
  async ({ from, to, person_id }) => {
    return text(
      listEvents({
        from: from ? toUtcIso(from) : undefined,
        to: to ? toUtcIso(to) : undefined,
        personId: person_id
      })
    )
  }
)

registerTool(
  'add_event',
  'Add a calendar event (may span multiple days via ends_at, and repeat). Syncs to Apple Calendar if the owner has one connected.',
  {
    title: z.string(),
    starts_at: z.string().describe('Start in local time, e.g. 2026-06-15T15:45'),
    ends_at: z.string().describe('End of ONE occurrence in local time (a later day makes a multi-day event). Use repeat_until for the last date of a repeat schedule.'),
    person_id: z.string().optional().describe('Owner profile id; defaults to the current profile'),
    all_day: z.boolean().optional(),
    shared: z.boolean().optional().describe('Show this event for every profile'),
    location: z.string().optional(),
    notes: z.string().optional(),
    attendees: z.string().optional().describe('Comma-separated names'),
    color: z.string().optional().describe('Hex color'),
    ...repeatSchema
  },
  async (args) => {
    const recurrence = recurrenceJson(args.repeat, args.repeat_days, args.repeat_from, args.repeat_until)
    const ev = createEvent({
      title: args.title,
      starts_at: toUtcIso(args.starts_at),
      ends_at: toUtcIso(args.ends_at),
      person_id: args.person_id ?? selfId(),
      all_day: args.all_day,
      shared: args.shared,
      location: args.location ?? null,
      notes: args.notes ?? null,
      attendees: args.attendees ?? null,
      color: args.color,
      recurrence
    })
    if (recurrence) {
      const last = new Date(); last.setDate(last.getDate() + 59)
      ensureEventInstancesForRange(new Date(), last)
    }
    queueCalendarSync(ev.person_id)
    return text(ev)
  }
)

registerTool(
  'update_event',
  'Edit an event with occurrence, future (this and later), or series scope. Defaults to one dated occurrence or the whole rule for a template id. Setting a start without an end preserves duration. Calendar changes are saved locally and sync in the background.',
  {
    id: z.string(),
    scope: z.enum(['occurrence', 'future', 'series']).optional().describe('Defaults to occurrence for dated events, series for repeat-rule templates'),
    title: z.string().optional(),
    starts_at: z.string().optional().describe('Start in local time'),
    ends_at: z.string().optional().describe('End in local time'),
    all_day: z.boolean().optional(),
    shared: z.boolean().optional(),
    person_id: z.string().optional(),
    location: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    attendees: z.string().nullable().optional().describe('Comma-separated names'),
    color: z.string().optional().describe('Hex color'),
    ...repeatSchema
  },
  async (args) => {
    const context = getEventSeriesContext(args.id)
    if (!context) return text({ error: 'Event not found', id: args.id })
    const scope = args.scope ?? (context.event.recurrence ? 'series' : 'occurrence')
    const patch: Partial<Omit<CalEvent, 'id' | 'created_at'>> = {}
    if (args.title !== undefined) patch.title = args.title
    if (args.starts_at !== undefined) patch.starts_at = toUtcIso(args.starts_at)
    if (args.ends_at !== undefined) patch.ends_at = toUtcIso(args.ends_at)
    if (args.all_day !== undefined) patch.all_day = args.all_day ? 1 : 0
    if (args.location !== undefined) patch.location = args.location
    if (args.notes !== undefined) patch.notes = args.notes
    if (args.attendees !== undefined) patch.attendees = args.attendees
    if (args.color !== undefined) patch.color = args.color
    if (args.shared !== undefined) patch.shared = args.shared ? 1 : 0
    if (args.person_id !== undefined) patch.person_id = args.person_id
    if (args.repeat !== undefined || args.repeat_days !== undefined || args.repeat_from !== undefined || args.repeat_until !== undefined) {
      patch.recurrence = recurrenceJson(args.repeat, args.repeat_days, args.repeat_from, args.repeat_until, context.template?.recurrence ?? context.event.recurrence)
    }
    const result = updateEventSeries(args.id, patch, scope)
    if (!result) return text({ error: 'Event not found', id: args.id })
    queueCalendarSync(context.event.person_id)
    if (result.person_id !== context.event.person_id) queueCalendarSync(result.person_id)
    return text(result)
  }
)

registerTool(
  'delete_event',
  'Move a calendar event to Trash for 30 days and queue its removal from a connected calendar. A repeat-rule template removes its generated occurrences. Returns trash_id for restore_trash.',
  { id: z.string() },
  async ({ id }) => {
    const trashId = deleteEvent(id)
    if (!trashId) return text({ error: 'Event not found', id })
    queueCalendarSync()
    return text({ deleted: id, trash_id: trashId })
  }
)

// ---- Calendar sync ----
registerTool(
  'remove_items_in_range',
  'Preview or remove dated events and todos between two inclusive local dates, optionally matching part of a title. Defaults to preview. Preview returns expected_ids; pass those exact IDs with preview=false to remove only the reviewed matches. Deleted recurring occurrences stay deleted while their repeat rule continues outside the range.',
  {
    kind: z.enum(['events', 'todos', 'both']).default('both'),
    from_day: z.string().describe('First day, inclusive YYYY-MM-DD'),
    to_day: z.string().describe('Last day, inclusive YYYY-MM-DD'),
    title_contains: z.string().optional().describe('Case-insensitive literal title text; omit to match every title'),
    person_id: z.string().optional().describe('Owner profile; defaults to current profile. Use all for all owners.'),
    preview: z.boolean().default(true),
    expected_ids: z.array(z.string()).optional().describe('Exact expected_ids returned by the most recent preview; required to remove')
  },
  async ({ kind, from_day, to_day, title_contains, person_id, preview, expected_ids }) => {
    const input = { kind, fromDay: from_day, toDay: to_day, title: title_contains, personId: person_id ?? selfId(), expectedIds: expected_ids }
    if (preview) {
      const matches = previewRemoval(input)
      return text({ ...matches, expected_ids: [...matches.events.map((event) => `events:${event.id}`), ...matches.todos.map((todo) => `todos:${todo.id}`)] })
    }
    if (!expected_ids) throw new Error('Preview the range first, then provide its expected_ids to remove those matches.')
    const removed = removeRange(input)
    queueCalendarSync()
    return text({ removed })
  }
)

registerTool(
  'sync_calendar',
  "Run a two-way sync with a person's connected Apple/iCloud calendar (defaults to the current profile).",
  { person_id: z.string().optional().describe('Profile id to sync; defaults to the current profile') },
  async ({ person_id }) => {
    const pid = person_id ?? selfId()
    if (!getCalDavConfig(pid))
      return text({ error: 'No calendar connected for this profile. Connect one in Doneline > Settings.' })
    const result = await syncCalendar(pid)
    return text(result)
  }
)

registerTool(
  'run_maintenance',
  'Generate due recurring instances, archive yesterday’s completed todos, and purge old archived ones.',
  {},
  async () => {
    const result = runMaintenance()
    return text(result)
  }
)

registerTool(
  'focus_stats',
  "A person's focus stats: sessions today, minutes today/this week, daily target, and streak.",
  { person_id: z.string().optional().describe('Defaults to the current profile') },
  async ({ person_id }) => {
    return text(focusStats(person_id ?? selfId()))
  }
)

registerTool(
  'shared_focus_streak',
  'Consecutive days on which every profile hit its daily focus target: the "together streak".',
  {},
  async () => {
    return text({ streak: sharedFocusStreak(listPeople().map((p) => p.id)) })
  }
)

registerTool(
  'nudge_friend',
  'Send a friend a nudge. It appears as a card in their app, plus an OS notification. A buzz also shakes their window.',
  {
    to_person: z.string().describe('Recipient profile id (see list_people)'),
    message: z.string().describe('e.g. Study with me?'),
    kind: z.enum(['message', 'buzz']).optional().describe("'buzz' shakes their window; defaults to 'message'")
  },
  async ({ to_person, message, kind }) => {
    const n = sendNudge(selfId(), to_person, message, kind ?? 'message')
    return text({ sent: true, to: to_person, id: n.id, kind: n.kind })
  }
)

// ---- Goal detail ----
registerTool(
  'list_goal_todos',
  "Everything under one goal: open, finished (archived included) and its repeat rules. Use this rather than list_todos when asked about a goal's progress, since list_todos hides archived rows and would undercount.",
  { goal_id: z.string() },
  async ({ goal_id }) => {
    return text(listTodosForGoal(goal_id))
  }
)

registerTool(
  'update_goal',
  'Rename a goal, recolour it, or archive it. Sharing cannot be changed after creation.',
  {
    id: z.string(),
    title: z.string().optional(),
    color: z.string().optional().describe('Hex color, e.g. #2f7a4d'),
    archived: z.boolean().optional().describe('Archive the goal without deleting its history')
  },
  async ({ id, title, color, archived }) => {
    const result = updateGoal(id, {
      title,
      color,
      archived: archived === undefined ? undefined : archived ? 1 : 0
    })
    return result ? text(result) : text({ error: 'Goal not found', id })
  }
)

registerTool(
  'delete_goal',
  'Permanently delete a goal and all linked todos and repeat rules, after creating a local safety backup. This cascade bypasses Trash. Prefer update_goal archived=true to retain history.',
  { id: z.string() },
  async ({ id }) => {
    if (!getGoal(id)) return text({ error: 'Goal not found', id })
    const safetyBackup = createBackup()
    deleteGoal(id)
    return text({ deleted: id, safetyBackup })
  }
)

// ---- Recurrence rules ----
registerTool(
  'list_recurring',
  'List the repeat rules that generate todos and events. These templates are hidden from list_todos and list_events, so this is the only way to see or stop a repeat.',
  {},
  async () => {
    return text({ todos: listTodoTemplates(), events: listEventTemplates() })
  }
)

registerTool(
  'delete_recurring',
  'Stop a repeat rule and move it to Trash for 30 days. Use its template id from list_recurring. Todo rules retain completed history; event rules remove all generated occurrences. Returns trash_id for undo.',
  {
    id: z.string().describe('Template id from list_recurring'),
    kind: z.enum(['todo', 'event']).describe('Which list the template came from')
  },
  async ({ id, kind }) => {
    const template = kind === 'todo' ? getTodo(id) : getEvent(id)
    if (!template?.recurrence) throw new Error('Use the id of a repeat-rule template from list_recurring.')
    const trashId = kind === 'todo' ? deleteTodo(id) : deleteEvent(id)
    queueCalendarSync()
    return text({ stopped: id, kind, trash_id: trashId })
  }
)

// ---- Daily notes ----
registerTool(
  'get_note',
  "Read a person's free-text note for one day. Returns an empty body if nothing was written.",
  {
    day: z.string().optional().describe('Local date as YYYY-MM-DD; defaults to today'),
    person_id: z.string().optional().describe('Whose note; defaults to the current profile')
  },
  async ({ day, person_id }) => {
    return text(getDailyNote(day ?? localDay(), person_id ?? selfId()))
  }
)

registerTool(
  'set_note',
  "Replace a person's whole note for one day. Use append_note to add text atomically, or delete_note to clear it.",
  {
    body: z.string().describe('Full note text'),
    day: z.string().optional().describe('Local date as YYYY-MM-DD; defaults to today'),
    person_id: z.string().optional().describe('Whose note; defaults to the current profile')
  },
  async ({ body, day, person_id }) => {
    const note = setDailyNote(day ?? localDay(), body, person_id ?? selfId())
    return text(note)
  }
)

registerTool(
  'list_note_days',
  'Days that have a non-empty note, newest first. Use with get_note to read back past days.',
  {
    person_id: z.string().optional().describe('Whose notes; defaults to the current profile'),
    limit: z.number().optional().describe('How many days back to list (default 30)')
  },
  async ({ person_id, limit }) => {
    return text(listNoteDays(person_id ?? selfId(), limit ?? 30))
  }
)

// ---- Workspace control and planning ----
registerTool('status', 'Current profile, local time zone, database path and workspace sync summary. Calendar configuration and credentials are never returned.', {},
  async () => text(workspaceStatus(selfId())))

registerTool('select_profile', 'Select the device\'s current profile ("This is me"). Future unscoped writes and shared-task completions use this profile.',
  { person_id: z.string().describe('Existing profile id from list_people') },
  async ({ person_id }) => {
    setSelfPersonId(person_id)
    return text({ person_id, profile: getPerson(person_id) })
  })

registerTool('search', 'Search todo titles/notes, events, goals and daily notes together. Includes completed and archived work. Literal, case- and accent-insensitive search; returns up to limit items per group.',
  { query: z.string().max(200), person_id: z.string().optional().describe('Omit for all profiles'), limit: z.number().int().min(1).max(50).optional() },
  async ({ query, person_id, limit }) => {
    if (person_id) requirePerson(person_id, true)
    return text(searchWorkspace({ query, personId: person_id, limit }))
  })

registerTool('plan_day', 'Local day planning snapshot: dated tasks, overlapping events, overdue and undated backlog, goals and counts. Defaults to the current profile. Recurring instances are generated unless generate_instances=false; no work is moved or completed.',
  { day: z.string().optional().describe('YYYY-MM-DD; defaults to today'), person_id: z.string().optional().describe('Defaults to the current profile; all includes every profile'), generate_instances: z.boolean().default(true) },
  async ({ day, person_id, generate_instances }) => {
    const chosen = day ?? localDay()
    const snapshot = planningSnapshot(chosen, chosen, person_id ?? selfId(), generate_instances)
    const { from_day: _from, to_day: _to, days, ...rest } = snapshot
    return text({ day: chosen, todos: days[0].todos, events: days[0].events, ...rest })
  })

registerTool('plan_week', 'Seven local calendar days of tasks and events, with unique counts, overdue/undated backlog and goals. Defaults to Monday of the current week and the current profile. Does not schedule or complete work.',
  { from_day: z.string().optional().describe('First day YYYY-MM-DD; defaults to this week\'s Monday'), person_id: z.string().optional().describe('Defaults to current profile; all includes everyone'), generate_instances: z.boolean().default(true) },
  async ({ from_day, person_id, generate_instances }) => {
    const from = from_day ? parseLocalDate(from_day) : parseLocalDate(localDay())
    if (!from_day) from.setDate(from.getDate() - ((from.getDay() + 6) % 7))
    const to = new Date(from); to.setDate(to.getDate() + 6)
    return text(planningSnapshot(localDay(from), localDay(to), person_id ?? selfId(), generate_instances))
  })

registerTool('generate_instances', 'Materialize recurring tasks and events for an inclusive local date range of at most 366 days. Idempotent; preserves exclusions and completed history. Does not archive or purge work.',
  { from_day: z.string().describe('First day YYYY-MM-DD'), to_day: z.string().describe('Last day YYYY-MM-DD') },
  async ({ from_day, to_day }) => {
    const generated = generateInstances(from_day, to_day)
    queueCalendarSync()
    return text({ from_day, to_day, generated })
  })

registerTool('preview_recurrence', 'Preview a proposed daily/weekly repeat rule without creating rows, or inspect a saved rule/occurrence by id and kind. Returns dates, exact bounded total (null if unbounded), and hasMore. Honors saved exclusions.',
  { id: z.string().optional(), kind: z.enum(['todo', 'event']).optional(), anchor_day: z.string().optional().describe('Local anchor YYYY-MM-DD; defaults to rule date or today'), ...repeatSchema, limit: z.number().int().min(1).max(100).optional() },
  async (args) => text(recurrencePreview(args)))

registerTool('get_event_series_context', 'Read an event\'s series template, repeat rule, supported editing scopes, and any connected-calendar limitations. Does not return calendar credentials or raw ICS.',
  { id: z.string() }, async ({ id }) => {
    const result = getEventSeriesContext(id)
    return result ? text(result) : text({ error: 'Event not found', id })
  })

registerTool('get_todo', 'Read one todo or repeat-rule template by id, including goal and shared completion detail.',
  { id: z.string() }, async ({ id }) => {
    const result = getTodo(id)
    return result ? text(result) : text({ error: 'Todo not found', id })
  })

registerTool('get_event', 'Read one dated event or repeat-rule template by id.',
  { id: z.string() }, async ({ id }) => {
    const result = getEvent(id)
    return result ? text(result) : text({ error: 'Event not found', id })
  })

registerTool('get_goal', 'Read one goal with progress counts including completed archived history.',
  { id: z.string() }, async ({ id }) => {
    const result = getGoal(id)
    return result ? text(result) : text({ error: 'Goal not found', id })
  })

registerTool('reorder_todos', 'Set task ordering positions. Every supplied id must exist; validation finishes before any position changes.',
  { updates: z.array(z.object({ id: z.string(), position: z.number().finite() })).min(1).max(500) },
  async ({ updates }) => {
    const db = (await import('../core/db.js')).getDb()
    db.transaction(() => {
      for (const update of updates) if (!getTodo(update.id)) throw new Error('Todo not found; no positions were changed.')
      reorderTodos(updates)
    }).immediate()
    return text({ reordered: updates.length })
  })

// ---- Recovery ----
registerTool('list_trash', 'List local recoverable task/event deletions within the 30-day retention period. Returns Trash entry ids for restore_trash; expired entries are purged.',
  { person_id: z.string().optional().describe('Omit for every profile') }, async ({ person_id }) => {
    if (person_id) requirePerson(person_id, true)
    return text(listTrash(person_id))
  })

registerTool('restore_trash', 'Restore a task/event Trash entry and its captured dependent rows. Does not overwrite a conflicting identity. Connected-calendar restoration is queued in the background.',
  { id: z.string().describe('Trash entry id returned by delete or list_trash') }, async ({ id }) => {
    const restored = restoreTrash(id)
    if (restored.kind === 'event') queueCalendarSync(restored.personId)
    return text({ restored: id, ...restored })
  })

registerTool('list_backups', 'List valid local snapshots for the current workspace. Returns metadata only; no database rows or credentials.', {},
  async () => text(listBackups()))

registerTool('create_backup', 'Create a local recovery snapshot of the current workspace. Device sync identity and calendar credentials are excluded.', {},
  async () => text(createBackup()))

registerTool('restore_backup', 'Replace the current workspace with a chosen local snapshot. Requires confirm_restore=true. Creates a before-restore safety copy and pauses calendar writers. Existing device/calendar connections are retained when possible; restored changes replicate afterward.',
  { id: z.string().describe('Backup id from list_backups'), confirm_restore: z.boolean().describe('Must be true to acknowledge replacing current workspace data') },
  async ({ id, confirm_restore }) => {
    if (!confirm_restore) throw new Error('Set confirm_restore=true to replace the current workspace with this backup.')
    const restored = await withCalendarSyncPaused(() => restoreBackup(id))
    queueCalendarSync()
    return text({ restored: id, ...restored })
  })

registerTool('delete_person', 'Preview a permanent profile deletion and counts by default. confirm_delete=true creates a safety backup, then permanently removes that profile\'s owned work, notes and focus history. The last profile cannot be deleted.',
  { id: z.string(), confirm_delete: z.boolean().default(false) }, async ({ id, confirm_delete }) => {
    const preview = profileDeletionPreview(id)
    if (!confirm_delete) return text({ preview: true, ...preview })
    const safetyBackup = await withCalendarSyncPaused(() => {
      const backup = createBackup()
      deletePerson(id)
      return backup
    })
    return text({ deleted: id, safetyBackup, counts: preview.counts, current_profile_id: selfId() })
  })

registerTool('append_note', 'Atomically append text to a daily note under a database write lock, preserving app/other-client edits made before the append. Defaults to today and the current profile.',
  { body: z.string(), day: z.string().optional(), person_id: z.string().optional(), separator: z.string().max(100).optional().describe('Between existing and appended text; defaults to newline') },
  async ({ body, day, person_id, separator }) => text(appendDailyNote(day ?? localDay(), body, person_id ?? selfId(), separator)))

registerTool('delete_note', 'Clear a profile\'s daily note, creating a safety backup first when it contains text. Defaults to today and the current profile.',
  { day: z.string().optional(), person_id: z.string().optional() }, async ({ day, person_id }) => {
    const date = day ?? localDay()
    const owner = person_id ?? selfId()
    const previous = getDailyNote(date, owner)
    const safetyBackup = previous.body ? createBackup() : null
    const note = setDailyNote(date, '', owner)
    return text({ cleared: true, day: note.day, person_id: note.person_id, ...(safetyBackup ? { safetyBackup } : {}) })
  })

registerTool('sync_workspace', 'Explicitly attempt to push queued local workspace changes and pull shared changes. Local tools already queue this in the background. Returns sync state without credentials; a failure leaves local work saved.', {},
  async () => {
    try { return text({ synced: await cloudSync(), sync: syncSummary() }) }
    catch (error) { return text({ error: safeError(error), sync: syncSummary() }) }
  })

async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  try {
    await shutdownDb()
    await backgroundSync
    await server.close()
  } catch (error) { console.error('[doneline-mcp] shutdown:', safeError(error)) }
  process.exit(0)
}

async function main() {
  // Register with the client FIRST so tools always appear quickly, even if the
  // initial cloud pull is slow. Opening the DB + pulling happens in the
  // background; cached workspaces and ordinary tools never await cloud traffic.
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr only — stdout is reserved for the MCP protocol.
  console.error('[doneline-mcp] ready')
  process.stdin.once('end', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
  process.once('SIGINT', () => { void shutdown() })
  initDb().catch((err) => console.error('[doneline-mcp] initDb failed:', safeError(err)))
}

main().catch((err) => {
  console.error('[doneline-mcp] fatal:', safeError(err))
  process.exit(1)
})
