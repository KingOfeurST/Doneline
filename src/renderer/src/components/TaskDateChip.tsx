import { useEffect, useRef, useState } from 'react'
import type { TodoWithGoal } from '../../../shared/api'
import { localDateInput } from '../lib/format'
import { taskDateLabel, tomorrowDay } from '../lib/taskPlanning'

interface Props {
  todo: TodoWithGoal
  today: string
  disabled?: boolean
  onReschedule: (todo: TodoWithGoal, day: string | null) => Promise<void>
}

export default function TaskDateChip({ todo, today, disabled, onReschedule }: Props) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(todo.due_at ? localDateInput(new Date(todo.due_at)) : today)
  const container = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() }
    }
    window.addEventListener('mousedown', outside)
    container.current?.addEventListener('keydown', key)
    const current = container.current
    return () => { window.removeEventListener('mousedown', outside); current?.removeEventListener('keydown', key) }
  }, [open])
  function schedule(day: string | null) {
    setOpen(false)
    void onReschedule(todo, day)
  }
  return <div ref={container} className="relative shrink-0">
    <button ref={trigger} disabled={disabled} aria-label={`Reschedule ${todo.title}`} aria-expanded={open}
      title={todo.due_at ? new Date(todo.due_at).toLocaleString() : 'Choose a due date'}
      className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-500 transition hover:bg-mint-card hover:text-mint-ink disabled:opacity-50"
      onClick={() => { setDate(todo.due_at ? localDateInput(new Date(todo.due_at)) : today); setOpen((value) => !value) }}>
      {taskDateLabel(todo, today)}
    </button>
    {open && <div role="dialog" aria-label={`Schedule ${todo.title}`} className="absolute right-0 top-full z-30 mt-2 w-60 rounded-2xl border border-slate-100 bg-white p-3 shadow-clay">
      <div className="grid grid-cols-2 gap-1">
        <button className="btn-soft px-3 py-2 text-xs" onClick={() => schedule(today)}>Today</button>
        <button className="btn-soft px-3 py-2 text-xs" onClick={() => schedule(tomorrowDay(today))}>Tomorrow</button>
      </div>
      <label className="mt-3 block text-xs font-bold text-slate-500">Pick date
        <input aria-label={`Due date for ${todo.title}`} type="date" className="input mt-1 text-sm" value={date} onChange={(event) => setDate(event.target.value)} />
      </label>
      <div className="mt-2 flex justify-between gap-2">
        <button className="rounded-lg px-2 py-2 text-xs font-bold text-slate-400 hover:text-ink" onClick={() => schedule(null)}>No date</button>
        <button className="btn-primary px-3 py-2 text-xs" disabled={!date} onClick={() => schedule(date)}>Apply date</button>
      </div>
    </div>}
  </div>
}
