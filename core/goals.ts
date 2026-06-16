import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import type { Goal } from './types.js'

export function listGoals(opts: { includeArchived?: boolean; personId?: string } = {}): Goal[] {
  const db = getDb()
  const where: string[] = []
  const args: string[] = []
  if (!opts.includeArchived) where.push('archived = 0')
  if (opts.personId && opts.personId !== 'all') {
    where.push('person_id = ?')
    args.push(opts.personId)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM goals ${clause} ORDER BY created_at DESC`).all(...args) as Goal[]
}

export function getGoal(id: string): Goal | undefined {
  return getDb().prepare('SELECT * FROM goals WHERE id = ?').get(id) as Goal | undefined
}

export function createGoal(input: {
  title: string
  color?: string
  person_id?: string
  shared?: boolean
}): Goal {
  const db = getDb()
  const id = uuid()
  db.prepare('INSERT INTO goals (id, person_id, title, color, shared) VALUES (?, ?, ?, ?, ?)').run(
    id,
    input.person_id || primaryPersonId(),
    input.title.trim(),
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
    patch.title ?? current.title,
    patch.color ?? current.color,
    patch.archived ?? current.archived,
    id
  )
  return getGoal(id)
}

export function deleteGoal(id: string): void {
  getDb().prepare('DELETE FROM goals WHERE id = ?').run(id)
}
