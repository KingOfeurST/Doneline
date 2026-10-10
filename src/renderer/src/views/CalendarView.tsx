import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import RangeRemovalModal from '../components/RangeRemovalModal'
import RepeatingEventsModal from '../components/RepeatingEventsModal'
import { localDateInput, fmtTime } from '../lib/format'
import { eventOverlapsDay, layoutTimedEvents, nextDay } from '../lib/calendarLayout'

type Mode = 'month' | 'week' | 'hour-grid'

const HOUR_START = 0
const HOUR_END = 24
const HOUR_HEIGHT = 64 // px per hour

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
  const [showRemoval, setShowRemoval] = useState(false)
  const [showRepeating, setShowRepeating] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const loadRequest = useRef(0)
  const gridRef = useRef<HTMLDivElement>(null)

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
  const scope = `${range.from.toISOString()}|${range.to.toISOString()}|${queryPersonId || ''}`
  const currentScope = useRef(scope)
  currentScope.current = scope
  const previousScope = useRef('')

  const load = useCallback(async () => {
    const request = ++loadRequest.current
    setLoading(true)
    setError('')
    try {
      const evs = await api.events.list({
        from: range.from.toISOString(),
        to: nextDay(range.to).toISOString(),
        personId: queryPersonId
      })
      if (request === loadRequest.current && scope === currentScope.current) setEvents(evs)
    } catch (cause) {
      if (request === loadRequest.current && scope === currentScope.current) setError(cause instanceof Error ? cause.message : 'Could not load the calendar. Please try again.')
    } finally { if (request === loadRequest.current) setLoading(false) }
  }, [range.from, range.to, queryPersonId, tick, scope])
  const latestLoad = useRef(load)
  latestLoad.current = load
  const refresh = useCallback(() => latestLoad.current(), [])

  useEffect(() => {
    if (previousScope.current !== scope) setEvents([])
    previousScope.current = scope
    void load()
    return () => { loadRequest.current++ }
  }, [load, scope])

  useEffect(() => {
    if (mode === 'hour-grid' && gridRef.current) gridRef.current.scrollTop = 8 * HOUR_HEIGHT
  }, [mode])

  const days = eachDayOfInterval({ start: range.from, end: range.to })

  function eventsOn(day: Date): CalEvent[] {
    return events.filter((event) => eventOverlapsDay(event, day))
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

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={() => { setPickDate(localDateInput(cursor)); setEditEvent(null); setShowEvent(true) }}>+ Add event</button>
        <button className="btn-soft" onClick={() => setShowRepeating(true)}>Repeating events</button>
        <button className="btn-soft" onClick={() => setShowRemoval(true)}>Remove items</button>
        {loading && <span role="status" className="ml-auto text-xs font-semibold text-slate-400">Loading…</span>}
      </div>
      {error && <div role="alert" className="flex items-center gap-3 rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-ink">{error}<button className="btn-soft" onClick={() => void load()}>Retry</button></div>}

      {mode === 'hour-grid' ? (
        /* Hour-grid week view */
        <div className="card rise overflow-hidden">
          {/* Day headers */}
          <div className="grid border-b border-slate-100" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
            <div className="py-2" />
            {days.map((day) => (
              <button
                key={day.toISOString()}
                onClick={() => openDay(day)}
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
              </button>
            ))}
          </div>

          {/* All-day events have their own row, outside the timed grid. */}
          <div className="grid border-b border-slate-100" style={{ gridTemplateColumns: '56px repeat(7, 1fr)' }}>
            <span className="p-2 text-right text-[10px] font-bold text-slate-400">All day</span>
            {days.map((day) => <div key={day.toISOString()} className="min-h-9 space-y-1 border-l border-slate-100 p-1">
              {eventsOn(day).filter((event) => event.all_day).map((event) => <button key={event.id}
                className="block w-full truncate rounded-md px-1 py-0.5 text-left text-[10px] font-bold"
                style={{ background: (event.color || '#2f7a4d') + '22', color: event.color || '#2f7a4d' }}
                onClick={() => { setEditEvent(event); setShowEvent(true) }}>{event.title}</button>)}
            </div>)}
          </div>

          {/* Time grid */}
          <div ref={gridRef} className="overflow-y-auto" style={{ maxHeight: '70vh' }}>
            <div className="relative grid" style={{ gridTemplateColumns: '56px repeat(7, 1fr)', height: gridHeight }}>
              {/* Hour labels + horizontal lines */}
              {hours.map((h) => (
                <div
                  key={h}
                  className="absolute left-0 right-0 flex items-start"
                  style={{ top: (h - HOUR_START) * HOUR_HEIGHT }}
                >
                  <span className="w-14 shrink-0 pr-2 text-right text-[10px] font-bold text-slate-300 -translate-y-2">
                    {h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am`}
                  </span>
                  <div className="flex-1 border-t border-slate-100" />
                </div>
              ))}

              {/* Day columns with events */}
              <div className="col-start-2 col-end-[-1] grid grid-cols-7 relative" style={{ height: gridHeight }}>
                {days.map((day) => {
                  const placements = layoutTimedEvents(eventsOn(day).filter((event) => !event.all_day), day, 20 / HOUR_HEIGHT * 60)
                  return (
                    <div
                      key={day.toISOString()}
                      className="relative border-l border-slate-100 cursor-pointer hover:bg-mint-card/10 transition"
                      onClick={() => openDay(day)}
                    >
                      {/* Timed events */}
                      {placements.map(({ event: e, startMinute, endMinute, column, columns }) => {
                        const top = startMinute / 60 * HOUR_HEIGHT
                        const height = Math.max(20, (endMinute - startMinute) / 60 * HOUR_HEIGHT)
                        const p = combined ? personById(e.person_id) : undefined
                        return (
                          <button
                            key={e.id}
                            title={`${e.title} · ${fmtTime(e.starts_at)} – ${fmtTime(e.ends_at)}`}
                            className="absolute flex flex-col items-start justify-start overflow-hidden rounded-lg px-1.5 py-1 text-left text-[11px] font-bold cursor-pointer shadow-sm transition hover:brightness-95"
                            style={{
                              top,
                              height: Math.min(height, gridHeight - top),
                              left: `calc(${column / columns * 100}% + 2px)`,
                              width: `calc(${100 / columns}% - 4px)`,
                              background: (e.color || '#2f7a4d') + '22',
                              color: e.color || '#2f7a4d',
                              borderLeft: `3px solid ${e.color || '#2f7a4d'}`
                            }}
                            onClick={(ev) => { ev.stopPropagation(); setEditEvent(e); setShowEvent(true) }}
                          >
                            <span>{p && <span className="mr-0.5">{p.emoji}</span>}
                            {new Date(e.starts_at) < day ? 'Continues' : fmtTime(e.starts_at)} {e.title}</span>
                          </button>
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
        onChanged={refresh}
      />

      <AddEventModal
        open={showEvent}
        onClose={() => {
          setShowEvent(false)
          setEditEvent(null)
        }}
        onCreated={refresh}
        defaultDate={pickDate}
        ownerId={defaultOwnerId}
        editEvent={editEvent}
      />
      <RangeRemovalModal open={showRemoval} onClose={() => setShowRemoval(false)} onRemoved={refresh}
        fromDay={localDateInput(mode === 'month' ? startOfMonth(cursor) : range.from)}
        toDay={localDateInput(mode === 'month' ? endOfMonth(cursor) : range.to)} />
      <RepeatingEventsModal open={showRepeating} onClose={() => setShowRepeating(false)} onChanged={refresh}
        onEdit={(event) => { setShowRepeating(false); setEditEvent(event); setShowEvent(true) }} />
    </div>
  )
}
