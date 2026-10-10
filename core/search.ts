import { getDb } from './db.js'
import { listTodos, listArchivedTodos } from './todos.js'
import { listGoals } from './goals.js'
import { listEvents } from './events.js'
import type { TodoWithGoal, CalEvent, Goal, DailyNote } from './types.js'

export interface SearchInput {
  query: string
  personId?: string
  /** Maximum results per group. */
  limit?: number
}

export interface SearchResults {
  todos: TodoWithGoal[]
  events: CalEvent[]
  goals: Goal[]
  notes: DailyNote[]
}

/** Case and accent insensitive; punctuation is literal, never a SQL wildcard. */
export function searchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim()
}

export function searchWorkspace(input: SearchInput): SearchResults {
  if (!input || typeof input.query !== 'string') throw new Error('Enter text to search.')
  const query = searchText(input.query)
  if (query.length > 200) throw new Error('Keep searches under 200 characters.')
  const limit = input.limit ?? 20
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Search limit must be from 1 to 50.')
  const empty: SearchResults = { todos: [], events: [], goals: [], notes: [] }
  if (!query) return empty
  const terms = query.split(/\s+/)
  const matches = (text: string) => terms.every((term) => searchText(text).includes(term))
  const rank = (title: string) => {
    const folded = searchText(title)
    return folded.startsWith(query) ? 0 : folded.includes(query) ? 1 : 2
  }
  const ranked = <T>(rows: T[], title: (row: T) => string, content: (row: T) => string): T[] => rows
    .filter((row) => matches(content(row)))
    .map((row, index) => ({ row, index, score: rank(title(row)) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit).map(({ row }) => row)
  const personId = input.personId
  const notes = getDb().prepare(`SELECT n.* FROM daily_notes n
    INNER JOIN people p ON p.id = n.person_id
    WHERE TRIM(n.body) != '' ${personId && personId !== 'all' ? 'AND n.person_id = ?' : ''}
    ORDER BY n.day DESC, n.person_id`).all(...(personId && personId !== 'all' ? [personId] : [])) as DailyNote[]
  return {
    todos: ranked([...listTodos({ includeCompleted: true, personId }), ...listArchivedTodos(personId)].filter((todo) => !todo.recurrence),
      (todo) => todo.title, (todo) => `${todo.title}\n${todo.notes || ''}\n${todo.goal_title || ''}`),
    events: ranked(listEvents({ personId }), (event) => event.title,
      (event) => `${event.title}\n${event.location || ''}\n${event.notes || ''}\n${event.attendees || ''}`),
    goals: ranked(listGoals({ includeArchived: true, personId }), (goal) => goal.title, (goal) => goal.title),
    notes: ranked(notes, (note) => note.body, (note) => `${note.day}\n${note.body}`)
  }
}
