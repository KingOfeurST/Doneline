import { useRef, useState } from 'react'
import { api } from '../api'
import type { TodoWithGoal } from '../../../shared/api'
import { playDing } from './audioFx'
import { isTodoDoneForSelf, optimisticTodoCompletion, TodoLoadGuard } from './todoCompletion'

/** Keep the visible list responsive while IPC/cloud writes finish. */
export function useTodoCompletion(self: string, peopleIds: string[]) {
  const guard = useRef(new TodoLoadGuard()).current
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')

  async function toggle(
    todo: TodoWithGoal,
    replace: (updated: TodoWithGoal) => void,
    refresh: () => void | Promise<void>,
    desiredDone?: boolean
  ) {
    if (todo.goal_shared === 1 && !self) return
    const done = desiredDone ?? !isTodoDoneForSelf(todo, self)
    const optimistic = optimisticTodoCompletion(todo, done, self, peopleIds)
    if (!guard.beginMutation(optimistic)) return
    setPendingIds((prev) => new Set(prev).add(todo.id))
    setError('')
    replace(optimistic)
    if (done) playDing()

    try {
      // Explicit desired state makes repeated invocations idempotent on the server.
      const updated = await api.todos.toggle(todo.id, done)
      if (!updated) throw new Error('This todo no longer exists. Refresh and try again.')
      guard.finishMutation(todo.id)
      replace(updated)
    } catch (cause) {
      guard.finishMutation(todo.id)
      replace(todo)
      setError(cause instanceof Error ? cause.message : 'Could not update this todo. Please try again.')
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev)
        next.delete(todo.id)
        return next
      })
      // A fresh authoritative read runs after completion; old reads were invalidated.
      void refresh()
    }
  }

  return { guard, pendingIds, error, setError, toggle }
}
