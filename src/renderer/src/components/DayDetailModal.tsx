import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import type { CalEvent, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import { fmtTime, fmtDayLabel, localDateInput } from '../lib/format'
import { localDay } from '../lib/calendarLayout'
import { isTodoDoneForSelf } from '../lib/todoCompletion'
import { useTodoCompletion } from '../lib/useTodoCompletion'

interface Props {
  day: string | null // YYYY-MM-DD, null = closed
  onClose: () => void
  onAddEvent: (day: string) => void
  onEditEvent: (event: CalEvent) => void
  onChanged: () => void
}

export default function DayDetailModal({ day, onClose, onAddEvent, onEditEvent, onChanged }: Props) {
  const { queryPersonId, personById, self, people, tick } = useProfile()
  const [events, setEvents] = useState<CalEvent[]>([])
  const [todos, setTodos] = useState<TodoWithGoal[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [deleting, setDeleting] = useState<Set<string>>(new Set())
  const deletingRef = useRef(new Set<string>())
  const request = useRef(0)
  const scope = `${day || ''}|${queryPersonId || ''}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const previousScope = useRef('')
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged
  const completion = useTodoCompletion(self, people.map((person) => person.id))
  const { guard } = completion

  const load = useCallback(async () => {
    if (!day) return
    const token = ++request.current
    const todoToken = guard.beginLoad()
    setLoading(true)
    setLoadError('')
    try {
      const [evs, all] = await Promise.all([
        api.events.day(day, queryPersonId),
        api.todos.today(day, queryPersonId)
      ])
      if (token !== request.current || scope !== currentScope.current) return
      setEvents(evs.filter((event) => !deletingRef.current.has(event.id)))
      if (guard.isCurrent(todoToken)) setTodos(guard.applyPending(all.filter((todo) => todo.due_at && localDateInput(new Date(todo.due_at)) === day)).filter((todo) => !deletingRef.current.has(todo.id)))
    } catch (cause) {
      if (token === request.current) setLoadError(cause instanceof Error ? cause.message : 'Could not load this day. Please try again.')
    } finally { if (token === request.current) setLoading(false) }
  }, [day, queryPersonId, tick, scope, guard])
  const latestLoad = useRef(load)
  latestLoad.current = load

  useEffect(() => {
    if (previousScope.current !== scope) { setEvents([]); setTodos([]) }
    previousScope.current = scope
    completion.setError('')
    void load()
    return () => { request.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  async function delEvent(id: string) {
    if (deletingRef.current.has(id)) return
    deletingRef.current.add(id)
    setDeleting(new Set(deletingRef.current))
    const previous = events.find((event) => event.id === id)
    request.current++
    setEvents((rows) => rows.filter((event) => event.id !== id))
    try { await api.events.remove(id) }
    catch (cause) {
      if (scope === currentScope.current) {
        if (previous) setEvents((rows) => rows.some((event) => event.id === id) ? rows : [...rows, previous].sort((a, b) => a.starts_at.localeCompare(b.starts_at)))
        setLoadError(cause instanceof Error ? cause.message : 'Could not remove this event.')
      }
    } finally {
      deletingRef.current.delete(id)
      setDeleting(new Set(deletingRef.current))
      void latestLoad.current()
      changedRef.current()
    }
  }
  async function delTodo(id: string) {
    if (deletingRef.current.has(id) || completion.pendingIds.has(id)) return
    deletingRef.current.add(id)
    setDeleting(new Set(deletingRef.current))
    const previous = todos.find((todo) => todo.id === id)
    request.current++
    setTodos((rows) => rows.filter((todo) => todo.id !== id))
    try { await api.todos.remove(id) }
    catch (cause) {
      if (scope === currentScope.current) {
        if (previous) setTodos((rows) => rows.some((todo) => todo.id === id) ? rows : [...rows, previous].sort((a, b) => a.position - b.position))
        setLoadError(cause instanceof Error ? cause.message : 'Could not remove this todo.')
      }
    } finally {
      deletingRef.current.delete(id)
      setDeleting(new Set(deletingRef.current))
      void latestLoad.current()
      changedRef.current()
    }
  }
  function toggleTodo(todo: TodoWithGoal) {
    void completion.toggle(todo, (updated) => {
      if (scope === currentScope.current) setTodos((rows) => rows.map((row) => row.id === updated.id ? updated : row))
    }, () => { changedRef.current(); return latestLoad.current() })
  }

  if (!day) return null

  return (
    <Modal title={fmtDayLabel(localDay(day).toISOString())} open={day !== null} onClose={onClose}>
      <div className="space-y-5">
        {loading && <p role="status" className="text-xs font-semibold text-slate-400">Loading…</p>}
        {(loadError || completion.error) && <p role="alert" className="text-sm font-semibold text-rose-ink">{loadError || completion.error}</p>}
        <div>
          <p className="mb-2 text-xs font-extrabold uppercase tracking-widest text-slate-400">Events</p>
          {events.length === 0 ? (
            <p className="text-sm font-semibold text-slate-400">No events.</p>
          ) : (
            <div className="space-y-2">
              {events.map((e) => {
                const p = personById(e.person_id)
                return (
                  <div
                    key={e.id}
                    className="group flex cursor-pointer items-center gap-3 rounded-2xl p-3 transition hover:brightness-95"
                    style={{ background: (e.color || '#2f7a4d') + '18' }}
                    onClick={() => onEditEvent(e)}
                    title="Edit event"
                  >
                    <span className="text-sm">{e.shared === 1 ? '👥' : p?.emoji ?? ''}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-bold" style={{ color: e.color || '#2f7a4d' }}>
                        {e.title}
                      </p>
                      <p className="text-xs font-semibold text-slate-500">
                        {e.all_day ? 'All day' : `${fmtTime(e.starts_at)} – ${fmtTime(e.ends_at)}`}
                        {e.location ? ` · ${e.location.split('\n')[0]}` : ''}
                      </p>
                    </div>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation()
                        delEvent(e.id)
                      }}
                      aria-label="Delete event"
                      disabled={deleting.has(e.id)}
                      className="rounded-full p-1.5 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-ink group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-extrabold uppercase tracking-widest text-slate-400">Todos due</p>
          {todos.length === 0 ? (
            <p className="text-sm font-semibold text-slate-400">Nothing due.</p>
          ) : (
            <div className="space-y-1">
              {todos.map((t) => {
                const done = isTodoDoneForSelf(t, self)
                return (
                  <div key={t.id} className="group flex items-center gap-3 py-1.5">
                    <button
                      onClick={() => toggleTodo(t)}
                      disabled={completion.pendingIds.has(t.id) || deleting.has(t.id) || (t.goal_shared === 1 && !self)}
                      aria-label={done ? 'Mark not done' : 'Mark done'}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition ${
                        done ? 'border-mint-ink bg-mint-ink text-white' : 'border-slate-300'
                      }`}
                    >
                      {done && (
                        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3">
                          <path d="M4 10l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                    <span className={`flex-1 truncate font-bold ${done ? 'text-slate-400 line-through' : 'text-ink'}`}>
                      {personById(t.person_id)?.emoji ?? ''} {t.title}
                    </span>
                    <button
                      onClick={() => delTodo(t.id)}
                      aria-label="Delete todo"
                      disabled={completion.pendingIds.has(t.id) || deleting.has(t.id)}
                      className="rounded-full p-1.5 text-slate-400 opacity-0 transition hover:bg-rose-50 hover:text-rose-ink group-hover:opacity-100"
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <button className="btn-primary w-full" onClick={() => onAddEvent(day)}>
          + Add event
        </button>
      </div>
    </Modal>
  )
}
