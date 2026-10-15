import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useProfile } from '../profile'
import DailyNote from './DailyNote'
import OlderProfileNotes from './OlderProfileNotes'

interface Props { today: string }
interface NoteHistory { scope: string; days: string[]; loading: boolean; error: string }

function adjacentDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function savedDayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Browse notes independently of Today's task and event date. */
export default function DailyNotesPanel({ today }: Props) {
  const { active, people, tick } = useProfile()
  const visiblePeople = useMemo(() => active === 'all' ? people : people.filter(person => person.id === active), [active, people])
  const personIds = useMemo(() => visiblePeople.map(person => person.id), [visiblePeople])
  const scope = JSON.stringify(personIds)
  const [day, setDay] = useState(today)
  const previousToday = useRef(today)
  const [history, setHistory] = useState<NoteHistory>({ scope: '', days: [], loading: true, error: '' })

  // Follow midnight while viewing today; retain a deliberately chosen past day.
  useEffect(() => {
    const previous = previousToday.current
    previousToday.current = today
    setDay(current => current === previous ? today : current)
  }, [today])

  useEffect(() => {
    let cancelled = false
    setHistory(previous => ({ scope, days: previous.scope === scope ? previous.days : [], loading: true, error: '' }))
    void Promise.allSettled(personIds.map(personId => api.notes.days(personId, 1000))).then(results => {
      if (cancelled) return
      const days = [...new Set(results.flatMap(result => result.status === 'fulfilled' ? result.value : []))]
        .sort((left, right) => right.localeCompare(left))
      const failed = results.filter(result => result.status === 'rejected').length
      setHistory({
        scope, days, loading: false,
        error: failed ? failed === results.length ? 'Could not load saved note dates.' : 'Some saved note dates could not be loaded.' : ''
      })
    })
    return () => { cancelled = true }
  }, [personIds, scope, tick])

  const savedDays = history.scope === scope ? history.days : []
  const loading = history.scope !== scope || history.loading
  const error = history.scope === scope ? history.error : ''
  const latestDay = savedDays[0]

  return (
    <div className="space-y-5 lg:sticky lg:top-6">
      <section aria-label="Note history" className="rounded-2xl border border-white/70 bg-white/70 px-4 py-3 shadow-clay-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-extrabold text-ink">Notes</h2>
          <button type="button" onClick={() => setDay(today)} disabled={day === today}
            aria-label="Show today's notes" className="text-xs font-bold text-mint-ink hover:underline disabled:opacity-40">Today</button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous note day" title="Previous day" disabled={day <= '0001-01-01'} onClick={() => setDay(current => adjacentDay(current, -1))}
            className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xl font-bold text-slate-500 transition hover:bg-slate-200 disabled:opacity-40">
            <span aria-hidden="true">‹</span>
          </button>
          <input type="date" aria-label="Notes date" min="0001-01-01" max="9999-12-31" value={day}
            onChange={event => { if (event.currentTarget.value && event.currentTarget.validity.valid) setDay(event.currentTarget.value) }}
            className="h-9 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-sm font-semibold text-ink" />
          <button type="button" aria-label="Next note day" title="Next day" disabled={day >= '9999-12-31'} onClick={() => setDay(current => adjacentDay(current, 1))}
            className="flex h-9 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xl font-bold text-slate-500 transition hover:bg-slate-200 disabled:opacity-40">
            <span aria-hidden="true">›</span>
          </button>
        </div>
        <select aria-label="Saved note dates" value="" disabled={loading || savedDays.length === 0}
          onChange={event => { if (event.currentTarget.value) setDay(event.currentTarget.value) }}
          className="mt-2 h-9 w-full rounded-lg border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-500 disabled:opacity-60">
          <option value="">{loading ? 'Loading saved dates…' : savedDays.length ? 'Open a saved note date…' : error ? 'Saved dates unavailable' : 'No saved notes yet'}</option>
          {savedDays.map(savedDay => <option key={savedDay} value={savedDay}>{savedDayLabel(savedDay)}</option>)}
        </select>
        {error ? <p role="status" className="mt-2 text-xs font-semibold text-rose-ink">{error}</p> : null}
        {!loading && latestDay && day === today && !savedDays.includes(today) ? (
          <p className="mt-2 text-xs font-semibold text-slate-500">Latest saved: <button type="button" onClick={() => setDay(latestDay)} className="font-bold text-mint-ink hover:underline">{savedDayLabel(latestDay)}</button></p>
        ) : null}
      </section>
      <OlderProfileNotes />
      {visiblePeople.map(person => <DailyNote key={person.id} day={day} personId={person.id} owner={person} compact={visiblePeople.length > 1} />)}
    </div>
  )
}
