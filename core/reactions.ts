import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import type { Reaction } from './types.js'

export function toggleReaction(todoId: string, personId: string, emoji: string): boolean {
  const db = getDb()
  const exists = db
    .prepare('SELECT 1 FROM reactions WHERE todo_id = ? AND person_id = ? AND emoji = ?')
    .get(todoId, personId, emoji)
  if (exists) {
    db.prepare('DELETE FROM reactions WHERE todo_id = ? AND person_id = ? AND emoji = ?').run(todoId, personId, emoji)
    return false
  }
  db.prepare('INSERT OR IGNORE INTO reactions (id, todo_id, person_id, emoji) VALUES (?, ?, ?, ?)').run(
    uuid(), todoId, personId, emoji
  )
  return true
}

export function listReactionsForTodo(todoId: string): Reaction[] {
  return getDb()
    .prepare('SELECT * FROM reactions WHERE todo_id = ? ORDER BY created_at')
    .all(todoId) as Reaction[]
}

export function listReactionsForTodos(todoIds: string[]): Reaction[] {
  if (todoIds.length === 0) return []
  const ph = todoIds.map(() => '?').join(',')
  return getDb()
    .prepare(`SELECT * FROM reactions WHERE todo_id IN (${ph}) ORDER BY created_at`)
    .all(...todoIds) as Reaction[]
}

/** Reactions on todos owned by `personId` from others, created after `since` ISO string. */
export function newReactionsFor(personId: string, since: string): Reaction[] {
  return getDb()
    .prepare(`
      SELECT r.* FROM reactions r
      JOIN todos t ON t.id = r.todo_id
      WHERE t.person_id = ? AND r.person_id != ? AND r.created_at >= ?
      ORDER BY r.created_at DESC
    `)
    .all(personId, personId, since) as Reaction[]
}
