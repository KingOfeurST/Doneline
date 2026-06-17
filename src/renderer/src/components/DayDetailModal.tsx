import { useCallback, useEffect, useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import type { CalEvent, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import { fmtTime, fmtDayLabel } from '../lib/format'
import { playDing } from '../lib/audioFx'

interface Props {
  day: string | null // YYYY-MM-DD, null = closed
  onClose: () => void
  onAddEvent: (day: string) => void
  onEditEvent: (event: CalEvent) => void
  onChanged: () => void
}

export default function DayDetailModal({ day, onClose, onAddEvent, onEditEvent, onChanged }: Props) {
  const { queryPersonId, personById } = useProfile()
  const [events, setEvents] = useState<CalEvent[]>([])
  const [todos, setTodos] = useState<TodoWithGoal[]>([])

  const load = useCallback(async () => {
    if (!day) return
    setEvents(await api.events.day(day, queryPersonId))
    const all = await api.todos.list({ includeCompleted: true, personId: queryPersonId })
    setTodos(all.filter((t) => t.due_at && t.due_at.slice(0, 10) === day))
  }, [day, queryPersonId])

  useEffect(() => {
    load()
  }, [load])

  async function delEvent(id: string) {
    await api.events.remove(id)
    load()
    onChanged()
  }
  async function delTodo(id: string) {
    await api.todos.remove(id)
    load()
    onChanged()
  }
  async function toggleTodo(id: string) {
    const wasDone = todos.find((t) => t.id === id)?.completed_at !== null
    await api.todos.toggle(id)
    if (!wasDone) playDing()
    load()
    onChanged()
  }

  if (!day) return null

  return (
    <Modal title={fmtDayLabel(day)} open={day !== null} onClose={onClose}>
      <div className="space-y-5">
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
                const done = t.completed_at !== null
                return (
                  <div key={t.id} className="group flex items-center gap-3 py-1.5">
                    <button
                      onClick={() => toggleTodo(t.id)}
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
