import { useEffect, useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import { useProfile } from '../profile'
import { PALETTE } from '../lib/colors'
import { toISO, localDateInput } from '../lib/format'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
  defaultDate?: string
  ownerId?: string
}

export default function AddEventModal({ open, onClose, onCreated, defaultDate, ownerId }: Props) {
  const { people } = useProfile()
  const [title, setTitle] = useState('')
  const [personId, setPersonId] = useState('')
  const [date, setDate] = useState('')
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('10:00')
  const [allDay, setAllDay] = useState(false)
  const [location, setLocation] = useState('')
  const [attendees, setAttendees] = useState('')
  const [color, setColor] = useState(PALETTE[0].value)
  const [saving, setSaving] = useState(false)

  const owner = personId || ownerId || people[0]?.id || ''

  useEffect(() => {
    if (open) {
      setTitle('')
      setPersonId(ownerId || people[0]?.id || '')
      setDate(defaultDate || localDateInput())
      setStart('09:00')
      setEnd('10:00')
      setAllDay(false)
      setLocation('')
      setAttendees('')
      setColor(PALETTE[0].value)
    }
  }, [open, defaultDate, ownerId, people])

  async function submit() {
    if (!title.trim() || !date) return
    setSaving(true)
    const starts_at = allDay ? toISO(date, '00:00') : toISO(date, start)
    const ends_at = allDay ? toISO(date, '23:59') : toISO(date, end)
    await api.events.create({
      title,
      person_id: owner,
      starts_at,
      ends_at,
      all_day: allDay,
      location: location || null,
      attendees: attendees || null,
      color
    })
    setSaving(false)
    onCreated()
    onClose()
  }

  return (
    <Modal title="Add event" open={open} onClose={onClose}>
      <div className="space-y-4">
        <input
          autoFocus
          className="input"
          placeholder="Event title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {people.length > 1 && (
          <select className="input" value={owner} onChange={(e) => setPersonId(e.target.value)}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji} {p.name}
              </option>
            ))}
          </select>
        )}

        <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />

        <label className="flex items-center gap-2 text-sm font-bold text-slate-600">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
          All day
        </label>

        {!allDay && (
          <div className="flex gap-3">
            <input type="time" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
            <input type="time" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
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

        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving || !title.trim()}>
            Add event
          </button>
        </div>
      </div>
    </Modal>
  )
}
