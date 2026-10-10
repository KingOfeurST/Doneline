import { useEffect, useRef, useState } from 'react'
import type { CalEvent, TodoWithGoal } from '../../../shared/api'
import { api } from '../api'
import { useProfile } from '../profile'
import { fmtTime, localDateInput } from '../lib/format'
import Modal from './Modal'

interface Props {
  open: boolean
  onClose: () => void
  onRemoved: () => void
  fromDay: string
  toDay: string
}

export default function RangeRemovalModal({ open, onClose, onRemoved, fromDay, toDay }: Props) {
  const { people, queryPersonId } = useProfile()
  const [from, setFrom] = useState(fromDay)
  const [to, setTo] = useState(toDay)
  const [kind, setKind] = useState<'events' | 'todos' | 'both'>('events')
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState(queryPersonId || '')
  const [preview, setPreview] = useState<{ events: CalEvent[]; todos: TodoWithGoal[] } | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const request = useRef(0)
  const input = { kind, fromDay: from, toDay: to, title: title.trim() || undefined, personId: owner || undefined }
  const key = JSON.stringify(input)
  const currentKey = useRef(key)
  currentKey.current = key
  const matches = previewKey === key ? preview : null
  const count = matches ? matches.events.length + matches.todos.length : 0

  useEffect(() => {
    if (!open) { request.current++; return }
    setFrom(fromDay)
    setTo(toDay)
    setKind('events')
    setTitle('')
    setOwner(queryPersonId || '')
    setPreview(null)
    setPreviewKey('')
    setError('')
    setMessage('')
    setBusy(false)
    // Reset when opened, keeping filters stable during calendar refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  async function findMatches() {
    if (busy) return
    if (!from || !to || from > to) { setError('Choose a start date and an end date on or after it.'); return }
    const token = ++request.current
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api.items.previewRemoval(input)
      if (token !== request.current || key !== currentKey.current) return
      setPreview(result)
      setPreviewKey(key)
    } catch (cause) {
      if (token === request.current) setError(cause instanceof Error ? cause.message : 'Could not load matching items.')
    } finally { if (token === request.current) setBusy(false) }
  }

  async function removeMatches() {
    if (busy || !matches || !count) return
    setBusy(true)
    setError('')
    try {
      const expectedIds = [...matches.events.map((event) => `events:${event.id}`), ...matches.todos.map((todo) => `todos:${todo.id}`)]
      const result = await api.items.removeRange({ ...input, expectedIds })
      setPreview(null)
      setPreviewKey('')
      setMessage(`Removed ${result.events} event${result.events === 1 ? '' : 's'} and ${result.todos} todo${result.todos === 1 ? '' : 's'}.`)
      onRemoved()
    } catch (cause) {
      setPreview(null)
      setPreviewKey('')
      setError(cause instanceof Error ? cause.message : 'Could not remove these items. Please try again.')
    } finally { setBusy(false) }
  }

  return (
    <Modal title="Remove items" open={open} onClose={() => { if (!busy) onClose() }}>
      <div className="space-y-4">
        <p className="text-sm font-semibold text-slate-500">Find events overlapping these dates and todos due in this range. Both dates are included.</p>
        <div className="flex gap-3">
          <label className="min-w-0 flex-1 text-xs font-bold text-slate-500">From
            <input type="date" className="input mt-1" value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy} />
          </label>
          <label className="min-w-0 flex-1 text-xs font-bold text-slate-500">Through
            <input type="date" className="input mt-1" min={from} value={to} onChange={(e) => setTo(e.target.value)} disabled={busy} />
          </label>
        </div>
        <select aria-label="Item type" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} disabled={busy}>
          <option value="events">Events</option><option value="todos">Todos</option><option value="both">Events and todos</option>
        </select>
        <input aria-label="Title contains" className="input" placeholder="Title contains (optional)" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        <select aria-label="Item owner" className="input" value={owner} onChange={(e) => setOwner(e.target.value)} disabled={busy}>
          <option value="">All owners</option>
          {people.map((person) => <option key={person.id} value={person.id}>{person.emoji} {person.name}</option>)}
        </select>
        <button className="btn-soft w-full" onClick={findMatches} disabled={busy}>Preview matching items</button>
        {matches && <div className="space-y-2 rounded-2xl bg-slate-50 p-3">
          <p className="text-sm font-bold text-ink">{matches.events.length} events and {matches.todos.length} todos match.</p>
          {count > 0 && <>
            <div className="max-h-40 space-y-1 overflow-y-auto text-xs font-semibold text-slate-500">
              {matches.events.map((event) => <p key={event.id}>Event · {localDateInput(new Date(event.starts_at))} {event.all_day ? '' : fmtTime(event.starts_at)} · {event.title}</p>)}
              {matches.todos.map((todo) => <p key={todo.id}>Todo · {todo.due_at ? localDateInput(new Date(todo.due_at)) : ''} · {todo.title}</p>)}
            </div>
            <p className="text-xs font-semibold text-slate-500">Matching occurrences are deleted. Repeating schedules remain, with these dates skipped. Synced events are removed from their connected calendar too.</p>
          </>}
        </div>}
        {error && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p>}
        {message && <p role="status" className="text-sm font-semibold text-mint-ink">{message}</p>}
        <div className="flex justify-end gap-3">
          <button className="btn-soft" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn-primary bg-rose-ink" onClick={removeMatches} disabled={busy || !count}>
            {busy ? 'Working…' : `Delete ${count} item${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Modal>
  )
}
