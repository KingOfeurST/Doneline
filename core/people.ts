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
  db.transaction(() => {
    db.prepare('INSERT INTO people (id, name, color, emoji, position) VALUES (?, ?, ?, ?, ?)').run(
      id,
      input.name.trim() || 'Someone',
      input.color || '#2f6f9c',
      input.emoji || '🙂',
      nextPos
    )
    recalculateSharedCompletions()
  }).immediate()
  return getPerson(id)!
}

export function updatePerson(
  id: string,
  patch: Partial<Pick<Person, 'name' | 'color' | 'emoji'>>
): Person | undefined {
  const cur = getPerson(id)
  if (!cur) return undefined
  const name = (patch.name ?? cur.name).trim()
  if (!name) throw new Error('Please enter a profile name.')
  getDb()
    .prepare('UPDATE people SET name = ?, color = ?, emoji = ? WHERE id = ?')
    .run(name, patch.color ?? cur.color, patch.emoji ?? cur.emoji, id)
  return getPerson(id)
}

/** Delete a person and everything they own. Refuses to remove the last person. */
export function deletePerson(id: string): void {
  const db = getDb()
  db.transaction(() => {
    if (!getPerson(id)) return
    const count = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
    if (count <= 1) throw new Error('Cannot delete the last profile.')
    const ownedTasks = 'SELECT id FROM todos WHERE person_id = ? OR recur_parent IN (SELECT id FROM todos WHERE person_id = ?)'
    db.prepare(`DELETE FROM recurrence_exclusions WHERE
      (kind = 'task' AND parent_id IN (${ownedTasks} UNION SELECT item_id FROM trash_items WHERE kind = 'task' AND person_id = ?)) OR
      (kind = 'event' AND parent_id IN (SELECT id FROM events WHERE person_id = ? OR recur_parent IN (SELECT id FROM events WHERE person_id = ?)
        UNION SELECT item_id FROM trash_items WHERE kind = 'event' AND person_id = ?))`).run(id, id, id, id, id, id)
    // Remove dependent rows before deleting owned work and its generated children.
    db.prepare('DELETE FROM todo_completions WHERE person_id = ?').run(id)
    db.prepare(`DELETE FROM todo_completions WHERE todo_id IN (${ownedTasks})`).run(id, id)
    db.prepare('DELETE FROM reactions WHERE person_id = ?').run(id)
    db.prepare(`DELETE FROM reactions WHERE todo_id IN (${ownedTasks})`).run(id, id)
    db.prepare(`DELETE FROM todos WHERE id IN (${ownedTasks})`).run(id, id)
    db.prepare('DELETE FROM goals WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM events WHERE person_id = ? OR recur_parent IN (SELECT id FROM events WHERE person_id = ?)').run(id, id)

    // Anything keyed to the deleted person must leave the workspace as well.
    db.prepare('DELETE FROM presence WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM daily_notes WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM focus_sessions WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM nudges WHERE from_person = ? OR to_person = ?').run(id, id)
    db.prepare('DELETE FROM focus_invites WHERE from_person = ? OR to_person = ?').run(id, id)
    db.prepare('DELETE FROM settings WHERE key = ?').run(`caldav:${id}`)
    db.prepare('DELETE FROM calendar_tombstones WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM calendar_resources WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM calendar_resource_changes WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM trash_items WHERE person_id = ?').run(id)
    db.prepare('DELETE FROM people WHERE id = ?').run(id)

    // Preserve work belonging to someone else while removing dead references.
    db.prepare('UPDATE todos SET goal_id = NULL WHERE goal_id IS NOT NULL AND goal_id NOT IN (SELECT id FROM goals)').run()
    db.prepare('UPDATE focus_sessions SET task_id = NULL WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM todos)').run()
    recalculateSharedCompletions()
  }).immediate()
}

/** Membership changes alter shared completion only for work still in circulation. */
function recalculateSharedCompletions(): void {
  getDb().prepare(`
    UPDATE todos SET completed_at = CASE
      WHEN (SELECT COUNT(*) FROM todo_completions c JOIN people p ON p.id = c.person_id WHERE c.todo_id = todos.id)
        >= (SELECT COUNT(*) FROM people)
      THEN COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ELSE NULL END
    WHERE archived = 0 AND recurrence IS NULL AND goal_id IN (SELECT id FROM goals WHERE shared = 1)
  `).run()
}
