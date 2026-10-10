import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Goal, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import Modal from '../components/Modal'
import TodoRow from '../components/TodoRow'
import AddTodoModal from '../components/AddTodoModal'
import GoalDetail from './GoalDetail'
import { PALETTE } from '../lib/colors'
import { isTodoDoneForSelf } from '../lib/todoCompletion'
import { useTodoCompletion } from '../lib/useTodoCompletion'
import { notifyDeleted } from '../lib/deletionUndo'

export default function GoalsView({ initialGoal, onInitialGoalClosed }: { initialGoal?: Goal; onInitialGoalClosed?: () => void } = {}) {
  const { active, queryPersonId, defaultOwnerId, personById, tick, self, people } = useProfile()
  const combined = active === 'all'
  const [goals, setGoals] = useState<Goal[]>([])
  const [todos, setTodos] = useState<TodoWithGoal[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [color, setColor] = useState(PALETTE[0].value)
  const [shared, setShared] = useState(false)
  const [addTodoGoal, setAddTodoGoal] = useState<{ id: string; ownerId: string } | null>(null)
  const [openGoalId, setOpenGoalId] = useState<string | null>(initialGoal?.id || null)
  useEffect(() => { if (initialGoal) setOpenGoalId(initialGoal.id) }, [initialGoal])
  const [editGoal, setEditGoal] = useState<Goal | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const completion = useTodoCompletion(self, people.map((p) => p.id))
  const { guard, setError } = completion

  const load = useCallback(async () => {
    const request = guard.beginLoad()
    try {
      const [loadedGoals, loadedTodos] = await Promise.all([
        api.goals.list({ personId: queryPersonId, includeArchived: !!initialGoal }),
        api.todos.list({ includeCompleted: true, personId: queryPersonId })
      ])
      if (!guard.isCurrent(request)) return
      setGoals(loadedGoals)
      setTodos(guard.applyPending(loadedTodos))
    } catch (cause) {
      if (guard.isCurrent(request)) setError(cause instanceof Error ? cause.message : 'Could not load goals.')
    }
  }, [queryPersonId, tick, guard, setError, initialGoal])
  const latestLoad = useRef(load)
  latestLoad.current = load

  useEffect(() => {
    load()
    window.addEventListener('doneline:todos', load)
    return () => { window.removeEventListener('doneline:todos', load) }
  }, [load])

  async function saveGoal() {
    if (!title.trim() || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      if (editGoal) {
        // `shared` is deliberately not editable: flipping it on a goal with
        // existing completions would silently change what "done" means.
        const updated = await api.goals.update(editGoal.id, { title, color })
        if (!updated) throw new Error('This goal no longer exists.')
      } else {
        await api.goals.create({ title, color, person_id: defaultOwnerId, shared })
      }
      setTitle('')
      setColor(PALETTE[0].value)
      setShared(false)
      setShowAdd(false)
      setEditGoal(null)
      await latestLoad.current()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this goal. Please try again.')
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  function startEditGoal(g: Goal) {
    setEditGoal(g)
    setTitle(g.title)
    setColor(g.color)
    setShared(g.shared === 1)
  }

  function closeGoalModal() {
    setShowAdd(false)
    setEditGoal(null)
    setTitle('')
    setColor(PALETTE[0].value)
    setShared(false)
  }

  async function removeGoal(id: string) {
    try {
      await api.goals.remove(id)
      await latestLoad.current()
      return true
    } catch {
      setError('Could not delete this goal. Please try again.')
      return false
    }
  }
  function toggle(id: string) {
    const todo = todos.find((t) => t.id === id)
    if (!todo) return
    return completion.toggle(todo, (updated) => {
      setTodos((prev) => prev.map((t) => t.id === updated.id ? updated : t))
    }, () => latestLoad.current())
  }
  async function removeTodo(id: string) {
    try {
      const receipt = await api.todos.remove(id)
      notifyDeleted(receipt?.trashId, 'Task moved to Trash')
      await latestLoad.current()
    } catch {
      setError('Could not delete this todo. Please try again.')
    }
  }

  const openGoal = goals.find((g) => g.id === openGoalId) || (initialGoal?.id === openGoalId ? initialGoal : undefined)
  function closeDetail() { setOpenGoalId(null); onInitialGoalClosed?.() }

  // Rendered in both branches: the detail page replaces the grid, so a modal
  // living only in the grid's JSX could never open from the detail page.
  const goalModal = (
    <Modal
      title={editGoal ? 'Edit goal' : 'New goal'}
      open={showAdd || editGoal !== null}
      onClose={closeGoalModal}
    >
      <div className="space-y-4">
        {completion.error && <p role="alert" className="text-sm font-semibold text-rose-ink">{completion.error}</p>}
        <input
          autoFocus
          className="input"
          placeholder="e.g. Run a marathon"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveGoal()}
        />
        <div className="flex items-center gap-2">
          {PALETTE.map((p) => (
            <button
              key={p.value}
              onClick={() => setColor(p.value)}
              aria-label={p.name}
              className={`h-8 w-8 rounded-full border-2 transition ${
                color === p.value ? 'scale-110 border-ink' : 'border-white'
              }`}
              style={{ background: p.value }}
            />
          ))}
        </div>
        {editGoal ? (
          <p className="rounded-2xl bg-slate-50/70 p-3 text-sm font-semibold text-slate-500">
            {shared
              ? 'Shared: every todo here needs both of you. This cannot be changed later.'
              : 'Personal goal. Sharing can only be set when the goal is created.'}
          </p>
        ) : (
          <label className="flex items-center gap-2 rounded-2xl bg-slate-50/70 p-3 text-sm font-bold text-slate-600">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Shared: every todo must be done by both of you
          </label>
        )}
        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-soft" onClick={closeGoalModal}>
            Cancel
          </button>
          <button className="btn-primary" onClick={saveGoal} disabled={!title.trim() || saving}>
            {saving ? 'Saving…' : editGoal ? 'Save changes' : 'Create'}
          </button>
        </div>
      </div>
    </Modal>
  )

  if (openGoal) {
    return (
      <>
        <GoalDetail
          goal={openGoal}
          onBack={closeDetail}
          onChanged={() => latestLoad.current()}
          onEdit={() => startEditGoal(openGoal)}
          onDelete={async () => {
            if (await removeGoal(openGoal.id)) closeDetail()
          }}
        />
        {goalModal}
      </>
    )
  }

  return (
    <div className="space-y-6">
      {completion.error && <p role="alert" className="text-sm font-semibold text-rose-ink">{completion.error}</p>}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-extrabold text-ink">Goals</h1>
        <button className="btn-primary py-2 text-sm" onClick={() => setShowAdd(true)}>
          + New goal
        </button>
      </div>

      {goals.length === 0 && (
        <div className="card p-10 text-center font-semibold text-slate-400">
          No goals yet. Create one and link your todos to it.
        </div>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {goals.map((g, i) => {
          // Todos still visible today (archived ones have been swept out of this list).
          const linked = todos.filter((t) => t.goal_id === g.id)
          const openTodos = linked.filter((t) => !isTodoDoneForSelf(t, self))
          // Counts come from the DB and include archived todos, so progress
          // doesn't reset when completed items get swept to the archive.
          const total = g.todo_total
          const done = g.todo_done
          const pct = total ? Math.round((done / total) * 100) : 0
          const owner = personById(g.person_id)
          return (
            <section key={g.id} className="card rise lift p-6" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex items-start justify-between">
                <button
                  onClick={() => setOpenGoalId(g.id)}
                  className="group flex min-w-0 items-center gap-3 text-left"
                  title="Open this goal"
                >
                  {combined && owner ? (
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-base"
                      style={{ background: owner.color + '22' }}
                    >
                      {owner.emoji}
                    </span>
                  ) : (
                    <span className="h-4 w-4 shrink-0 rounded-full" style={{ background: g.color }} />
                  )}
                  <h2 className="truncate text-xl font-extrabold text-ink underline-offset-4 group-hover:underline">
                    {g.title}
                  </h2>
                  {g.shared === 1 && (
                    <span className="shrink-0 rounded-full bg-mint-card px-2 py-0.5 text-xs font-bold text-mint-ink">
                      👥 Shared
                    </span>
                  )}
                </button>
              </div>

              <div className="mt-4">
                <div className="mb-1 flex justify-between text-xs font-bold text-slate-400">
                  <span>
                    {done} / {total} done
                    {total > 0 && done === total && <span className="ml-1 text-mint-ink">🎯</span>}
                  </span>
                  <span className={pct === 100 ? 'text-mint-ink' : ''}>{pct}%</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${pct}%`, background: g.color }}
                  />
                </div>
              </div>

              {/* A preview, not the whole list: the goal's own page holds the
                  full history, so the card stays scannable. */}
              <div className="mt-3">
                {openTodos.length === 0 ? (
                  <p className="py-4 text-sm font-semibold text-slate-400">
                    {total === 0
                      ? 'No todos linked yet.'
                      : done === total
                        ? `All ${total} done.`
                        : 'Nothing open right now.'}
                  </p>
                ) : (
                  openTodos
                    .slice(0, 3)
                    .map((t) => (
                      <TodoRow
                        key={t.id}
                        todo={t}
                        onToggle={toggle}
                        onDelete={removeTodo}
                        showOwner={combined}
                        hideGoal
                        pending={completion.pendingIds.has(t.id)}
                      />
                    ))
                )}
              </div>

              <div className="mt-3 flex gap-2">
                <button
                  className="flex-1 rounded-2xl bg-slate-100/80 py-2.5 text-sm font-bold text-ink transition hover:bg-slate-200/80"
                  onClick={() => setAddTodoGoal({ id: g.id, ownerId: g.person_id })}
                >
                  + Add todo
                </button>
                <button
                  className="flex-1 rounded-2xl py-2.5 text-sm font-bold text-white transition hover:brightness-110"
                  style={{ background: g.color }}
                  onClick={() => setOpenGoalId(g.id)}
                >
                  {openTodos.length > 3
                    ? `Open goal (${openTodos.length - 3} more)`
                    : 'Open goal'}
                </button>
              </div>
            </section>
          )
        })}
      </div>


      {goalModal}

      <AddTodoModal
        open={addTodoGoal !== null}
        onClose={() => setAddTodoGoal(null)}
        onCreated={() => latestLoad.current()}
        goalId={addTodoGoal?.id}
        ownerId={addTodoGoal?.ownerId}
      />
    </div>
  )
}
