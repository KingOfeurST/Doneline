import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { primaryPersonId } from './people.js'
import type { Todo, TodoWithGoal } from './types.js'
import { normalizeRecurrenceJson, localDateKey, parseLocalDate } from './recurrenceRules.js'
import { excludeOccurrence, withEffectiveRecurrence } from './exclusions.js'
import { itemTitle, timestamp } from './validation.js'
import { captureDeletedItem } from './trash.js'

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
  return { sql: '(t.person_id = ? OR g.shared = 1)', args: [personId] }
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

/** Todos open or completed today, plus anything due today. Excludes templates/archived.
 *
 *  `due_at` and `completed_at` are stored as UTC ISO strings, but `dayISO` is a
 *  local calendar day, so the stored values must be converted with 'localtime'
 *  before comparing. Without it, anything timestamped between midnight and the
 *  UTC offset (e.g. 00:30 in Paris) resolves to the previous day and disappears. */
export function listTodayTodos(dayISO: string, personId?: string): TodoWithGoal[] {
  const p = personClause(personId)
  const start = parseLocalDate(dayISO)
  const end = new Date(start); end.setDate(end.getDate() + 1)
  const where = and(
    VISIBLE,
    // Calendar navigation may materialize future recurring work. Keep it out of
    // earlier Today views until its due day arrives.
    '(t.recur_parent IS NULL OR t.due_at IS NULL OR t.due_at < ?)',
    `(t.completed_at IS NULL
       OR (t.completed_at >= ? AND t.completed_at < ?)
       OR (t.due_at >= ? AND t.due_at < ?))`,
    p.sql
  )
  const sql = `${SELECT_WITH_GOAL} ${where}
    ORDER BY t.completed_at IS NOT NULL, t.position, t.created_at`
  return getDb().prepare(sql).all(end.toISOString(), start.toISOString(), end.toISOString(), start.toISOString(), end.toISOString(), ...p.args) as TodoWithGoal[]
}

/** All remaining work for planning, including dated future instances. Finished
 * work stays available for the collapsed section until it is archived. */
export function listPlannedTodos(dayISO: string, personId?: string): TodoWithGoal[] {
  parseLocalDate(dayISO)
  return listTodos({ includeCompleted: true, personId })
}

/** Archived (done, swept) todos, newest first. */
export function listArchivedTodos(personId?: string): TodoWithGoal[] {
  const p = personClause(personId)
  const where = and('t.archived = 1', p.sql)
  return getDb()
    .prepare(`${SELECT_WITH_GOAL} ${where} ORDER BY t.completed_at DESC`)
    .all(...p.args) as TodoWithGoal[]
}

/**
 * Everything linked to one goal, archived included, newest activity first.
 *
 * The normal listings hide archived rows, so a goal's finished work became
 * invisible once the nightly sweep ran. The detail view needs the full history,
 * so this deliberately ignores the archived filter. Recurrence templates are
 * returned separately since they are rules, not tasks.
 */
export function listTodosForGoal(goalId: string): {
  open: TodoWithGoal[]
  done: TodoWithGoal[]
  templates: TodoWithGoal[]
} {
  const rows = getDb()
    .prepare(
      `${SELECT_WITH_GOAL} WHERE t.goal_id = ?
       ORDER BY t.completed_at IS NOT NULL, t.position, t.created_at`
    )
    .all(goalId) as TodoWithGoal[]
  return {
    open: rows.filter((t) => t.recurrence === null && t.completed_at === null),
    done: rows
      .filter((t) => t.recurrence === null && t.completed_at !== null)
      .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')),
    templates: rows.filter((t) => t.recurrence !== null).map((row) => withEffectiveRecurrence('todos', row))
  }
}

/** Recurrence templates (the repeat rules), with owner and goal joined in so the
 *  settings list can show whose rule it is. */
export function listTodoTemplates(): TodoWithGoal[] {
  const rows = getDb()
    .prepare(`${SELECT_WITH_GOAL} WHERE t.recurrence IS NOT NULL ORDER BY t.created_at`)
    .all() as TodoWithGoal[]
  return rows.map((row) => withEffectiveRecurrence('todos', row))
}

