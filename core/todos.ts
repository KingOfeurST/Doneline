import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import type { Todo, TodoWithGoal } from './types.js'

const SELECT_WITH_GOAL = `
  SELECT t.*, g.title AS goal_title, g.color AS goal_color,
         p.name AS person_name, p.emoji AS person_emoji
  FROM todos t
  LEFT JOIN goals g ON g.id = t.goal_id
  LEFT JOIN people p ON p.id = t.person_id
`

/** Build a "WHERE person matches" clause. Pass undefined / 'all' for every person. */
function personClause(personId?: string): { sql: string; args: string[] } {
  if (!personId || personId === 'all') return { sql: '', args: [] }
  return { sql: 't.person_id = ?', args: [personId] }
}

function and(...parts: string[]): string {
  const kept = parts.filter(Boolean)
  return kept.length ? `WHERE ${kept.join(' AND ')}` : ''
}

export function listTodos(
  opts: { includeCompleted?: boolean; personId?: string } = {}
): TodoWithGoal[] {
  const p = personClause(opts.personId)
  const where = and(opts.includeCompleted ? '' : 't.completed_at IS NULL', p.sql)
  const sql = `${SELECT_WITH_GOAL} ${where} ORDER BY t.completed_at IS NOT NULL, t.position, t.created_at`
  return getDb().prepare(sql).all(...p.args) as TodoWithGoal[]
}

/** Todos that are open or were completed today, plus anything due today. */
export function listTodayTodos(dayISO: string, personId?: string): TodoWithGoal[] {
  const p = personClause(personId)
  const where = and(
    '(t.completed_at IS NULL OR date(t.completed_at) = date(?) OR date(t.due_at) = date(?))',
    p.sql
  )
  const sql = `${SELECT_WITH_GOAL} ${where}
    ORDER BY t.completed_at IS NOT NULL, t.position, t.created_at`
  return getDb().prepare(sql).all(dayISO, dayISO, ...p.args) as TodoWithGoal[]
}

export function getTodo(id: string): TodoWithGoal | undefined {
  return getDb().prepare(`${SELECT_WITH_GOAL} WHERE t.id = ?`).get(id) as TodoWithGoal | undefined
}

export function createTodo(input: {
  title: string
  person_id?: string
  goal_id?: string | null
  notes?: string | null
  due_at?: string | null
}): TodoWithGoal {
  const db = getDb()
  const id = uuid()
  const nextPos = (
    db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM todos').get() as { p: number }
  ).p
  db.prepare(
    'INSERT INTO todos (id, person_id, title, goal_id, notes, due_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    input.person_id || primaryPersonId(),
    input.title.trim(),
    input.goal_id ?? null,
    input.notes ?? null,
    input.due_at ?? null,
    nextPos
  )
  return getTodo(id)!
}

export function updateTodo(
  id: string,
  patch: Partial<Pick<Todo, 'title' | 'goal_id' | 'notes' | 'due_at' | 'position' | 'person_id'>>
): TodoWithGoal | undefined {
  const db = getDb()
  const cur = getTodo(id)
  if (!cur) return undefined
  db.prepare(
    'UPDATE todos SET title = ?, goal_id = ?, notes = ?, due_at = ?, position = ?, person_id = ? WHERE id = ?'
  ).run(
    patch.title ?? cur.title,
    patch.goal_id === undefined ? cur.goal_id : patch.goal_id,
    patch.notes === undefined ? cur.notes : patch.notes,
    patch.due_at === undefined ? cur.due_at : patch.due_at,
    patch.position ?? cur.position,
    patch.person_id ?? cur.person_id,
    id
  )
  return getTodo(id)
}

/** Toggle or set completion. Pass `done` to force a state, omit to toggle. */
export function setTodoDone(id: string, done?: boolean): TodoWithGoal | undefined {
  const cur = getTodo(id)
  if (!cur) return undefined
  const shouldComplete = done === undefined ? cur.completed_at === null : done
  const value = shouldComplete ? new Date().toISOString() : null
  getDb().prepare('UPDATE todos SET completed_at = ? WHERE id = ?').run(value, id)
  return getTodo(id)
}

export function deleteTodo(id: string): void {
  getDb().prepare('DELETE FROM todos WHERE id = ?').run(id)
}
