import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import type { Goal } from './types.js'
import { deleteTodo } from './todos.js'
import { itemTitle } from './validation.js'

// Progress counts live in SQL so archived todos still count — otherwise a goal's
// progress bar silently resets every time completed todos get swept to the archive.
const SELECT_WITH_COUNTS = `
  SELECT g.*,
    (SELECT COUNT(*) FROM todos t
      WHERE t.goal_id = g.id AND t.recurrence IS NULL) AS todo_total,
    (SELECT COUNT(*) FROM todos t
      WHERE t.goal_id = g.id AND t.recurrence IS NULL AND t.completed_at IS NOT NULL) AS todo_done
  FROM goals g
`

export function listGoals(opts: { includeArchived?: boolean; personId?: string } = {}): Goal[] {
  const db = getDb()
  const where: string[] = []
  const args: string[] = []
  if (!opts.includeArchived) where.push('g.archived = 0')
  if (opts.personId && opts.personId !== 'all') {
    where.push('(g.person_id = ? OR g.shared = 1)')
    args.push(opts.personId)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db
    .prepare(`${SELECT_WITH_COUNTS} ${clause} ORDER BY g.created_at DESC`)
    .all(...args) as Goal[]
}

export function getGoal(id: string): Goal | undefined {
  return getDb().prepare(`${SELECT_WITH_COUNTS} WHERE g.id = ?`).get(id) as Goal | undefined
}

export function createGoal(input: {
  title: string
  color?: string
  person_id?: string
  shared?: boolean
}): Goal {
  const db = getDb()
  const id = uuid()
  const owner = input.person_id || primaryPersonId()
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(owner)) throw new Error('This profile no longer exists.')
  db.prepare('INSERT INTO goals (id, person_id, title, color, shared) VALUES (?, ?, ?, ?, ?)').run(
    id,
    owner,
    itemTitle(input.title),
    input.color || '#2f7a4d',
    input.shared ? 1 : 0
  )
  return getGoal(id)!
}

export function updateGoal(
  id: string,
  patch: Partial<Pick<Goal, 'title' | 'color' | 'archived'>>
): Goal | undefined {
  const db = getDb()
  const current = getGoal(id)
  if (!current) return undefined
  db.prepare('UPDATE goals SET title = ?, color = ?, archived = ? WHERE id = ?').run(
    itemTitle(patch.title ?? current.title),
    patch.color ?? current.color,
    patch.archived ?? current.archived,
    id
  )
  return getGoal(id)
}

export function deleteGoal(id: string): void {
  const db = getDb()
  const remove = () => deleteGoalInTransaction(id)
  if (db.inTransaction) remove()
  else db.transaction(remove).immediate()
}

function deleteGoalInTransaction(id: string): void {
  const db = getDb()
  // The confirmation promises to remove the goal and all its linked work.
  const tplIds = (
    db.prepare('SELECT id FROM todos WHERE goal_id = ? ORDER BY recurrence IS NULL').all(id) as { id: string }[]
  ).map((r) => r.id)
  for (const tplId of tplIds) {
    deleteTodo(tplId)
  }
  db.prepare('DELETE FROM goals WHERE id = ?').run(id)
}
