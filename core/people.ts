import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import type { Person } from './types.js'

export function listPeople(): Person[] {
  return getDb().prepare('SELECT * FROM people ORDER BY position, created_at').all() as Person[]
}

export function getPerson(id: string): Person | undefined {
  return getDb().prepare('SELECT * FROM people WHERE id = ?').get(id) as Person | undefined
}

/** The default owner for new items and the MCP server (first person by order). */
export function primaryPersonId(): string {
  const row = getDb()
    .prepare('SELECT id FROM people ORDER BY position, created_at LIMIT 1')
    .get() as { id: string } | undefined
  return row?.id ?? ''
}

export function createPerson(input: { name: string; color?: string; emoji?: string }): Person {
  const db = getDb()
  const id = uuid()
  const nextPos = (
    db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM people').get() as { p: number }
  ).p
  db.prepare('INSERT INTO people (id, name, color, emoji, position) VALUES (?, ?, ?, ?, ?)').run(
    id,
    input.name.trim() || 'Someone',
    input.color || '#2f6f9c',
    input.emoji || '🙂',
    nextPos
  )
  return getPerson(id)!
}

export function updatePerson(
  id: string,
  patch: Partial<Pick<Person, 'name' | 'color' | 'emoji'>>
): Person | undefined {
  const cur = getPerson(id)
  if (!cur) return undefined
  getDb()
    .prepare('UPDATE people SET name = ?, color = ?, emoji = ? WHERE id = ?')
    .run(patch.name ?? cur.name, patch.color ?? cur.color, patch.emoji ?? cur.emoji, id)
  return getPerson(id)
}

/** Delete a person and everything they own. Refuses to remove the last person. */
export function deletePerson(id: string): void {
  const db = getDb()
  const count = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
  if (count <= 1) throw new Error('Cannot delete the last profile.')
  db.prepare('DELETE FROM todos WHERE person_id = ?').run(id)
  db.prepare('DELETE FROM goals WHERE person_id = ?').run(id)
  db.prepare('DELETE FROM events WHERE person_id = ?').run(id)
  db.prepare('DELETE FROM people WHERE id = ?').run(id)
}
