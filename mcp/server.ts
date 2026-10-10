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
import { z } from 'zod'
import {
  initDb,
  cloudSync,
  listPeople,
  createPerson,
  primaryPersonId,
  getSelfPersonId,
  listGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  listTodos,
  listTodayTodos,
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
  createEvent,
  updateEvent,
  deleteEvent,
  syncCalendar,
  pushEvent,
  updateRemoteEvent,
  deleteRemoteEvent,
  getCalDavConfig,
  runMaintenance,
  sendNudge,
  focusStats,
  sharedFocusStreak,
  getDailyNote,
  setDailyNote,
  listNoteDays,
  updatePerson,
  localDay,
  type Recurrence,
  type CalEvent
} from '../core/index.js'

const server = new McpServer({
  name: 'doneline',
  version: '0.1.0'
})

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

/** Pull/push the shared workspace (no-op in local mode). Never throws. */
const sync = () => cloudSync().catch(() => false)

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
  const v = String(value).trim()
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)) {
    const parts = v.split('-').map(Number)
    return new Date(parts[0], parts[1] - 1, parts[2]).toISOString()
  }
  const hasZone = /(Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(v)
  const d = new Date(hasZone ? v : v.replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? value : d.toISOString()
}

const utcOrNull = (v?: string | null) => (v ? toUtcIso(v) : null)

/** Build a recurrence JSON string from simple tool params. */
function recurrenceJson(repeat?: 'none' | 'daily' | 'weekly', days?: number[]): string | null {
  if (!repeat || repeat === 'none') return null
  const rec: Recurrence = repeat === 'daily' ? { freq: 'daily' } : { freq: 'weekly', days: days ?? [] }
  return JSON.stringify(rec)
}

const repeatSchema = {
  repeat: z.enum(['none', 'daily', 'weekly']).optional().describe("Repeat rule; 'weekly' uses repeat_days"),
  repeat_days: z
    .array(z.number().min(0).max(6))
    .optional()
    .describe('Weekdays for weekly repeat (0=Sun … 6=Sat)')
}

// ---- People ----
server.tool(
  'list_people',
  'List the profiles (people) in Doneline. Use a person id to scope other tools; omitting it means everyone on read tools and the current profile on write tools.',
  {},
  async () => {
    await sync()
    return text(listPeople())
  }
)

// ---- Todos ----
server.tool(
  'list_todos',
  'List todos. By default only open (incomplete) todos for everyone are returned.',
  {
    include_completed: z.boolean().optional().describe('Include completed todos too'),
    person_id: z.string().optional().describe('Limit to one person; omit for everyone')
  },
  async ({ include_completed, person_id }) => {
    await sync()
    return text(listTodos({ includeCompleted: include_completed, personId: person_id }))
  }
)

server.tool(
  'list_today',
  "List today's todos and events in one snapshot (all people unless person_id is given).",
  { person_id: z.string().optional().describe('Limit to one person; omit for everyone') },
  async ({ person_id }) => {
    await sync()
    const day = localDay()
    return text({ day, todos: listTodayTodos(day, person_id), events: listDayEvents(day, person_id) })
  }
)

server.tool(
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
  async ({ title, person_id, goal_id, due_at, notes, repeat, repeat_days }) => {
    await sync()
    const recurrence = recurrenceJson(repeat, repeat_days)
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
    if (recurrence) runMaintenance()
    await sync()
    return text(todo)
  }
)

server.tool(
  'complete_todo',
  'Mark a todo done (or reopen it).',
  {
    id: z.string().describe('Todo id'),
    done: z.boolean().optional().describe('true = complete (default), false = reopen')
  },
  async ({ id, done }) => {
    await sync()
    const result = setTodoDone(id, done ?? true, selfId())
    await sync()
    return result ? text(result) : text({ error: 'Todo not found', id })
  }
)

server.tool(
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
  async ({ id, title, due_at, notes, goal_id, person_id, repeat, repeat_days }) => {
    await sync()
    const result = updateTodo(id, {
      title,
      due_at: due_at == null ? due_at : toUtcIso(due_at),
      notes,
      goal_id,
      person_id,
      recurrence: repeat === undefined ? undefined : recurrenceJson(repeat, repeat_days)
    })
    await sync()
    return result ? text(result) : text({ error: 'Todo not found', id })
  }
)

server.tool(
  'list_archived_todos',
  'List archived (completed, swept) todos.',
  { person_id: z.string().optional() },
  async ({ person_id }) => {
    await sync()
    return text(listArchivedTodos(person_id))
  }
)

server.tool(
  'delete_todo',
  'Delete a todo permanently.',
  { id: z.string() },
  async ({ id }) => {
    await sync()
    deleteTodo(id)
    await sync()
    return text({ deleted: id })
  }
)

// ---- Goals ----
server.tool(
  'list_goals',
  'List goals with their progress counts (all people unless person_id is given).',
  {
    person_id: z.string().optional().describe('Limit to one person; omit for everyone'),
    include_archived: z.boolean().optional().describe('Include archived goals too')
  },
  async ({ person_id, include_archived }) => {
    await sync()
    return text(listGoals({ personId: person_id, includeArchived: include_archived }))
  }
)

server.tool(
  'add_goal',
  'Create a goal. Set shared=true so every todo under it must be completed by both people.',
  {
    title: z.string(),
    person_id: z.string().optional().describe('Owner profile id; defaults to the current profile'),
    color: z.string().optional().describe('Hex color, e.g. #2f7a4d'),
    shared: z.boolean().optional().describe('Shared goal — todos need everyone to complete')
  },
  async ({ title, person_id, color, shared }) => {
    await sync()
    const goal = createGoal({ title, person_id: person_id ?? selfId(), color, shared })
    await sync()
    return text(goal)
  }
)

server.tool(
  'add_person',
  'Create a profile (person) in the workspace.',
  {
    name: z.string(),
    emoji: z.string().optional(),
    color: z.string().optional().describe('Hex color')
  },
  async ({ name, emoji, color }) => {
    await sync()
    const person = createPerson({ name, emoji, color })
    await sync()
    return text(person)
  }
)

server.tool(
  'rename_person',
  'Rename a profile or change its emoji/colour. Deleting a profile is deliberately not exposed here: it erases that person\'s todos, goals, events, notes and focus history.',
  {
    id: z.string(),
    name: z.string().optional(),
    emoji: z.string().optional(),
    color: z.string().optional().describe('Hex color')
  },
  async ({ id, name, emoji, color }) => {
    await sync()
    const result = updatePerson(id, { name, emoji, color })
    await sync()
    return result ? text(result) : text({ error: 'Person not found', id })
  }
)

// ---- Events ----
server.tool(
  'list_events',
  'List calendar events, optionally within an ISO date range (all people unless person_id is given).',
  {
    from: z.string().optional().describe('Start of range, local time'),
    to: z.string().optional().describe('End of range, local time'),
    person_id: z.string().optional().describe('Limit to one person; omit for everyone')
  },
  async ({ from, to, person_id }) => {
    await sync()
    return text(
      listEvents({
        from: from ? toUtcIso(from) : undefined,
        to: to ? toUtcIso(to) : undefined,
        personId: person_id
      })
    )
  }
)

server.tool(
  'add_event',
  'Add a calendar event (may span multiple days via ends_at, and repeat). Syncs to Apple Calendar if the owner has one connected.',
  {
    title: z.string(),
    starts_at: z.string().describe('Start in local time, e.g. 2026-06-15T15:45'),
    ends_at: z.string().describe('End in local time (use a later day for multi-day events)'),
    person_id: z.string().optional().describe('Owner profile id; defaults to the current profile'),
    all_day: z.boolean().optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
    attendees: z.string().optional().describe('Comma-separated names'),
    color: z.string().optional().describe('Hex color'),
    ...repeatSchema
  },
  async (args) => {
    await sync()
    const recurrence = recurrenceJson(args.repeat, args.repeat_days)
    const ev = createEvent({
      title: args.title,
      starts_at: toUtcIso(args.starts_at),
      ends_at: toUtcIso(args.ends_at),
      person_id: args.person_id ?? selfId(),
      all_day: args.all_day,
      location: args.location ?? null,
      notes: args.notes ?? null,
      attendees: args.attendees ?? null,
      color: args.color,
      recurrence
    })
    if (recurrence) runMaintenance()
    // Push straight to the connected calendar, as the app does on create.
    await pushEvent(ev.id).catch((err) => console.error('[doneline-mcp] pushEvent failed:', err))
    await sync()
    return text(ev)
  }
)

server.tool(
  'update_event',
  'Edit a calendar event: title, times, location, notes, attendees or colour. Mirrors the change to Apple Calendar when the event is synced.',
  {
    id: z.string(),
    title: z.string().optional(),
    starts_at: z.string().optional().describe('Start in local time'),
    ends_at: z.string().optional().describe('End in local time'),
    all_day: z.boolean().optional(),
    location: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    attendees: z.string().nullable().optional().describe('Comma-separated names'),
    color: z.string().optional().describe('Hex color')
  },
  async (args) => {
    await sync()
    const patch: Partial<Omit<CalEvent, 'id' | 'created_at'>> = {}
    if (args.title !== undefined) patch.title = args.title
    if (args.starts_at !== undefined) patch.starts_at = toUtcIso(args.starts_at)
    if (args.ends_at !== undefined) patch.ends_at = toUtcIso(args.ends_at)
    if (args.all_day !== undefined) patch.all_day = args.all_day ? 1 : 0
    if (args.location !== undefined) patch.location = args.location
    if (args.notes !== undefined) patch.notes = args.notes
    if (args.attendees !== undefined) patch.attendees = args.attendees
    if (args.color !== undefined) patch.color = args.color
    const result = updateEvent(args.id, patch)
    if (!result) return text({ error: 'Event not found', id: args.id })
    await updateRemoteEvent(args.id).catch((err) =>
      console.error('[doneline-mcp] updateRemoteEvent failed:', err)
    )
    await sync()
    return text(result)
  }
)

server.tool(
  'delete_event',
  'Delete a calendar event, removing it from Apple Calendar too when it is synced.',
  { id: z.string() },
  async ({ id }) => {
    await sync()
    // Remote first: the local row still holds the CalDAV UID at this point.
    await deleteRemoteEvent(id).catch((err) =>
      console.error('[doneline-mcp] deleteRemoteEvent failed:', err)
    )
    deleteEvent(id)
    await sync()
    return text({ deleted: id })
  }
)

// ---- Calendar sync ----
server.tool(
  'sync_calendar',
  "Run a two-way sync with a person's connected Apple/iCloud calendar (defaults to the current profile).",
  { person_id: z.string().optional().describe('Profile id to sync; defaults to the current profile') },
  async ({ person_id }) => {
    await sync()
    const pid = person_id ?? selfId()
    if (!getCalDavConfig(pid))
      return text({ error: 'No calendar connected for this profile. Connect one in Doneline > Settings.' })
    const result = await syncCalendar(pid)
    await sync()
    return text(result)
  }
)

server.tool(
  'run_maintenance',
  'Generate due recurring instances, archive yesterday’s completed todos, and purge old archived ones.',
  {},
  async () => {
    await sync()
    const result = runMaintenance()
    await sync()
    return text(result)
  }
)

server.tool(
  'focus_stats',
  "A person's focus stats: sessions today, minutes today/this week, daily target, and streak.",
  { person_id: z.string().optional().describe('Defaults to the current profile') },
  async ({ person_id }) => {
    await sync()
    return text(focusStats(person_id ?? selfId()))
  }
)

server.tool(
  'shared_focus_streak',
  'Consecutive days on which every profile hit its daily focus target: the "together streak".',
  {},
  async () => {
    await sync()
    return text({ streak: sharedFocusStreak(listPeople().map((p) => p.id)) })
  }
)

server.tool(
  'nudge_friend',
  'Send a friend a nudge. It appears as a card in their app, plus an OS notification. A buzz also shakes their window.',
  {
    to_person: z.string().describe('Recipient profile id (see list_people)'),
    message: z.string().describe('e.g. Study with me?'),
    kind: z.enum(['message', 'buzz']).optional().describe("'buzz' shakes their window; defaults to 'message'")
  },
  async ({ to_person, message, kind }) => {
    await sync()
    const n = sendNudge(selfId(), to_person, message, kind ?? 'message')
    await sync()
    return text({ sent: true, to: to_person, id: n.id, kind: n.kind })
  }
)

// ---- Goal detail ----
server.tool(
  'list_goal_todos',
  "Everything under one goal: open, finished (archived included) and its repeat rules. Use this rather than list_todos when asked about a goal's progress, since list_todos hides archived rows and would undercount.",
  { goal_id: z.string() },
  async ({ goal_id }) => {
    await sync()
    return text(listTodosForGoal(goal_id))
  }
)

server.tool(
  'update_goal',
  'Rename a goal, recolour it, or archive it. Sharing cannot be changed after creation.',
  {
    id: z.string(),
    title: z.string().optional(),
    color: z.string().optional().describe('Hex color, e.g. #2f7a4d'),
    archived: z.boolean().optional().describe('Archive the goal without deleting its history')
  },
  async ({ id, title, color, archived }) => {
    await sync()
    const result = updateGoal(id, {
      title,
      color,
      archived: archived === undefined ? undefined : archived ? 1 : 0
    })
    await sync()
    return result ? text(result) : text({ error: 'Goal not found', id })
  }
)

server.tool(
  'delete_goal',
  'Delete a goal permanently, along with any repeat rules attached to it. Finished todos under the goal are kept. Prefer update_goal with archived=true to retire a goal without losing it.',
  { id: z.string() },
  async ({ id }) => {
    await sync()
    deleteGoal(id)
    await sync()
    return text({ deleted: id })
  }
)

// ---- Recurrence rules ----
server.tool(
  'list_recurring',
  'List the repeat rules that generate todos and events. These templates are hidden from list_todos and list_events, so this is the only way to see or stop a repeat.',
  {},
  async () => {
    await sync()
    return text({ todos: listTodoTemplates(), events: listEventTemplates() })
  }
)

server.tool(
  'delete_recurring',
  'Stop a repeat rule. Use the template id from list_recurring. Unfinished generated items go with it; finished ones are kept as history.',
  {
    id: z.string().describe('Template id from list_recurring'),
    kind: z.enum(['todo', 'event']).describe('Which list the template came from')
  },
  async ({ id, kind }) => {
    await sync()
    if (kind === 'todo') deleteTodo(id)
    else deleteEvent(id)
    await sync()
    return text({ stopped: id, kind })
  }
)

// ---- Daily notes ----
server.tool(
  'get_note',
  "Read a person's free-text note for one day. Returns an empty body if nothing was written.",
  {
    day: z.string().optional().describe('Local date as YYYY-MM-DD; defaults to today'),
    person_id: z.string().optional().describe('Whose note; defaults to the current profile')
  },
  async ({ day, person_id }) => {
    await sync()
    return text(getDailyNote(day ?? localDay(), person_id ?? selfId()))
  }
)

server.tool(
  'set_note',
  "Replace a person's note for one day. This overwrites the whole note, so read it first if you mean to append.",
  {
    body: z.string().describe('Full note text'),
    day: z.string().optional().describe('Local date as YYYY-MM-DD; defaults to today'),
    person_id: z.string().optional().describe('Whose note; defaults to the current profile')
  },
  async ({ body, day, person_id }) => {
    await sync()
    const note = setDailyNote(day ?? localDay(), body, person_id ?? selfId())
    await sync()
    return text(note)
  }
)

server.tool(
  'list_note_days',
  'Days that have a non-empty note, newest first. Use with get_note to read back past days.',
  {
    person_id: z.string().optional().describe('Whose notes; defaults to the current profile'),
    limit: z.number().optional().describe('How many days back to list (default 30)')
  },
  async ({ person_id, limit }) => {
    await sync()
    return text(listNoteDays(person_id ?? selfId(), limit ?? 30))
  }
)

async function main() {
  // Register with the client FIRST so tools always appear quickly, even if the
  // initial cloud pull is slow. Opening the DB + pulling happens in the
  // background; each tool also syncs on demand.
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stderr only — stdout is reserved for the MCP protocol.
  console.error('[doneline-mcp] ready')
  initDb().catch((err) => console.error('[doneline-mcp] initDb failed:', err))
}

main().catch((err) => {
  console.error('[doneline-mcp] fatal:', err)
  process.exit(1)
})
