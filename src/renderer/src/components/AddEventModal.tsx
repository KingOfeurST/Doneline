import { useEffect, useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import { useProfile } from '../profile'
import { PALETTE } from '../lib/colors'
import { toISO, localDateInput, localTimeInput } from '../lib/format'
import RecurrencePicker, { recurrenceError } from './RecurrencePicker'
import { localDay, nextDay } from '../lib/calendarLayout'
import type { Recurrence, CalEvent } from '../../../shared/api'
import { parseRecurrence } from '../../../../core/recurrenceRules'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
  defaultDate?: string
  ownerId?: string
  /** When set, the modal edits this event instead of creating a new one. */
  editEvent?: CalEvent | null
}

const SHARED = 'shared' // sentinel owner value for a "both" event

export default function AddEventModal({ open, onClose, onCreated, defaultDate, ownerId, editEvent }: Props) {
  const { people } = useProfile()
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('') // person id, or SHARED
  const [date, setDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('10:00')
  const [allDay, setAllDay] = useState(false)
  const [location, setLocation] = useState('')
  const [attendees, setAttendees] = useState('')
  const [color, setColor] = useState(PALETTE[0].value)
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const editing = !!editEvent
  const editingRule = !!editEvent?.recurrence
  const canEditRepeat = !editEvent?.recur_parent && !editEvent?.caldav_uid

  useEffect(() => {
    if (!open) return
    setError('')
    setSaving(false)
    if (editEvent) {
      const s = new Date(editEvent.starts_at)
      // All-day ends are exclusive; the form shows the last included day.
      const e = new Date(new Date(editEvent.ends_at).getTime() - (editEvent.all_day ? 1 : 0))
      setTitle(editEvent.title)
      setOwner(editEvent.shared === 1 ? SHARED : editEvent.person_id)
      setDate(localDateInput(s))
      setEndDate(localDateInput(e) !== localDateInput(s) ? localDateInput(e) : '')
      setStart(localTimeInput(s))
      setEnd(localTimeInput(e))
      setAllDay(editEvent.all_day === 1)
      setLocation(editEvent.location ?? '')
      setAttendees(editEvent.attendees ?? '')
      setColor(editEvent.color || PALETTE[0].value)
      const rule = parseRecurrence(editEvent.recurrence, localDateInput(s))
      setRecurrence(rule)
      if (editEvent.recurrence && !rule) setError('The saved repeat rule is invalid. Choose a new schedule, or save without repeating to stop it.')
    } else {
      setTitle('')
      setOwner(ownerId || people[0]?.id || '')
      setDate(defaultDate || localDateInput())
      setEndDate('')
      setStart('09:00')
      setEnd('10:00')
      setAllDay(false)
      setLocation('')
      setAttendees('')
      setColor(PALETTE[0].value)
      setRecurrence(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultDate, editEvent])

  async function submit() {
    if (saving) return
    const validation = recurrenceError(recurrence)
    if (!title.trim() || !date) { setError('Enter a title and an event date.'); return }
    if (endDate && endDate < date) { setError('The event end date must be on or after its start date.'); return }
    if (validation) { setError(validation); return }
    if (!allDay && (!start || !end)) { setError('Choose a start and end time.'); return }
    const last = endDate || date
    let starts_at: string
    let ends_at: string
    try {
      starts_at = toISO(date, allDay ? '00:00' : start)
      ends_at = allDay ? nextDay(localDay(last)).toISOString() : toISO(last, end)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Choose a valid event date and time.')
      return
    }
    if (new Date(ends_at) <= new Date(starts_at)) { setError('The event must end after it starts. For an overnight event, choose the next end date.'); return }
    const shared = owner === SHARED
    const person_id = shared ? editEvent?.person_id || ownerId || people[0]?.id : owner
    if (!person_id) { setError('Choose an owner.'); return }
    setSaving(true)
    setError('')
    const rec = recurrence ? JSON.stringify({ ...recurrence, startDate: recurrence.startDate || date }) : null

    try {
      if (editing && editEvent) {
        await api.events.update(editEvent.id, {
        title: title.trim(),
        person_id,
        starts_at,
        ends_at,
        all_day: allDay ? 1 : 0,
        shared: shared ? 1 : 0,
        location: location || null,
        attendees: attendees || null,
        color,
        ...(canEditRepeat ? { recurrence: rec } : {})
        })
      } else {
        await api.events.create({
        title: title.trim(),
        person_id,
        starts_at,
        ends_at,
        all_day: allDay,
        shared,
        location: location || null,
        attendees: attendees || null,
        color,
        recurrence: rec
        })
      }
      onCreated()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this event. Please try again.')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={editingRule ? 'Edit repeating event' : editing ? 'Edit event' : 'Add event'} open={open} onClose={() => { if (!saving) onClose() }}>
      <fieldset disabled={saving} className="space-y-4">
        {editEvent?.recur_parent && <p className="text-xs font-semibold text-slate-500">Changes apply to this occurrence. Use Repeating events to change the schedule.</p>}
        {editEvent?.caldav_recurrence_id && <p className="text-xs font-semibold text-slate-500">Changes apply to this occurrence. Change the repeating schedule in Apple Calendar.</p>}
        {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-ink">{error}</p>}
        <input
          autoFocus
          className="input"
          placeholder="Event title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        <select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.emoji} {p.name}
            </option>
          ))}
          {people.length > 1 && <option value={SHARED}>👥 Both (shared)</option>}
        </select>

        <div className="flex items-center gap-2">
          <div className="flex-1">
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">Event start date</p>
            <input type="date" aria-label="Event start date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="flex-1">
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">Event end date (optional)</p>
            <input
              type="date"
              aria-label="Event end date"
              className="input"
              value={endDate}
              min={date}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm font-bold text-slate-600">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          All day
        </label>

        {!allDay && (
          <div className="flex gap-3">
            <input type="time" aria-label="Event start time" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
            <input type="time" aria-label="Event end time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        )}

        <input
          className="input"
          placeholder="Location (optional)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <input
          className="input"
          placeholder="People (optional, e.g. Larry, Bernard)"
          value={attendees}
          onChange={(e) => setAttendees(e.target.value)}
        />

        <div className="flex items-center gap-2">
          {PALETTE.map((p) => (
            <button
              key={p.value}
              onClick={() => setColor(p.value)}
              aria-label={p.name}
              className={`h-8 w-8 rounded-full border-2 transition ${
                color === p.value ? 'scale-110 border-ink' : 'border-white'
              }`}
              style={{ background: p.value }}
            />
          ))}
        </div>

        {canEditRepeat && (
          <div>
            <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">Repeat</p>
            <RecurrencePicker value={recurrence} onChange={setRecurrence} defaultStartDate={date} />
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-soft" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Add event'}
          </button>
        </div>
      </fieldset>
    </Modal>
  )
}
