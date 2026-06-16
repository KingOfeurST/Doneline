import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Goal, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import Modal from '../components/Modal'
import TodoRow from '../components/TodoRow'
import AddTodoModal from '../components/AddTodoModal'
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

  const load = useCallback(async () => {
    setGoals(await api.goals.list({ personId: queryPersonId }))
    setTodos(await api.todos.list({ includeCompleted: true, personId: queryPersonId }))
  }, [queryPersonId, tick])

  useEffect(() => {
    load()
  }, [load])

  async function createGoal() {
    if (!title.trim()) return
    await api.goals.create({ title, color, person_id: defaultOwnerId, shared })
    setTitle('')
    setColor(PALETTE[0].value)
    setShared(false)
    setShowAdd(false)
    load()
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
          const linked = todos.filter((t) => t.goal_id === g.id)
          const done = linked.filter((t) => t.completed_at).length
          const pct = linked.length ? Math.round((done / linked.length) * 100) : 0
          const owner = personById(g.person_id)
          return (
            <section key={g.id} className="card rise lift p-6" style={{ animationDelay: `${i * 60}ms` }}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  {combined && owner ? (
                    <span
                      className="flex h-8 w-8 items-center justify-center rounded-full text-base"
                      style={{ background: owner.color + '22' }}
                      title={owner.name}
                    >
                      {owner.emoji}
                    </span>
                  ) : (
                    <span className="h-4 w-4 rounded-full" style={{ background: g.color }} />
                  )}
                  <h2 className="text-xl font-extrabold text-ink">{g.title}</h2>
                  {g.shared === 1 && (
                    <span className="rounded-full bg-mint-card px-2 py-0.5 text-xs font-bold text-mint-ink">
                      👥 Shared
                    </span>
                  )}
                </div>
                <button
                  onClick={() => removeGoal(g.id)}
                  className="rounded-full p-1.5 text-slate-300 transition hover:bg-rose-50 hover:text-rose-ink"
                  aria-label="Delete goal"
                >
                  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
                  </svg>
                </button>
              </div>

              <div className="mt-4">
                <div className="mb-1 flex justify-between text-xs font-bold text-slate-400">
                  <span>{done} / {linked.length} done</span>
                  <span>{pct}%</span>
                </div>
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, background: g.color }}
                  />
                </div>
              </div>

              <div className="mt-3">
                {linked.length === 0 ? (
                  <p className="py-4 text-sm font-semibold text-slate-400">No todos linked yet.</p>
                ) : (
                  linked.map((t) => (
                    <TodoRow key={t.id} todo={t} onToggle={toggle} onDelete={removeTodo} showOwner={combined} />
                  ))
                )}
              </div>

              <button
                className="mt-2 w-full rounded-2xl bg-slate-100/80 py-2.5 text-sm font-bold text-ink transition hover:bg-slate-200/80"
                onClick={() => setAddTodoGoal({ id: g.id, ownerId: g.person_id })}
              >
                + Add todo to this goal
              </button>
            </section>
          )
        })}
      </div>

      <Modal title="New goal" open={showAdd} onClose={() => setShowAdd(false)}>
        <div className="space-y-4">
          <input
            autoFocus
            className="input"
            placeholder="e.g. Run a marathon"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && createGoal()}
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
          <label className="flex items-center gap-2 rounded-2xl bg-slate-50/70 p-3 text-sm font-bold text-slate-600">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            Shared — every todo must be done by both of you
          </label>
          <div className="flex justify-end gap-3 pt-2">
            <button className="btn-soft" onClick={() => setShowAdd(false)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={createGoal} disabled={!title.trim()}>
              Create
            </button>
          </div>
        </div>
      </Modal>

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
