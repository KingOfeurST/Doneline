import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import { logActivity } from './activityLog.js'
import type { Todo, TodoWithGoal } from './types.js'

const SELECT_WITH_GOAL = `
  SELECT t.*, g.title AS goal_title, g.color AS goal_color, g.shared AS goal_shared,
         (SELECT GROUP_CONCAT(person_id) FROM todo_completions WHERE todo_id = t.id) AS done_by,
         p.name AS person_name, p.emoji AS person_emoji
  FROM todos t
  LEFT JOIN goals g ON g.id = t.goal_id
  LEFT JOIN people p ON p.id = t.person_id
`

function personClause(personId?: string): { sql: string; args: string[] } {
  if (!personId || personId === 'all') return { sql: '', args: [] }
  return { sql: 't.person_id = ?', args: [personId] }
}

function and(...parts: string[]): string {
  const kept = parts.filter(Boolean)
  return kept.length ? `WHERE ${kept.join(' AND ')}` : ''
}

// Templates (recurrence set) are rules, not actionable items; archived items are
// hidden. Normal lists exclude both.
const VISIBLE = 't.recurrence IS NULL AND t.archived = 0'

export function listTodos(
  opts: { includeCompleted?: boolean; personId?: string } = {}
): TodoWithGoal[] {
  const p = personClause(opts.personId)
  const where = and(VISIBLE, opts.includeCompleted ? '' : 't.completed_at IS NULL', p.sql)
  const sql = `${SELECT_WITH_GOAL} ${where} ORDER BY t.completed_at IS NOT NULL, t.position, t.created_at`
  return getDb().prepare(sql).all(...p.args) as TodoWithGoal[]
}

/** Todos open or completed today, plus anything due today. Excludes templates/archived. */
export function listTodayTodos(dayISO: string, personId?: string): TodoWithGoal[] {
  const p = personClause(personId)
  const where = and(
    VISIBLE,
    '(t.completed_at IS NULL OR date(t.completed_at) = date(?) OR date(t.due_at) = date(?))',
    p.sql
  )
  const sql = `${SELECT_WITH_GOAL} ${where}
    ORDER BY t.completed_at IS NOT NULL, t.position, t.created_at`
  return getDb().prepare(sql).all(dayISO, dayISO, ...p.args) as TodoWithGoal[]
}

/** Archived (done, swept) todos, newest first. */
export function listArchivedTodos(personId?: string): TodoWithGoal[] {
  const p = personClause(personId)
  const where = and('t.archived = 1', p.sql)
  return getDb()
    .prepare(`${SELECT_WITH_GOAL} ${where} ORDER BY t.completed_at DESC`)
    .all(...p.args) as TodoWithGoal[]
}

/** Recurrence templates (the repeat rules). */
export function listTodoTemplates(): Todo[] {
  return getDb()
    .prepare('SELECT * FROM todos WHERE recurrence IS NOT NULL ORDER BY created_at')
    .all() as Todo[]
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
  recurrence?: string | null
  recur_parent?: string | null
}): TodoWithGoal {
  const db = getDb()
  const id = uuid()
  const nextPos = (
    db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM todos').get() as { p: number }
  ).p
  db.prepare(
    `INSERT INTO todos (id, person_id, title, goal_id, notes, due_at, position, recurrence, recur_parent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.person_id || primaryPersonId(),
    input.title.trim(),
    input.goal_id ?? null,
    input.notes ?? null,
    input.due_at ?? null,
    nextPos,
    input.recurrence ?? null,
    input.recur_parent ?? null
  )
  const t = getTodo(id)!
  logActivity(t.person_id, 'todo:created', { title: t.title })
  return t
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

/**
 * Toggle or set completion. For a todo under a shared goal, this records the
 * completion for `selfPersonId` only; the todo is "fully done" (completed_at set)
 * once every person has completed it.
 */
export function setTodoDone(id: string, done?: boolean, selfPersonId?: string): TodoWithGoal | undefined {
  const db = getDb()
  const cur = getTodo(id)
  if (!cur) return undefined

  if (cur.goal_shared === 1) {
    const self = selfPersonId || primaryPersonId()
    const has = db
      .prepare('SELECT 1 FROM todo_completions WHERE todo_id = ? AND person_id = ?')
      .get(id, self)
    const shouldComplete = done === undefined ? !has : done
    if (shouldComplete) {
      db.prepare('INSERT OR IGNORE INTO todo_completions (todo_id, person_id) VALUES (?, ?)').run(id, self)
    } else {
      db.prepare('DELETE FROM todo_completions WHERE todo_id = ? AND person_id = ?').run(id, self)
    }
    const total = (db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n
    const doneCount = (
      db.prepare('SELECT COUNT(*) AS n FROM todo_completions WHERE todo_id = ?').get(id) as { n: number }
    ).n
    const fullyDone = total > 0 && doneCount >= total
    db.prepare('UPDATE todos SET completed_at = ? WHERE id = ?').run(
      fullyDone ? new Date().toISOString() : null,
      id
    )
    if (shouldComplete) logActivity(self, 'todo:completed', { title: cur.title })
    return getTodo(id)
  }

  const shouldComplete = done === undefined ? cur.completed_at === null : done
  db.prepare('UPDATE todos SET completed_at = ? WHERE id = ?').run(
    shouldComplete ? new Date().toISOString() : null,
    id
  )
  if (shouldComplete) {
    const self = selfPersonId || primaryPersonId()
    logActivity(self, 'todo:completed', { title: cur.title })
  }
  return getTodo(id)
}

export function deleteTodo(id: string): void {
  // Deleting a template removes its future instances too.
  const db = getDb()
  db.prepare('DELETE FROM todos WHERE id = ? OR recur_parent = ?').run(id, id)
  db.prepare('DELETE FROM todo_completions WHERE todo_id = ?').run(id)
}

/** Archive todos completed before `dayISO` (kept in DB, hidden from lists). */
export function archiveDoneBefore(dayISO: string): number {
  const r = getDb()
    .prepare(
      `UPDATE todos SET archived = 1
       WHERE archived = 0 AND recurrence IS NULL
         AND completed_at IS NOT NULL AND date(completed_at) < date(?)`
    )
    .run(dayISO)
  return r.changes as number
}

/** Permanently delete archived todos completed more than `days` ago. */
export function purgeArchivedOlderThan(days: number): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const r = getDb()
    .prepare('DELETE FROM todos WHERE archived = 1 AND completed_at IS NOT NULL AND completed_at < ?')
    .run(cutoff)
  return r.changes as number
}

/** Bulk-update positions after a drag-to-reorder. */
export function reorderTodos(updates: { id: string; position: number }[]): void {
  const db = getDb()
  const stmt = db.prepare('UPDATE todos SET position = ? WHERE id = ?')
  for (const u of updates) stmt.run(u.position, u.id)
}
