import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { CalEvent, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import TodoRow from '../components/TodoRow'
import EventCard from '../components/EventCard'
import AddTodoModal from '../components/AddTodoModal'
import AddEventModal from '../components/AddEventModal'
import FocusStatsCard from '../components/FocusStatsCard'
import QuickAdd from '../components/QuickAdd'
import { fmtDayLabel } from '../lib/format'
import { playDing } from '../lib/audioFx'

export default function TodayView() {
  const { active, queryPersonId, defaultOwnerId, personById, tick } = useProfile()
  const combined = active === 'all'
  const [today, setToday] = useState('')
  const [todos, setTodos] = useState<TodoWithGoal[]>([])
  const [events, setEvents] = useState<CalEvent[]>([])
  const [showTodo, setShowTodo] = useState(false)
  const [showEvent, setShowEvent] = useState(false)
  const [editEvent, setEditEvent] = useState<CalEvent | null>(null)

  const load = useCallback(async () => {
    const day = await api.today()
    setToday(day)
    setTodos(await api.todos.today(day, queryPersonId))
    setEvents(await api.events.day(day, queryPersonId))
  }, [queryPersonId, tick])

  useEffect(() => {
    load()
  }, [load])

  async function toggle(id: string) {
    const wasDone = todos.find((t) => t.id === id)?.completed_at !== null
    await api.todos.toggle(id)
    if (!wasDone) playDing()
    load()
  }
  async function removeTodo(id: string) {
    await api.todos.remove(id)
    load()
  }
  async function removeEvent(id: string) {
    await api.events.remove(id)
    load()
  }

  const openCount = todos.filter((t) => !t.completed_at).length

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-extrabold text-ink">Today</h1>
          <p className="font-semibold text-slate-500">{today && fmtDayLabel(today)}</p>
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

      <section className="card rise p-7" style={{ animationDelay: '80ms' }}>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-2xl font-extrabold text-ink">Todo</h2>
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

        <QuickAdd onCreated={load} />

        {todos.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-3xl">🌱</p>
            <p className="mt-2 font-bold text-slate-500">A fresh start</p>
            <p className="text-sm font-semibold text-slate-400">Add your first todo below.</p>
          </div>
        ) : (
          <div>
            {todos.map((t) => (
              <TodoRow key={t.id} todo={t} onToggle={toggle} onDelete={removeTodo} showOwner={combined} />
            ))}
          </div>
        )}

        <button
          className="mt-5 w-full rounded-2xl bg-slate-100/80 py-4 text-center font-bold text-ink transition hover:bg-slate-200/80"
          onClick={() => setShowTodo(true)}
        >
          Add Todo
        </button>
      </section>

      <AddTodoModal
        open={showTodo}
        onClose={() => setShowTodo(false)}
        onCreated={load}
        ownerId={defaultOwnerId}
      />
      <AddEventModal
        open={showEvent}
        onClose={() => {
          setShowEvent(false)
          setEditEvent(null)
        }}
        onCreated={load}
        defaultDate={today}
        ownerId={defaultOwnerId}
        editEvent={editEvent}
      />
    </div>
  )
}
