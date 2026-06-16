import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek
} from 'date-fns'
import { api } from '../api'
import type { CalEvent } from '../../../shared/api'
import { useProfile } from '../profile'
import AddEventModal from '../components/AddEventModal'
import DayDetailModal from '../components/DayDetailModal'
import { localDateInput, fmtTime } from '../lib/format'

type Mode = 'month' | 'week'

export default function CalendarView() {
  const { active, queryPersonId, defaultOwnerId, personById, tick } = useProfile()
  const combined = active === 'all'
  const [cursor, setCursor] = useState(new Date())
  const [mode, setMode] = useState<Mode>('month')
  const [events, setEvents] = useState<CalEvent[]>([])
  const [showEvent, setShowEvent] = useState(false)
  const [pickDate, setPickDate] = useState<string | undefined>()
  const [detailDay, setDetailDay] = useState<string | null>(null)

  const range = useMemo(() => {
    if (mode === 'week') {
      const from = startOfWeek(cursor, { weekStartsOn: 0 })
      const to = endOfWeek(cursor, { weekStartsOn: 0 })
      return { from, to }
    }
    const from = startOfWeek(startOfMonth(cursor), { weekStartsOn: 0 })
    const to = endOfWeek(endOfMonth(cursor), { weekStartsOn: 0 })
    return { from, to }
  }, [cursor, mode])

  const load = useCallback(async () => {
    const evs = await api.events.list({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      personId: queryPersonId
    })
    setEvents(evs)
  }, [range.from, range.to, queryPersonId, tick])

  useEffect(() => {
    load()
  }, [load])

  const days = eachDayOfInterval({ start: range.from, end: range.to })

  function eventsOn(day: Date): CalEvent[] {
    return events.filter((e) => {
      const s = new Date(e.starts_at)
      const en = new Date(e.ends_at)
      return isSameDay(s, day) || (s <= day && en >= day)
    })
  }

  function step(dir: number) {
    setCursor((c) => (mode === 'week' ? addWeeks(c, dir) : addMonths(c, dir)))
  }

  function openDay(day: Date) {
    setDetailDay(localDateInput(day))
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-extrabold text-ink">
          {format(cursor, 'MMMM')} <span className="font-bold text-slate-400">{format(cursor, 'yyyy')}</span>
        </h1>
        <div className="flex items-center gap-2">
          <button className="btn-soft px-3 py-2" onClick={() => step(-1)} aria-label="Previous">
            ‹
          </button>
          <button className="btn-soft px-3 py-2" onClick={() => setCursor(new Date())}>
            Today
          </button>
          <button className="btn-soft px-3 py-2" onClick={() => step(1)} aria-label="Next">
            ›
          </button>
          <div className="ml-2 flex rounded-full bg-white/70 p-1 shadow-clay-sm">
            {(['week', 'month'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1.5 text-sm font-bold capitalize transition ${
                  mode === m ? 'bg-mint-ink text-white' : 'text-slate-500'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card rise overflow-hidden p-3">
        <div className="grid grid-cols-7 border-b border-slate-100 pb-2 text-center text-xs font-bold uppercase tracking-wide text-slate-400">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className={`grid grid-cols-7 ${mode === 'week' ? 'auto-rows-[220px]' : 'auto-rows-[110px]'}`}>
          {days.map((day) => {
            const dayEvents = eventsOn(day)
            const inMonth = mode === 'week' || isSameMonth(day, cursor)
            const today = isSameDay(day, new Date())
            return (
              <button
                key={day.toISOString()}
                onClick={() => openDay(day)}
                className={`group flex flex-col gap-1 rounded-xl border border-transparent p-1.5 text-left transition hover:border-mint-ink/20 hover:bg-mint-card/40 ${
                  inMonth ? '' : 'opacity-40'
                } ${today ? 'bg-rose-card/40' : ''}`}
              >
                <span
                  className={`mb-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold transition ${
                    today ? 'bg-rose-ink text-white shadow-clay-sm' : 'text-slate-500 group-hover:text-ink'
                  }`}
                >
                  {format(day, 'd')}
                </span>
                <div className="flex flex-col gap-1 overflow-hidden">
                  {dayEvents.slice(0, mode === 'week' ? 6 : 3).map((e) => (
                    <span
                      key={e.id}
                      className="truncate rounded-md px-1.5 py-0.5 text-[11px] font-bold"
                      style={{ background: (e.color || '#2f7a4d') + '22', color: e.color || '#2f7a4d' }}
                    >
                      {combined && <span className="mr-1">{personById(e.person_id)?.emoji ?? ''}</span>}
                      {!e.all_day && <span className="mr-1 opacity-70">{fmtTime(e.starts_at)}</span>}
                      {e.title}
                    </span>
                  ))}
                  {dayEvents.length > (mode === 'week' ? 6 : 3) && (
                    <span className="px-1 text-[10px] font-bold text-slate-400">
                      +{dayEvents.length - (mode === 'week' ? 6 : 3)} more
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <DayDetailModal
        day={detailDay}
        onClose={() => setDetailDay(null)}
        onAddEvent={(d) => {
          setPickDate(d)
          setDetailDay(null)
          setShowEvent(true)
        }}
        onChanged={load}
      />

      <AddEventModal
        open={showEvent}
        onClose={() => setShowEvent(false)}
        onCreated={load}
        defaultDate={pickDate}
        ownerId={defaultOwnerId}
      />
    </div>
  )
}
