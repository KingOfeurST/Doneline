import type { TodoWithGoal } from '../../../shared/api'

/** Shared tasks are done for this device as soon as its own person finishes. */
export function isTodoDoneForSelf(todo: TodoWithGoal, self: string): boolean {
  if (todo.goal_shared !== 1) return todo.completed_at !== null
  return !!self && (todo.done_by ?? '').split(',').includes(self)
}

export function optimisticTodoCompletion(
  todo: TodoWithGoal,
  done: boolean,
  self: string,
  peopleIds: string[],
  completedAt = new Date().toISOString()
): TodoWithGoal {
  if (todo.goal_shared !== 1) return { ...todo, completed_at: done ? completedAt : null }
  const doneBy = new Set((todo.done_by ?? '').split(',').filter(Boolean))
  if (done) doneBy.add(self)
  else doneBy.delete(self)
  const fullyDone = peopleIds.length > 0 && peopleIds.every((id) => doneBy.has(id))
  return { ...todo, done_by: [...doneBy].join(',') || null, completed_at: fullyDone ? completedAt : null }
}

/** A late read must never undo a newer click or a newer profile's response. */
export class TodoLoadGuard {
  private request = 0
  private revision = 0
  private pending = new Map<string, TodoWithGoal>()

  beginLoad(): { request: number; revision: number } {
    return { request: ++this.request, revision: this.revision }
  }

  isCurrent(token: { request: number; revision: number }): boolean {
    return token.request === this.request && token.revision === this.revision
  }

  beginMutation(todo: TodoWithGoal): boolean {
    if (this.pending.has(todo.id)) return false
    this.revision++
    this.pending.set(todo.id, todo)
    return true
  }

  finishMutation(id: string): void {
    this.revision++
    this.pending.delete(id)
  }

  invalidate(): void {
    this.revision++
  }

  applyPending(rows: TodoWithGoal[]): TodoWithGoal[] {
    return rows.map((row) => {
      const optimistic = this.pending.get(row.id)
      return optimistic
        ? { ...row, completed_at: optimistic.completed_at, done_by: optimistic.done_by }
        : row
    })
  }
}
