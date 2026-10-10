import { getDb } from './db.js'
import { listEvents, deleteEvent } from './events.js'
import { getTodo, deleteTodo } from './todos.js'
import { ensureTodoInstancesForRange } from './recurrence.js'
import { parseLocalDate } from './recurrenceRules.js'
import type { CalEvent, TodoWithGoal } from './types.js'

export interface RemovalRange {
  kind: 'events' | 'todos' | 'both'
  fromDay: string
  toDay: string
  title?: string
  personId?: string
  /** Optional preview snapshot. Reject a changed match set instead of deleting new matches. */
  expectedIds?: string[]
}

function bounds(input: RemovalRange): { from: string; to: string } {
  if (!['events', 'todos', 'both'].includes(input.kind)) throw new Error('Choose events, todos, or both.')
  const from = parseLocalDate(input.fromDay)
  const last = parseLocalDate(input.toDay)
  if (last < from) throw new Error('The last date must be on or after the first date.')
  if ((last.getTime() - from.getTime()) / 86_400_000 > 3660) throw new Error('Choose a range of ten years or less.')
  last.setDate(last.getDate() + 1)
  return { from: from.toISOString(), to: last.toISOString() }
}

/** Preview actual dated items, never the repeat rules themselves. */
export function previewRemoval(input: RemovalRange): { events: CalEvent[]; todos: TodoWithGoal[] } {
  const range = bounds(input)
  const title = input.title?.trim().toLocaleLowerCase() ?? ''
  const matches = (item: { title: string; person_id: string }) =>
    (!input.personId || input.personId === 'all' || item.person_id === input.personId) &&
    (!title || item.title.toLocaleLowerCase().includes(title))
  const events = input.kind === 'todos' ? [] : listEvents(range).filter(matches)
  let todos: TodoWithGoal[] = []
  if (input.kind !== 'events') {
    ensureTodoInstancesForRange(input.fromDay, input.toDay)
    const rows = getDb().prepare(`SELECT id FROM todos WHERE recurrence IS NULL
      AND due_at >= ? AND due_at < ? ORDER BY due_at, created_at`).all(range.from, range.to) as { id: string }[]
    todos = rows.map((r) => getTodo(r.id)!).filter(matches)
  }
  return { events, todos }
}

/** Exclusions written by deleteEvent/deleteTodo keep removed occurrences removed. */
export function removeRange(input: RemovalRange): { events: number; todos: number } {
  const db = getDb()
  const remove = () => removeInTransaction(input)
  return db.inTransaction ? remove() : db.transaction(remove).immediate()
}

function removeInTransaction(input: RemovalRange): { events: number; todos: number } {
  const preview = previewRemoval(input)
  if (input.expectedIds) {
    const current = [...preview.events.map((e) => `events:${e.id}`), ...preview.todos.map((t) => `todos:${t.id}`)].sort()
    const expected = [...input.expectedIds].sort()
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('The matching items changed. Preview them again before removing.')
  }
  for (const event of preview.events) deleteEvent(event.id)
  for (const todo of preview.todos) deleteTodo(todo.id)
  return { events: preview.events.length, todos: preview.todos.length }
}