export function getTodo(id: string): TodoWithGoal | undefined {
  const row = getDb().prepare(`${SELECT_WITH_GOAL} WHERE t.id = ?`).get(id) as TodoWithGoal | undefined
  return row ? withEffectiveRecurrence('todos', row) : undefined
}

export function createTodo(input: {
  title: string
  person_id?: string
  goal_id?: string | null
  notes?: string | null
  due_at?: string | null
  recurrence?: string | null
  recur_parent?: string | null
}, internal: { id?: string } = {}): TodoWithGoal {
  const db = getDb()
  const id = internal.id ?? uuid()
  const owner = input.person_id || primaryPersonId()
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(owner)) throw new Error('This profile no longer exists.')
  if (input.goal_id && !db.prepare('SELECT 1 FROM goals WHERE id = ?').get(input.goal_id)) throw new Error('This goal no longer exists.')
  const dueAt = input.due_at ? timestamp(input.due_at, 'Due date') : null
  const recurrence = normalizeRecurrenceJson(input.recurrence ?? null, dueAt ? localDateKey(new Date(dueAt)) : undefined)
  const nextPos = (
    db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM todos').get() as { p: number }
  ).p
  db.prepare(
    `INSERT INTO todos (id, person_id, title, goal_id, notes, due_at, position, recurrence, recur_parent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    owner,
    itemTitle(input.title),
    input.goal_id ?? null,
    input.notes ?? null,
    dueAt,
    nextPos,
    recurrence,
    input.recur_parent ?? null
  )
  return getTodo(id)!
}

export function updateTodo(
  id: string,
  patch: Partial<Pick<Todo, 'title' | 'goal_id' | 'notes' | 'due_at' | 'position' | 'person_id' | 'recurrence'>>
): TodoWithGoal | undefined {
  const db = getDb()
  const update = () => updateTodoInTransaction(id, patch)
  return db.inTransaction ? update() : db.transaction(update).immediate()
}

function updateTodoInTransaction(
  id: string,
  patch: Partial<Pick<Todo, 'title' | 'goal_id' | 'notes' | 'due_at' | 'position' | 'person_id' | 'recurrence'>>
): TodoWithGoal | undefined {
  const db = getDb()
  const cur = getTodo(id)
  if (!cur) return undefined
  const title = itemTitle(patch.title ?? cur.title)
  const owner = patch.person_id ?? cur.person_id
  const goal = patch.goal_id === undefined ? cur.goal_id : patch.goal_id
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(owner)) throw new Error('This profile no longer exists.')
  if (goal && !db.prepare('SELECT 1 FROM goals WHERE id = ?').get(goal)) throw new Error('This goal no longer exists.')
  const due = patch.due_at === undefined ? cur.due_at : patch.due_at
  const dueAt = due ? timestamp(due, 'Due date') : null
  const recurrence = normalizeRecurrenceJson(patch.recurrence === undefined ? cur.recurrence : patch.recurrence, dueAt ? localDateKey(new Date(dueAt)) : undefined)
  if (cur.recur_parent) {
    if (recurrence) throw new Error('Edit the repeat rule in Settings instead of changing this occurrence into a rule.')
    if (cur.due_at) excludeOccurrence('todos', cur.recur_parent, cur.due_at)
    db.prepare('UPDATE todos SET recur_parent = NULL WHERE id = ?').run(id)
  }
  if (cur.recurrence) {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const children = db.prepare(`SELECT id FROM todos WHERE recur_parent = ? AND completed_at IS NULL AND due_at >= ?
      AND NOT EXISTS (SELECT 1 FROM todo_completions c WHERE c.todo_id = todos.id)`).all(id, start.toISOString()) as { id: string }[]
    // Rule edits replace uncompleted generated work; finished history remains.
    for (const child of children) {
      db.prepare('DELETE FROM todo_completions WHERE todo_id = ?').run(child.id)
      db.prepare('DELETE FROM reactions WHERE todo_id = ?').run(child.id)
      db.prepare('DELETE FROM todos WHERE id = ?').run(child.id)
    }
  }
  db.prepare(
    'UPDATE todos SET title = ?, goal_id = ?, notes = ?, due_at = ?, position = ?, person_id = ?, recurrence = ? WHERE id = ?'
  ).run(
    title,
    goal,
    patch.notes === undefined ? cur.notes : patch.notes,
    dueAt,
    patch.position ?? cur.position,
    owner,
    recurrence,
    id
  )
  if (goal !== cur.goal_id) {
    const changed = getTodo(id)!
    if (changed.goal_shared === 1) {
      // Completing a private task already earned its original owner's part.
      if (cur.goal_shared !== 1 && cur.completed_at) db.prepare(`INSERT OR IGNORE INTO todo_completions
        (todo_id, person_id, completed_at) VALUES (?, ?, ?)`).run(id, cur.person_id, cur.completed_at)
      const members = (db.prepare('SELECT COUNT(*) n FROM people').get() as { n: number }).n
      const completions = (db.prepare(`SELECT COUNT(*) n FROM todo_completions c JOIN people p ON p.id = c.person_id
        WHERE c.todo_id = ?`).get(id) as { n: number }).n
      const completed = members > 0 && completions >= members ? cur.completed_at ?? new Date().toISOString() : null
      db.prepare('UPDATE todos SET completed_at = ?, archived = CASE WHEN ? IS NULL THEN 0 ELSE archived END WHERE id = ?').run(completed, completed, id)
    } else if (cur.goal_shared === 1) {
      const ownerCompletion = db.prepare('SELECT completed_at FROM todo_completions WHERE todo_id = ? AND person_id = ?').get(id, owner) as { completed_at: string } | undefined
      const legacy = ownerCompletion?.completed_at
      const completed = cur.completed_at ?? (legacy ? timestamp(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(legacy) ? `${legacy.replace(' ', 'T')}Z` : legacy) : null)
      db.prepare('DELETE FROM todo_completions WHERE todo_id = ?').run(id)
      db.prepare('UPDATE todos SET completed_at = ?, archived = CASE WHEN ? IS NULL THEN 0 ELSE archived END WHERE id = ?').run(completed, completed, id)
    }
  }
  return getTodo(id)
}

/**
 * Toggle or set completion. For a todo under a shared goal, this records the
 * completion for `selfPersonId` only; the todo is "fully done" (completed_at set)
 * once every person has completed it.
 */
export function setTodoDone(id: string, done?: boolean, selfPersonId?: string): TodoWithGoal | undefined {
  const db = getDb()
  const toggle = () => setTodoDoneInTransaction(id, done, selfPersonId)
  return db.inTransaction ? toggle() : db.transaction(toggle).immediate()
}

function setTodoDoneInTransaction(id: string, done?: boolean, selfPersonId?: string): TodoWithGoal | undefined {
  const db = getDb()
  const cur = getTodo(id)
  if (!cur) return undefined
  if (cur.recurrence) throw new Error('A repeat rule cannot be completed. Complete its dated occurrence instead.')

  if (cur.goal_shared === 1) {
    const self = selfPersonId || primaryPersonId()
    if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(self)) throw new Error('Select your profile again in Settings.')
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
      db.prepare('SELECT COUNT(*) AS n FROM todo_completions c JOIN people p ON p.id = c.person_id WHERE c.todo_id = ?').get(id) as { n: number }
    ).n
    const fullyDone = total > 0 && doneCount >= total
    db.prepare('UPDATE todos SET completed_at = ?, archived = 0 WHERE id = ?').run(
      fullyDone ? cur.completed_at ?? new Date().toISOString() : null,
      id
    )
    return getTodo(id)
  }

  const shouldComplete = done === undefined ? cur.completed_at === null : done
  db.prepare('UPDATE todos SET completed_at = ?, archived = 0 WHERE id = ?').run(
    shouldComplete ? cur.completed_at ?? new Date().toISOString() : null,
    id
  )
  return getTodo(id)
}

/**
 * Delete a todo. For a recurrence template this also stops its future instances,
 * but completed ones are kept and simply detached: wiping them would erase the
 * archive and silently roll back the progress bar on any goal they counted for.
 */
export function deleteTodo(id: string, options: { trash?: boolean } = {}): string | null {
  const db = getDb()
  const remove = () => deleteTodoInTransaction(id, options.trash !== false)
  return db.inTransaction ? remove() : db.transaction(remove).immediate()
}

function deleteTodoInTransaction(id: string, trash: boolean): string | null {
  const db = getDb()
  const todo = getTodo(id)
  if (!todo) return null
  const trashId = trash ? captureDeletedItem('task', id) : null
  if (todo.recur_parent && todo.due_at) excludeOccurrence('todos', todo.recur_parent, todo.due_at)
  db.prepare(`DELETE FROM reactions WHERE todo_id = ? OR todo_id IN
    (SELECT id FROM todos WHERE recur_parent = ? AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM todo_completions c WHERE c.todo_id = todos.id))`).run(id, id)
  // Completions belonging to the row itself and to instances about to go.
  db.prepare(
    `DELETE FROM todo_completions
     WHERE todo_id = ?
        OR todo_id IN (SELECT id FROM todos WHERE recur_parent = ? AND completed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM todo_completions c WHERE c.todo_id = todos.id))`
  ).run(id, id)
  // Keep finished instances as history, orphaned from the deleted rule.
  db.prepare(`UPDATE todos SET recur_parent = NULL WHERE recur_parent = ? AND
    (completed_at IS NOT NULL OR EXISTS (SELECT 1 FROM todo_completions c WHERE c.todo_id = todos.id))`).run(id)
  db.prepare('DELETE FROM todos WHERE recur_parent = ? AND completed_at IS NULL').run(id)
  db.prepare('DELETE FROM todos WHERE id = ?').run(id)
  return trashId
}

/** Archive todos completed before `dayISO` (kept in DB, hidden from lists).
 *  Uses 'localtime' so a todo finished just after midnight isn't archived on the
 *  same night it was completed. */
export function archiveDoneBefore(dayISO: string): number {
  const r = getDb()
    .prepare(
      `UPDATE todos SET archived = 1
       WHERE archived = 0 AND recurrence IS NULL
         AND completed_at IS NOT NULL AND completed_at < ?`
    )
    .run(parseLocalDate(dayISO).toISOString())
  return r.changes as number
}

/** Permanently delete archived todos completed more than `days` ago. */
export function purgeArchivedOlderThan(days: number): number {
  if (!Number.isFinite(days) || days < 0) throw new Error('Archive retention must be a non-negative number of days.')
  const db = getDb()
  const purge = () => purgeInTransaction(days)
  return db.inTransaction ? purge() : db.transaction(purge).immediate()
}

function purgeInTransaction(days: number): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const db = getDb()
  // Goal-linked work is the goal's history, and must continue counting forever.
  const rows = db.prepare('SELECT id, recur_parent, due_at FROM todos WHERE archived = 1 AND goal_id IS NULL AND completed_at < ?').all(cutoff) as Todo[]
  for (const row of rows) {
    if (row.recur_parent && row.due_at) excludeOccurrence('todos', row.recur_parent, row.due_at)
    db.prepare('DELETE FROM todo_completions WHERE todo_id = ?').run(row.id)
    db.prepare('DELETE FROM reactions WHERE todo_id = ?').run(row.id)
  }
  const r = db
    .prepare('DELETE FROM todos WHERE archived = 1 AND goal_id IS NULL AND completed_at IS NOT NULL AND completed_at < ?')
    .run(cutoff)
  return r.changes as number
}

/** Bulk-update positions after a drag-to-reorder. */
export function reorderTodos(updates: { id: string; position: number }[]): void {
  const db = getDb()
  if (!Array.isArray(updates) || updates.some((item) => !Number.isFinite(item.position))) throw new Error('Task positions must be finite numbers.')
  const stmt = db.prepare('UPDATE todos SET position = ? WHERE id = ?')
  const reorder = () => { for (const u of updates) stmt.run(u.position, u.id) }
  if (db.inTransaction) reorder()
  else db.transaction(reorder).immediate()
}
