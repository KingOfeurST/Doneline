import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { Goal, Recurrence, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import TodoRow from '../components/TodoRow'
import AddTodoModal from '../components/AddTodoModal'

interface Props {
  goal: Goal
  onBack: () => void
  /** Re-run after a change so the goals list behind this page stays in step. */
  onChanged: () => void
}

interface Bundle {
  open: TodoWithGoal[]
  done: TodoWithGoal[]
  templates: TodoWithGoal[]
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function recurrenceLabel(json: string | null): string {
  if (!json) return ''
  let rec: Recurrence | null = null
  try {
    rec = JSON.parse(json) as Recurrence
  } catch {
    return ''
  }
  if (rec.freq === 'daily') return 'Every day'
  if (rec.freq === 'weekly') return (rec.days ?? []).map((d) => DAY_NAMES[d]).join(', ')
  return rec.freq
}

/** Local day key, so a todo finished at 00:30 groups under the day it felt like. */
function dayKey(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = new Date()
  const yest = new Date()
  yest.setDate(yest.getDate() - 1)
  if (dayKey(date.toISOString()) === dayKey(today.toISOString())) return 'Today'
  if (dayKey(date.toISOString()) === dayKey(yest.toISOString())) return 'Yesterday'
  return date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
}

export default function GoalDetail({ goal, onBack, onChanged }: Props) {
  const { active, personById } = useProfile()
  const combined = active === 'all'
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(async () => {
    setBundle(await api.todos.forGoal(goal.id))
  }, [goal.id])

  useEffect(() => {
    load()
  }, [load])

  async function toggle(id: string) {
    await api.todos.toggle(id)
    load()
    onChanged()
  }
  async function remove(id: string) {
    await api.todos.remove(id)
    load()
    onChanged()
  }

  const owner = personById(goal.person_id)
  const total = goal.todo_total
  const done = goal.todo_done
  const pct = total ? Math.round((done / total) * 100) : 0
  const complete = total > 0 && done === total

  // Finished work, newest day first, so the page reads as a history.
  const doneByDay = new Map<string, TodoWithGoal[]>()
  for (const t of bundle?.done ?? []) {
    const k = t.completed_at ? dayKey(t.completed_at) : 'unknown'
    const list = doneByDay.get(k) ?? []
    list.push(t)
    doneByDay.set(k, list)
  }
  const doneDays = [...doneByDay.keys()].sort((a, b) => b.localeCompare(a))

  return (
    <div className="space-y-8">
      <button
        onClick={onBack}
        className="group flex items-center gap-1.5 text-sm font-bold text-slate-400 transition hover:text-ink"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4 transition group-hover:-translate-x-0.5" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        All goals
      </button>

      {/* Header. Not a card: the page itself carries the goal. */}
      <header className="space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="h-5 w-5 shrink-0 rounded-full" style={{ background: goal.color }} />
          <h1 className="text-3xl font-extrabold tracking-tight text-ink">{goal.title}</h1>
          {goal.shared === 1 && (
            <span className="rounded-full bg-mint-card px-2.5 py-1 text-xs font-bold text-mint-ink">
              👥 Shared
            </span>
          )}
          {combined && owner && (
            <span
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold"
              style={{ background: owner.color + '22', color: owner.color }}
            >
              {owner.emoji} {owner.name}
            </span>
          )}
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <p className="text-sm font-bold text-slate-500">
              {done} of {total} done
              {complete && <span className="ml-1.5 text-mint-ink">Finished 🎯</span>}
            </p>
            <p
              className="text-2xl font-extrabold tabular-nums"
              style={{ color: complete ? undefined : goal.color }}
            >
              {pct}%
            </p>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-white/70 shadow-clay-sm">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${pct}%`, background: goal.color }}
            />
          </div>
          <p className="mt-2 text-xs font-semibold text-slate-400">
            Counts everything ever linked here, including finished work already swept to the archive.
          </p>
        </div>
      </header>

      {!bundle ? null : (
        <>
          {/* Open work */}
          <section>
            <div className="mb-2 flex items-center justify-between border-b border-slate-200/70 pb-2">
              <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
                To do
              </h2>
              <span className="text-xs font-bold text-slate-400">{bundle.open.length}</span>
            </div>
            {bundle.open.length === 0 ? (
              <p className="py-6 text-sm font-semibold text-slate-400">
                {total === 0
                  ? 'Nothing linked to this goal yet. Add the first step below.'
                  : 'Nothing open. Every task here is finished.'}
              </p>
            ) : (
              <div>
                {bundle.open.map((t) => (
                  <TodoRow
                    key={t.id}
                    todo={t}
                    onToggle={toggle}
                    onDelete={remove}
                    showOwner={combined}
                    hideGoal
                  />
                ))}
              </div>
            )}
            <button
              className="mt-3 w-full rounded-2xl bg-white/70 py-3 text-sm font-bold text-ink shadow-clay-sm transition hover:bg-white"
              onClick={() => setShowAdd(true)}
            >
              Add todo to this goal
            </button>
          </section>

          {/* Repeat rules. Only rendered when the goal actually has one. */}
          {bundle.templates.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between border-b border-slate-200/70 pb-2">
                <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
                  Repeats
                </h2>
                <span className="text-xs font-bold text-slate-400">{bundle.templates.length}</span>
              </div>
              <div className="divide-y divide-slate-100">
                {bundle.templates.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-slate-300" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M4 10a6 6 0 0 1 10-4.5M16 10a6 6 0 0 1-10 4.5" strokeLinecap="round" />
                        <path d="M14 3v3h-3M6 17v-3h3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="truncate font-bold text-ink">{t.title}</span>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-slate-400">
                      {recurrenceLabel(t.recurrence)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs font-semibold text-slate-400">
                Edit or stop these in Settings under Recurring tasks.
              </p>
            </section>
          )}

          {/* History */}
          <section>
            <div className="mb-2 flex items-center justify-between border-b border-slate-200/70 pb-2">
              <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
                Done
              </h2>
              <span className="text-xs font-bold text-slate-400">{bundle.done.length}</span>
            </div>
            {bundle.done.length === 0 ? (
              <p className="py-6 text-sm font-semibold text-slate-400">
                Nothing finished yet. The first one will show up here.
              </p>
            ) : (
              <div className="space-y-5">
                {doneDays.map((key) => (
                  <div key={key}>
                    <p className="mb-1 text-xs font-bold text-slate-400">
                      {key === 'unknown' ? 'Earlier' : dayLabel(key)}
                    </p>
                    <div>
                      {doneByDay.get(key)!.map((t) => (
                        <TodoRow
                          key={t.id}
                          todo={t}
                          onToggle={toggle}
                          onDelete={remove}
                          showOwner={combined}
                          hideGoal
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <AddTodoModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onCreated={() => {
          load()
          onChanged()
        }}
        goalId={goal.id}
        ownerId={goal.person_id}
      />
    </div>
  )
}
