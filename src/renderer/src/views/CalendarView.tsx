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

type Mode = 'month' | 'week' | 'hour-grid'

const HOUR_START = 6  // 6am
const HOUR_END = 23   // 11pm
const HOUR_HEIGHT = 64 // px per hour

function eventTop(starts_at: string): number {
  const d = new Date(starts_at)
  return (d.getHours() + d.getMinutes() / 60 - HOUR_START) * HOUR_HEIGHT
}

function eventHeight(starts_at: string, ends_at: string): number {
  const mins = (new Date(ends_at).getTime() - new Date(starts_at).getTime()) / 60_000
  return Math.max(HOUR_HEIGHT / 2, (mins / 60) * HOUR_HEIGHT)
}

export default function CalendarView() {
  const { active, queryPersonId, defaultOwnerId, personById, tick } = useProfile()
  const combined = active === 'all'
  const [cursor, setCursor] = useState(new Date())
  const [mode, setMode] = useState<Mode>('month')
  const [events, setEvents] = useState<CalEvent[]>([])
  const [showEvent, setShowEvent] = useState(false)
  const [pickDate, setPickDate] = useState<string | undefined>()
  const [editEvent, setEditEvent] = useState<CalEvent | null>(null)
  const [detailDay, setDetailDay] = useState<string | null>(null)

  const range = useMemo(() => {
    if (mode === 'week' || mode === 'hour-grid') {
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
    setCursor((c) => (mode === 'month' ? addMonths(c, dir) : addWeeks(c, dir)))
  }

  function openDay(day: Date) {
    setDetailDay(localDateInput(day))
  }

  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
  const gridHeight = (HOUR_END - HOUR_START) * HOUR_HEIGHT

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-extrabold text-ink">
          {format(cursor, 'MMMM')} <span className="font-bold text-slate-400">{format(cursor, 'yyyy')}</span>
        </h1>
        <div className="flex items-center gap-2">
          <button className="btn-soft px-3 py-2" onClick={() => step(-1)} aria-label="Previous">‹</button>
          <button className="btn-soft px-3 py-2" onClick={() => setCursor(new Date())}>Today</button>
          <button className="btn-soft px-3 py-2" onClick={() => step(1)} aria-label="Next">›</button>
          <div className="ml-2 flex rounded-full bg-white/70 p-1 shadow-clay-sm">
            {(['week', 'month', 'hour-grid'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1.5 text-sm font-bold capitalize transition ${
                  mode === m ? 'bg-mint-ink text-white' : 'text-slate-500'
                }`}
              >
                {m === 'hour-grid' ? 'Grid' : m}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === 'hour-grid' ? (
        /* Hour-grid week view */
        <div className="card rise overflow-hidden">
          {/* Day headers */}
          <div className="grid border-b border-slate-100" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
            <div className="py-2" />
            {days.map((day) => (
              <div
                key={day.toISOString()}
                className={`py-2 text-center text-xs font-bold ${isSameDay(day, new Date()) ? 'text-mint-ink' : 'text-slate-500'}`}
              >
                <div className="uppercase tracking-wide text-[10px]">{format(day, 'EEE')}</div>
                <div
                  className={`mx-auto mt-1 flex h-6 w-6 items-center justify-center rounded-full text-sm ${
                    isSameDay(day, new Date()) ? 'bg-mint-ink text-white' : ''
                  }`}
                >
                  {format(day, 'd')}
                </div>
              </div>
            ))}
          </div>

          {/* Time grid */}
          <div className="overflow-y-auto" style={{ maxHeight: '70vh' }}>
            <div className="relative grid" style={{ gridTemplateColumns: '56px repeat(7, 1fr)', height: gridHeight }}>
              {/* Hour labels + horizontal lines */}
              {hours.map((h) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 flex items-start"
                  style={{ top: (h - HOUR_START) * HOUR_HEIGHT }}
                >
                  <span className="w-14 shrink-0 pr-2 text-right text-[10px] font-bold text-slate-300 -translate-y-2">
                    {h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`}
                  </span>
                  <div className="flex-1 border-t border-slate-100" />
                </div>
              ))}

              {/* Day columns with events */}
              <div className="col-start-2 col-end-[-1] grid grid-cols-7 relative" style={{ height: gridHeight }}>
                {days.map((day) => {
                  const dayEvs = eventsOn(day).filter((e) => !e.all_day)
                  const allDayEvs = eventsOn(day).filter((e) => e.all_day)
                  return (
                    <div
                      key={day.toISOString()}
                      className="relative border-l border-slate-100 cursor-pointer hover:bg-mint-card/10 transition"
                      onClick={() => openDay(day)}
                    >
                      {/* All-day pill at the top */}
                      {allDayEvs.map((e) => (
                        <div
                          key={e.id}
                          className="mx-1 mb-0.5 truncate rounded-md px-1 py-0.5 text-[10px] font-bold"
                          style={{ background: (e.color || '#2f7a4d') + '22', color: e.color || '#2f7a4d' }}
                          onClick={(ev) => { ev.stopPropagation(); setEditEvent(e); setShowEvent(true) }}
                        >
                          {e.title}
                        </div>
                      ))}

                      {/* Timed events */}
                      {dayEvs.map((e) => {
                        const top = eventTop(e.starts_at)
                        const height = eventHeight(e.starts_at, e.ends_at)
                        if (top < 0 || top > gridHeight) return null
                        const p = combined ? personById(e.person_id) : undefined
                        return (
                          <div
                            key={e.id}
                            className="absolute mx-1 overflow-hidden rounded-lg px-1.5 py-1 text-[11px] font-bold cursor-pointer shadow-sm transition hover:brightness-95"
                            style={{
                              top,
                              height: Math.min(height, gridHeight - top),
                              left: 0,
                              right: 0,
                              background: (e.color || '#2f7a4d') + '22',
                              color: e.color || '#2f7a4d',
                              borderLeft: `3px solid ${e.color || '#2f7a4d'}`
                            }}
                            onClick={(ev) => { ev.stopPropagation(); setEditEvent(e); setShowEvent(true) }}
                          >
                            {p && <span className="mr-0.5">{p.emoji}</span>}
                            {format(new Date(e.starts_at), 'h:mm')} {e.title}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Month / week chip view */
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
                  className={`group flex flex-col gap-1 overflow-hidden rounded-xl border border-transparent p-1.5 text-left transition hover:border-mint-ink/20 hover:bg-mint-card/40 ${
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
      )}

      <DayDetailModal
        day={detailDay}
        onClose={() => setDetailDay(null)}
        onAddEvent={(d) => {
          setPickDate(d)
          setEditEvent(null)
          setDetailDay(null)
          setShowEvent(true)
        }}
        onEditEvent={(e) => {
          setEditEvent(e)
          setDetailDay(null)
          setShowEvent(true)
        }}
        onChanged={load}
      />

      <AddEventModal
        open={showEvent}
        onClose={() => {
          setShowEvent(false)
          setEditEvent(null)
        }}
        onCreated={load}
        defaultDate={pickDate}
        ownerId={defaultOwnerId}
        editEvent={editEvent}
      />
    </div>
  )
}
