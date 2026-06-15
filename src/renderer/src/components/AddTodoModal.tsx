import { useEffect, useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import type { Goal } from '../../../shared/api'
import { useProfile } from '../profile'
import { toISO, localDateInput } from '../lib/format'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
  ownerId?: string
}

export default function AddTodoModal({ open, onClose, onCreated, ownerId }: Props) {
  const { people } = useProfile()
  const [title, setTitle] = useState('')
  const [personId, setPersonId] = useState('')
  const [goalId, setGoalId] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [goals, setGoals] = useState<Goal[]>([])
  const [saving, setSaving] = useState(false)

  const owner = personId || ownerId || people[0]?.id || ''

  useEffect(() => {
    if (open) {
      const p = ownerId || people[0]?.id || ''
      setPersonId(p)
      api.goals.list({ personId: p || undefined }).then(setGoals)
      setTitle('')
      setGoalId('')
      setDate('')
      setTime('')
    }
  }, [open, ownerId, people])

  // Goals belong to a person, so refresh them when the owner changes.
  useEffect(() => {
    if (open && owner) api.goals.list({ personId: owner }).then(setGoals)
  }, [open, owner])

  async function submit() {
    if (!title.trim()) return
    setSaving(true)
    const due_at = date ? toISO(date, time || '09:00') : null
    await api.todos.create({ title, person_id: owner, goal_id: goalId || null, due_at })
    setSaving(false)
    onCreated()
    onClose()
  }

  return (
    <Modal title="Add todo" open={open} onClose={onClose}>
      <div className="space-y-4">
        <input
          autoFocus
          className="input"
          placeholder="What needs doing?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
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

        <select className="input" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
          <option value="">No goal</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
        <div className="flex gap-3">
          <input
            type="date"
            className="input"
            value={date}
            min={localDateInput()}
            onChange={(e) => setDate(e.target.value)}
          />
          <input type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving || !title.trim()}>
            Add todo
          </button>
        </div>
      </div>
    </Modal>
  )
}
