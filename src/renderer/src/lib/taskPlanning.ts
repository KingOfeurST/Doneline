import type { TodoWithGoal } from '../../../shared/api'
import { isTodoDoneForSelf } from './todoCompletion'
import { fmtTime, localDateInput, localTimeInput, toISO } from './format'
import { localDay } from './calendarLayout'

export type TaskGroup = 'today' | 'overdue' | 'upcoming' | 'undated'
export const TASK_GROUPS: { id: TaskGroup; label: string; expanded: boolean }[] = [
  { id: 'today', label: 'Today', expanded: true },
  { id: 'overdue', label: 'Overdue', expanded: true },
  { id: 'upcoming', label: 'Upcoming', expanded: false },
  { id: 'undated', label: 'No date', expanded: false }
]

export function taskGroup(todo: TodoWithGoal, today: string): TaskGroup {
  if (!todo.due_at) return 'undated'
  const date = new Date(todo.due_at)
  if (!Number.isFinite(date.getTime())) return 'undated'
  const day = localDateInput(date)
  return day < today ? 'overdue' : day > today ? 'upcoming' : 'today'
}

export function groupTasks(todos: TodoWithGoal[], today: string, self: string) {
  const groups: Record<TaskGroup, TodoWithGoal[]> = { today: [], overdue: [], upcoming: [], undated: [] }
  const finished: TodoWithGoal[] = []
  for (const todo of todos) {
    if (todo.recurrence || todo.archived) continue
    if (isTodoDoneForSelf(todo, self)) finished.push(todo)
    else groups[taskGroup(todo, today)].push(todo)
  }
  return { groups, finished, remaining: Object.values(groups).reduce((sum, rows) => sum + rows.length, 0) }
}

export function tomorrowDay(today: string): string {
  const date = localDay(today)
  date.setDate(date.getDate() + 1)
  return localDateInput(date)
}

/** Keep an existing due time; a previously undated task starts at 09:00. */
export function rescheduledDue(todo: TodoWithGoal, day: string | null): string | null {
  if (day === null) return null
  const oldDate = todo.due_at ? new Date(todo.due_at) : null
  const time = oldDate && Number.isFinite(oldDate.getTime()) ? localTimeInput(oldDate) : '09:00'
  return toISO(day, time)
}

export function taskDateLabel(todo: TodoWithGoal, today: string): string {
  if (!todo.due_at) return 'No date'
  const date = new Date(todo.due_at)
  if (!Number.isFinite(date.getTime())) return 'No date'
  const day = localDateInput(date)
  if (day === today) return fmtTime(todo.due_at)
  if (day === tomorrowDay(today)) return 'Tomorrow'
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' } : {}) })
}
