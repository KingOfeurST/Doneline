import { useEffect, useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import type { Goal, Recurrence, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import { toISO, localDateInput, localTimeInput } from '../lib/format'
import RecurrencePicker from './RecurrencePicker'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: () => void
  ownerId?: string
  /** Preselect a goal (used when adding from the Goals view). */
  goalId?: string
  /** Pass a todo to edit it instead of creating a new one. */
  editTodo?: TodoWithGoal | null
}

function safeRec(json: string): Recurrence | null {
  try {
    return JSON.parse(json) as Recurrence
  } catch {
    return null
  }
}

export default function AddTodoModal({ open, onClose, onCreated, ownerId, goalId: fixedGoal, editTodo }: Props) {
  const { people } = useProfile()
  const [title, setTitle] = useState('')
  const [personId, setPersonId] = useState('')
  const [goalId, setGoalId] = useState('')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [recurrence, setRecurrence] = useState<Recurrence | null>(null)
  const [goals, setGoals] = useState<Goal[]>([])
  const [saving, setSaving] = useState(false)

  const owner = personId || ownerId || people[0]?.id || ''

  // Reset the form ONLY when the modal opens — not when the people list
  // refreshes from a background sync (that was wiping the selected goal).
  useEffect(() => {
    if (!open) return
    if (editTodo) {
      setPersonId(editTodo.person_id)
      setTitle(editTodo.title)
      setGoalId(editTodo.goal_id ?? '')
      if (editTodo.due_at) {
        const d = new Date(editTodo.due_at)
        setDate(localDateInput(d))
        setTime(localTimeInput(d))
      } else {
        setDate('')
        setTime('')
      }
      setRecurrence(editTodo.recurrence ? safeRec(editTodo.recurrence) : null)
      return
    }
    setPersonId(ownerId || people[0]?.id || '')
    setTitle('')
    setGoalId(fixedGoal ?? '')
    setDate('')
    setTime('')
    setRecurrence(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editTodo])

  // Load the owner's goals (doesn't touch the current selection).
  useEffect(() => {
    if (open && owner) api.goals.list({ personId: owner }).then(setGoals)
  }, [open, owner])

  async function submit() {
    if (!title.trim()) return
    setSaving(true)
    const due_at = date ? toISO(date, time || '09:00') : null
    const rec = recurrence ? JSON.stringify(recurrence) : null
    if (editTodo) {
      await api.todos.update(editTodo.id, {
        title,
        person_id: owner,
        goal_id: goalId || null,
        due_at,
        recurrence: rec
      })
    } else {
      await api.todos.create({
        title,
        person_id: owner,
        goal_id: goalId || null,
        due_at,
        recurrence: rec
      })
    }
    // A recurring todo is a template; generate today's instance immediately.
    if (rec) await api.maintenance()
    setSaving(false)
    onCreated()
    onClose()
  }

  return (
    <Modal title={editTodo ? 'Edit todo' : 'Add todo'} open={open} onClose={onClose}>
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

        {!fixedGoal && (
          <select className="input" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
            <option value="">No goal</option>
            {goals.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        )}

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

        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">Repeat</p>
          <RecurrencePicker value={recurrence} onChange={setRecurrence} />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-soft" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving || !title.trim()}>
            {editTodo ? 'Save changes' : 'Add todo'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
