import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CalEvent, Reaction, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import TodoRow from '../components/TodoRow'
import EventCard from '../components/EventCard'
import AddTodoModal from '../components/AddTodoModal'
import AddEventModal from '../components/AddEventModal'
import FocusStatsCard from '../components/FocusStatsCard'
import QuickAdd from '../components/QuickAdd'
import DailyNote from '../components/DailyNote'
import { fmtDayLabel } from '../lib/format'
import { useTodoCompletion } from '../lib/useTodoCompletion'
import { groupTasks, rescheduledDue, TASK_GROUPS, type TaskGroup } from '../lib/taskPlanning'
import SyncStatus from '../components/SyncStatus'
import { notifyDeleted } from '../lib/deletionUndo'

export default function TodayView() {
  const { active, people, self, queryPersonId, defaultOwnerId, personById, tick } = useProfile()
  const combined = active === 'all'
  // Whose note to show when a single profile is selected: that profile.
  const noteOwnerId = combined ? undefined : active || self
  const [today, setToday] = useState('')
  const [todos, setTodos] = useState<TodoWithGoal[]>([])
  const [events, setEvents] = useState<CalEvent[]>([])
  const [reactions, setReactions] = useState<Reaction[]>([])
  const [showTodo, setShowTodo] = useState(false)
  const [showEvent, setShowEvent] = useState(false)
  const [editEvent, setEditEvent] = useState<CalEvent | null>(null)
  const [editTodo, setEditTodo] = useState<TodoWithGoal | null>(null)
  const completion = useTodoCompletion(self, people.map((p) => p.id))
  const { guard, setError } = completion
  const [expanded, setExpanded] = useState<Record<TaskGroup, boolean>>({ today: true, overdue: true, upcoming: false, undated: false })
  const scheduled = useRef(new Map<string, string | null>())
  const [schedulingIds, setSchedulingIds] = useState<Set<string>>(new Set())
  const scope = `${queryPersonId || 'all'}`
  const currentScope = useRef(scope)
  currentScope.current = scope

  // Drag-to-reorder state
  const dragId = useRef<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const request = guard.beginLoad()
    try {
      const day = await api.today()
      const [loaded, loadedEvents] = await Promise.all([
        api.todos.planned(day, queryPersonId),
        api.events.day(day, queryPersonId)
      ])
      if (!guard.isCurrent(request)) return
      setToday(day)
      setTodos(guard.applyPending(loaded).map((todo) => scheduled.current.has(todo.id) ? { ...todo, due_at: scheduled.current.get(todo.id)! } : todo))
      setEvents(loadedEvents)
      // Clear old reactions too when the new profile has no tasks.
      const allReactions = await Promise.all(loaded.map((t) => api.reactions.list(t.id)))
      if (guard.isCurrent(request)) setReactions(allReactions.flat())
    } catch (cause) {
      if (guard.isCurrent(request)) setError(cause instanceof Error ? cause.message : 'Could not load today.')
    }
  }, [queryPersonId, tick, guard, setError])
  const latestLoad = useRef(load)
  latestLoad.current = load

  useEffect(() => {
    load()
    window.addEventListener('doneline:todos', load)
    return () => { window.removeEventListener('doneline:todos', load) }
  }, [load])

  function toggle(id: string) {
    if (scheduled.current.has(id)) return
    const todo = todos.find((t) => t.id === id)
    if (!todo) return
    return completion.toggle(todo, (updated) => {
      setTodos((prev) => prev.map((t) => t.id === updated.id ? updated : t))
    }, () => latestLoad.current())
  }

  async function react(todoId: string, emoji: string) {
    try {
      await api.reactions.toggle(todoId, emoji)
      const updated = await api.reactions.list(todoId)
      setReactions((prev) => [...prev.filter((r) => r.todo_id !== todoId), ...updated])
    } catch {
      setError('Could not save your reaction. Please try again.')
    }
  }

  async function removeTodo(id: string) {
    if (scheduled.current.has(id) || completion.pendingIds.has(id)) return
    try {
      const receipt = await api.todos.remove(id)
      notifyDeleted(receipt?.trashId, 'Task moved to Trash')
      await latestLoad.current()
    } catch {
      setError('Could not delete this todo. Please try again.')
    }
  }
  async function removeEvent(id: string) {
    try {
      const receipt = await api.events.remove(id)
      notifyDeleted(receipt?.trashId, 'Event moved to Trash')
      await latestLoad.current()
    } catch {
      setError('Could not delete this event. Please try again.')
    }
  }

  async function reschedule(todo: TodoWithGoal, day: string | null) {
    if (scheduled.current.has(todo.id) || completion.pendingIds.has(todo.id)) return
    let dueAt: string | null
    try { dueAt = rescheduledDue(todo, day) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Choose a valid date.'); return }
    if (dueAt === todo.due_at) return
    scheduled.current.set(todo.id, dueAt)
    setSchedulingIds(new Set(scheduled.current.keys()))
    guard.invalidate()
    setError('')
    setTodos((rows) => rows.map((row) => row.id === todo.id ? { ...row, due_at: dueAt } : row))
    try {
      const saved = await api.todos.update(todo.id, { due_at: dueAt })
      if (!saved) throw new Error('This task no longer exists. Refresh and try again.')
      if (scope === currentScope.current) setTodos((rows) => rows.map((row) => row.id === todo.id ? saved : row))
    } catch (cause) {
      if (scope === currentScope.current) {
        setTodos((rows) => rows.map((row) => row.id === todo.id ? { ...row, due_at: todo.due_at } : row))
        setError(cause instanceof Error ? cause.message : 'Could not reschedule this task. Please try again.')
      }
    } finally {
      scheduled.current.delete(todo.id)
      setSchedulingIds(new Set(scheduled.current.keys()))
      guard.invalidate()
      void latestLoad.current()
    }
  }

  // Drag-and-drop: compute new order and persist
  function handleDragEnd() {
    const fromId = dragId.current
    const toId = overId
    dragId.current = null
    setOverId(null)
    if (!fromId || !toId || fromId === toId) return
    if (scheduled.current.size || completion.pendingIds.size) return

    const fromIdx = todos.findIndex((t) => t.id === fromId)
    const toIdx = todos.findIndex((t) => t.id === toId)
    if (fromIdx === -1 || toIdx === -1) return

    const reordered = [...todos]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)
    setTodos(reordered)
    guard.invalidate()

    const updates = reordered.map((t, i) => ({ id: t.id, position: i }))
    api.todos.reorder(updates)
      .catch(() => setError('Could not save the new order. Please try again.'))
      .finally(() => { guard.invalidate(); void latestLoad.current() })
  }

  const reactionsFor = (todoId: string) => reactions.filter((r) => r.todo_id === todoId)
  const { groups, finished: finishedTodos, remaining: openCount } = groupTasks(todos, today, self)

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-extrabold text-ink">Today</h1>
          <p className="font-semibold text-slate-500">{today && fmtDayLabel(today)}</p>
          <SyncStatus />
        </div>
        <span
          className={`rounded-full px-3 py-1.5 text-sm font-bold ${
            openCount === 0 ? 'bg-mint-card text-mint-ink' : 'bg-white/70 text-slate-500'
          }`}
        >
          {openCount === 0 ? 'All clear ✨' : `${openCount} to do`}
        </span>
      </div>

      <FocusStatsCard />

      {events.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {events.map((e, i) => {
            const p = personById(e.person_id)
            return (
              <div key={e.id} className="rise" style={{ animationDelay: `${i * 50}ms` }}>
                <EventCard
                  event={e}
                  onDelete={removeEvent}
                  onEdit={(ev) => {
                    setEditEvent(ev)
                    setShowEvent(true)
                  }}
                  owner={combined && p ? { emoji: p.emoji, name: p.name } : undefined}
                />
              </div>
            )
          })}
        </div>
      )}

      {/* Todos and today's note sit side by side on wide screens; the note stays
          in view while the list scrolls. Stacks on narrow windows. */}
      <div className="grid items-start gap-5 lg:grid-cols-3">
      <section className="card rise p-7 lg:col-span-2" style={{ animationDelay: '80ms' }}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2.5 text-2xl font-extrabold text-ink">
            Todo
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-bold tabular-nums text-slate-500" aria-label={`${openCount} todos left`}>
              {openCount}
            </span>
          </h2>
          <button
            className="btn-soft py-2 text-sm"
            onClick={() => {
              setEditEvent(null)
              setShowEvent(true)
            }}
          >
            + Event
          </button>
        </div>

        <QuickAdd onCreated={() => latestLoad.current()} />
        {completion.error && <p role="alert" className="mt-2 text-sm font-semibold text-rose-ink">{completion.error}</p>}

        {todos.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-3xl">🌱</p>
            <p className="mt-2 font-bold text-slate-500">A fresh start</p>
            <p className="text-sm font-semibold text-slate-400">Add your first todo below.</p>
          </div>
        ) : openCount === 0 ? (
          <div className="py-8 text-center">
            <p className="text-4xl">🎉</p>
            <p className="mt-2 font-bold text-mint-ink">You’re clear for today</p>
            <p className="text-sm font-semibold text-slate-400">
              Everything on the list is done. Go enjoy it.
            </p>
          </div>
        ) : null}
          <div className="mt-3 space-y-1">
            {TASK_GROUPS.map((group) => <div key={group.id} data-task-group={group.id}>
              <button className={`flex w-full items-center gap-2 rounded-xl px-1 py-2 text-left text-sm font-extrabold ${group.id === 'overdue' && groups[group.id].length ? 'text-rose-ink' : 'text-slate-500'}`}
                aria-expanded={expanded[group.id]} onClick={() => setExpanded((value) => ({ ...value, [group.id]: !value[group.id] }))}>
                <svg viewBox="0 0 16 16" className={`h-3.5 w-3.5 transition ${expanded[group.id] ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 3 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                {group.label}<span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums">{groups[group.id].length}</span>
              </button>
              {expanded[group.id] && (groups[group.id].length ? groups[group.id].map((t) => (
              <TodoRow
                key={t.id}
                todo={t}
                onToggle={toggle}
                onDelete={removeTodo}
                onReact={react}
                reactions={reactionsFor(t.id)}
                showOwner={combined}
                dragging={overId === t.id && dragId.current !== null && dragId.current !== t.id}
                onDragStart={() => { dragId.current = t.id }}
                onDragEnter={() => setOverId(t.id)}
                onDragEnd={handleDragEnd}
                onEdit={setEditTodo}
                pending={completion.pendingIds.has(t.id) || schedulingIds.has(t.id)}
                planningDay={today}
                onReschedule={reschedule}
              />
            )) : <p className="px-6 pb-2 text-xs font-semibold text-slate-400">{group.id === 'today' ? 'Nothing due today.' : group.id === 'overdue' ? 'Nothing overdue.' : 'No tasks here.'}</p>)}
            </div>)}
          </div>

        {finishedTodos.length > 0 && (
          <details className="mt-5">
            <summary className="cursor-pointer text-xs font-bold text-slate-400">
              Finished ({finishedTodos.length})
            </summary>
            <div className="mt-2">
              {finishedTodos.map((t) => (
                <TodoRow key={t.id} todo={t} onToggle={toggle} onDelete={removeTodo}
                  onReact={react} reactions={reactionsFor(t.id)} showOwner={combined}
                  onEdit={setEditTodo} pending={completion.pendingIds.has(t.id)} />
              ))}
            </div>
          </details>
        )}

        <button
          className="mt-5 w-full rounded-2xl bg-slate-100/80 py-4 text-center font-bold text-ink transition hover:bg-slate-200/80"
          onClick={() => setShowTodo(true)}
        >
          Add Todo
        </button>
      </section>

        {today && (
          <div className="space-y-5 lg:sticky lg:top-6">
            {/* Notes follow the profile switcher. In the combined view both are
                shown, so a note written for the other person is visible here
                and on their machine after the next sync. */}
            {combined ? (
              people.map((p) => (
                <DailyNote key={p.id} day={today} personId={p.id} owner={p} compact={people.length > 1} />
              ))
            ) : (
              noteOwnerId && <DailyNote day={today} personId={noteOwnerId} />
            )}
          </div>
        )}
      </div>

      <AddTodoModal
        open={showTodo || editTodo !== null}
        onClose={() => {
          setShowTodo(false)
          setEditTodo(null)
        }}
        onCreated={() => latestLoad.current()}
        ownerId={defaultOwnerId}
        editTodo={editTodo}
      />
      <AddEventModal
        open={showEvent}
        onClose={() => {
          setShowEvent(false)
          setEditEvent(null)
        }}
        onCreated={() => latestLoad.current()}
        defaultDate={today}
        ownerId={defaultOwnerId}
        editEvent={editEvent}
      />
    </div>
  )
}
