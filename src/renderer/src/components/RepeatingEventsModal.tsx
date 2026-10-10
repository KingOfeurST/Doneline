import { useEffect, useRef, useState } from 'react'
import type { CalEvent } from '../../../shared/api'
import { api } from '../api'
import { useProfile } from '../profile'
import Modal from './Modal'
import { parseRecurrence } from '../../../../core/recurrenceRules'
import { localDateInput } from '../lib/format'

interface Props {
  open: boolean
  onClose: () => void
  onEdit: (event: CalEvent) => void
  onChanged: () => void
}

function describeRule(event: CalEvent): string {
  const rule = parseRecurrence(event.recurrence, localDateInput(new Date(event.starts_at)))
  if (rule) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    return `${rule.freq === 'daily' ? 'Every day' : (rule.days || []).map((day) => days[day]).join(', ')}${rule.startDate ? ` · from ${rule.startDate}` : ''}${rule.endDate ? ` through ${rule.endDate}` : ''}`
  }
  return 'Edit to repair the repeat schedule'
}

export default function RepeatingEventsModal({ open, onClose, onEdit, onChanged }: Props) {
  const { queryPersonId, tick } = useProfile()
  const [events, setEvents] = useState<CalEvent[]>([])
  const [selected, setSelected] = useState<CalEvent | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const previousScope = useRef('')
  useEffect(() => {
    if (!open) { previousScope.current = ''; return }
    let cancelled = false
    const scope = queryPersonId || 'all'
    if (scope !== previousScope.current) { setEvents([]); setSelected(null) }
    previousScope.current = scope
    setLoading(true)
    setError('')
    api.events.templates({ personId: queryPersonId }).then((rows) => {
      if (!cancelled) {
        setEvents(rows)
        setSelected((current) => current ? rows.find((event) => event.id === current.id) || null : null)
      }
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load repeating events.')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, queryPersonId, tick])

  async function removeSeries() {
    if (!selected || busy) return
    setBusy(true)
    setError('')
    try {
      await api.events.removeSeries(selected.id)
      setEvents((rows) => rows.filter((event) => event.id !== selected.id))
      setSelected(null)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove this repeating event.')
    } finally { setBusy(false) }
  }

  return <Modal title="Repeating events" open={open} onClose={() => { if (!busy) onClose() }}>
    <div className="space-y-4">
      <p className="text-sm font-semibold text-slate-500">Edit a schedule to change its weekdays or repeat dates.</p>
      {loading && events.length === 0 ? <p className="text-sm text-slate-400">Loading…</p> : events.length === 0 ? <p className="text-sm text-slate-400">No repeating events.</p> :
        <div className="space-y-2">{events.map((event) => <div key={event.id} className="flex items-center gap-2 rounded-2xl bg-slate-50 p-3">
          <button className="min-w-0 flex-1 text-left" onClick={() => onEdit(event)} disabled={busy}>
            <span className="block truncate text-sm font-bold text-ink">{event.title}</span>
            <span className="block text-xs font-semibold text-slate-500">{describeRule(event)}</span>
          </button>
          <button className="btn-soft px-3 text-xs" onClick={() => setSelected(event)} disabled={busy}>Remove</button>
        </div>)}</div>}
      {selected && <div className="space-y-2 rounded-xl bg-rose-50 p-3">
        <p className="text-sm font-semibold text-rose-ink">Remove “{selected.title}” and all its generated occurrences?</p>
        <div className="flex gap-2"><button className="btn-soft" onClick={() => setSelected(null)} disabled={busy}>Keep</button><button className="btn-primary bg-rose-ink" onClick={removeSeries} disabled={busy}>{busy ? 'Removing…' : 'Remove series'}</button></div>
      </div>}
      {error && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p>}
      <button className="btn-soft w-full" onClick={onClose} disabled={busy}>Close</button>
    </div>
  </Modal>
}
