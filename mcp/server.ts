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
  listTodos,
  listTodayTodos,
  listArchivedTodos,
  createTodo,
  updateTodo,
  setTodoDone,
  deleteTodo,
  listEvents,
  listDayEvents,
  createEvent,
  syncCalendar,
  getCalDavConfig,
  runMaintenance,
  sendNudge,
  localDay,
  type Recurrence
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

/** This device's profile id, for mutual-todo completion and nudges. */
const selfId = () => getSelfPersonId() ?? primaryPersonId()

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
  'List the profiles (people) in Doneline. Use a person id to scope other tools to one person; omit it to act on the primary profile.',
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
  'Add a todo. Optionally link a goal, a due date/time (ISO 8601), a person id (defaults to primary), and a repeat rule (daily/weekly).',
  {
    title: z.string().describe('What needs doing'),
    person_id: z.string().optional().describe('Owner profile id; defaults to primary'),
    goal_id: z.string().optional().describe('Goal id to link this todo to'),
    due_at: z.string().optional().describe('Due date/time as ISO 8601, e.g. 2026-06-15T09:00:00'),
    notes: z.string().optional(),
    ...repeatSchema
  },
  async ({ title, person_id, goal_id, due_at, notes, repeat, repeat_days }) => {
    await sync()
    const recurrence = recurrenceJson(repeat, repeat_days)
    const todo = createTodo({
      title,
      person_id: person_id ?? primaryPersonId(),
      goal_id: goal_id ?? null,
      due_at: due_at ?? null,
      notes: notes ?? null,
      recurrence
    })
    if (recurrence) runMaintenance() // generate today's instance from the template
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
  'Edit a todo — change title, due date/time (ISO 8601), linked goal, or owner.',
  {
    id: z.string(),
    title: z.string().optional(),
    due_at: z.string().nullable().optional(),
    goal_id: z.string().nullable().optional(),
    person_id: z.string().optional()
  },
  async ({ id, title, due_at, goal_id, person_id }) => {
    await sync()
    const result = updateTodo(id, { title, due_at, goal_id, person_id })
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
  'List goals (all people unless person_id is given).',
  { person_id: z.string().optional().describe('Limit to one person; omit for everyone') },
  async ({ person_id }) => {
    await sync()
    return text(listGoals({ personId: person_id }))
  }
)

server.tool(
  'add_goal',
  'Create a goal. Set shared=true so every todo under it must be completed by both people.',
  {
    title: z.string(),
    person_id: z.string().optional().describe('Owner profile id; defaults to primary'),
    color: z.string().optional().describe('Hex color, e.g. #2f7a4d'),
    shared: z.boolean().optional().describe('Shared goal — todos need everyone to complete')
  },
  async ({ title, person_id, color, shared }) => {
    await sync()
    const goal = createGoal({ title, person_id: person_id ?? primaryPersonId(), color, shared })
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

// ---- Events ----
server.tool(
  'list_events',
  'List calendar events, optionally within an ISO date range (all people unless person_id is given).',
  {
    from: z.string().optional().describe('ISO start of range'),
    to: z.string().optional().describe('ISO end of range'),
    person_id: z.string().optional().describe('Limit to one person; omit for everyone')
  },
  async ({ from, to, person_id }) => {
    await sync()
    return text(listEvents({ from, to, personId: person_id }))
  }
)

server.tool(
  'add_event',
  'Add a calendar event (may span multiple days via ends_at, and repeat). Syncs to Apple Calendar if the owner has one connected.',
  {
    title: z.string(),
    starts_at: z.string().describe('ISO 8601 start, e.g. 2026-06-15T15:45:00'),
    ends_at: z.string().describe('ISO 8601 end (use a later day for multi-day events)'),
    person_id: z.string().optional().describe('Owner profile id; defaults to primary'),
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
      starts_at: args.starts_at,
      ends_at: args.ends_at,
      person_id: args.person_id ?? primaryPersonId(),
      all_day: args.all_day,
      location: args.location ?? null,
      notes: args.notes ?? null,
      attendees: args.attendees ?? null,
      color: args.color,
      recurrence
    })
    if (recurrence) runMaintenance()
    await sync()
    return text(ev)
  }
)

// ---- Calendar sync ----
server.tool(
  'sync_calendar',
  "Run a two-way sync with a person's connected Apple/iCloud calendar (defaults to the primary profile).",
  { person_id: z.string().optional().describe('Profile id to sync; defaults to primary') },
  async ({ person_id }) => {
    await sync()
    const pid = person_id ?? primaryPersonId()
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
  'nudge_friend',
  'Send a friend a nudge (an OS notification on their device).',
  {
    to_person: z.string().describe('Recipient profile id (see list_people)'),
    message: z.string().describe("e.g. \"Let's focus 👊\"")
  },
  async ({ to_person, message }) => {
    await sync()
    sendNudge(selfId(), to_person, message)
    await sync()
    return text({ sent: true, to: to_person })
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
