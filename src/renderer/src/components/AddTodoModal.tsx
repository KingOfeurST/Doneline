import { useEffect, useState } from 'react'
import Modal from './Modal'
import { api } from '../api'
import type { Goal, Recurrence, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import { toISO, localDateInput, localTimeInput, parseCreatedAt } from '../lib/format'
import RecurrencePicker, { recurrenceError } from './RecurrencePicker'
import { parseRecurrence } from '../../../../core/recurrenceRules'

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
  const [error, setError] = useState('')
  const editingInstance = !!editTodo?.recur_parent

  const owner = personId || ownerId || people[0]?.id || ''

  // Reset the form ONLY when the modal opens — not when the people list
  // refreshes from a background sync (that was wiping the selected goal).
  useEffect(() => {
    if (!open) return
    setSaving(false)
    setError('')
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
      const rule = parseRecurrence(editTodo.recurrence, editTodo.due_at ? localDateInput(new Date(editTodo.due_at)) : localDateInput(parseCreatedAt(editTodo.created_at)))
      setRecurrence(rule)
      if (editTodo.recurrence && !rule) setError('The saved repeat rule is invalid. Choose a new schedule, or save without repeating to stop it.')
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
    if (!open || !owner) return
    let cancelled = false
    api.goals.list({ personId: owner }).then((rows) => {
      if (!cancelled) setGoals(rows)
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load goals.') })
    return () => { cancelled = true }
  }, [open, owner])

  async function submit() {
    if (saving) return
    if (!title.trim() || !owner) { setError('Enter a title and choose an owner.'); return }
    const validation = recurrenceError(recurrence)
    if (validation) { setError(validation); return }
    let due_at: string | null
    try { due_at = date ? toISO(date, time || '09:00') : null }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Choose a valid due date and time.')
      return
    }
    setSaving(true)
    setError('')
    const rec = recurrence ? JSON.stringify({ ...recurrence, startDate: recurrence.startDate || date || localDateInput() }) : null
    try {
      if (editTodo) {
        await api.todos.update(editTodo.id, {
        title: title.trim(),
        person_id: owner,
        goal_id: goalId || null,
        due_at,
        ...(editingInstance ? {} : { recurrence: rec })
        })
      } else {
        await api.todos.create({
        title: title.trim(),
        person_id: owner,
        goal_id: goalId || null,
        due_at,
        recurrence: rec
        })
      }
      onCreated()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this todo. Please try again.')
    } finally { setSaving(false) }
  }

  return (
    <Modal title={editTodo?.recurrence ? 'Edit repeating todo' : editTodo ? 'Edit todo' : 'Add todo'} open={open} onClose={() => { if (!saving) onClose() }}>
      <fieldset disabled={saving} className="space-y-4">
        {editingInstance && <p className="text-xs font-semibold text-slate-500">Changes apply to this occurrence. Edit the repeating todo to change its schedule.</p>}
        {error && <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-ink">{error}</p>}
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
            aria-label="Todo due date"
            className="input"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <input type="time" aria-label="Todo due time" className="input" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>

        {!editingInstance && <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-400">Repeat</p>
          <RecurrencePicker value={recurrence} onChange={setRecurrence} defaultStartDate={date || undefined} />
        </div>}

        <div className="flex justify-end gap-3 pt-2">
          <button className="btn-soft" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={saving || !title.trim()}>
            {saving ? 'Saving…' : editTodo ? 'Save changes' : 'Add todo'}
          </button>
        </div>
      </fieldset>
    </Modal>
  )
}
