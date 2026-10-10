import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Goal, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import Modal from '../components/Modal'
import TodoRow from '../components/TodoRow'
import AddTodoModal from '../components/AddTodoModal'
import GoalDetail from './GoalDetail'
import { PALETTE } from '../lib/colors'

export default function GoalsView() {
  const { active, queryPersonId, defaultOwnerId, personById, tick } = useProfile()
  const combined = active === 'all'
  const [goals, setGoals] = useState<Goal[]>([])
  const [todos, setTodos] = useState<TodoWithGoal[]>([])
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle] = useState('')
  const [color, setColor] = useState(PALETTE[0].value)
  const [shared, setShared] = useState(false)
  const [addTodoGoal, setAddTodoGoal] = useState<{ id: string; ownerId: string } | null>(null)
  const [openGoalId, setOpenGoalId] = useState<string | null>(null)
  const [editGoal, setEditGoal] = useState<Goal | null>(null)

  const load = useCallback(async () => {
    setGoals(await api.goals.list({ personId: queryPersonId }))
    setTodos(await api.todos.list({ includeCompleted: true, personId: queryPersonId }))
  }, [queryPersonId, tick])

  useEffect(() => {
    load()
  }, [load])

  async function saveGoal() {
    if (!title.trim()) return
    if (editGoal) {
      // `shared` is deliberately not editable: flipping it on a goal with
      // existing completions would silently change what "done" means.
      await api.goals.update(editGoal.id, { title, color })
    } else {
      await api.goals.create({ title, color, person_id: defaultOwnerId, shared })
    }
    setTitle('')
    setColor(PALETTE[0].value)
    setShared(false)
    setShowAdd(false)
    setEditGoal(null)
    load()
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
    await api.goals.remove(id)
    load()
  }
  async function toggle(id: string) {
    await api.todos.toggle(id)
    load()
  }
  async function removeTodo(id: string) {
    await api.todos.remove(id)
    load()
  }

  const openGoal = goals.find((g) => g.id === openGoalId)

  // Rendered in both branches: the detail page replaces the grid, so a modal
  // living only in the grid's JSX could never open from the detail page.
  const goalModal = (
    <Modal
      title={editGoal ? 'Edit goal' : 'New goal'}
      open={showAdd || editGoal !== null}
      onClose={closeGoalModal}
    >
      <div className="space-y-4">
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
          <button className="btn-primary" onClick={saveGoal} disabled={!title.trim()}>
            {editGoal ? 'Save changes' : 'Create'}
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
          onBack={() => setOpenGoalId(null)}
          onChanged={load}
          onEdit={() => startEditGoal(openGoal)}
          onDelete={async () => {
            await removeGoal(openGoal.id)
            setOpenGoalId(null)
          }}
        />
        {goalModal}
      </>
    )
  }

  return (
    <div className="space-y-6">
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
          const openTodos = linked.filter((t) => !t.completed_at)
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
        onCreated={load}
        goalId={addTodoGoal?.id}
        ownerId={addTodoGoal?.ownerId}
      />
    </div>
  )
}
