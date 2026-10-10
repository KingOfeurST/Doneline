import type { Recurrence } from '../../../shared/api'
import { localDateInput } from '../lib/format'
import { localDay } from '../lib/calendarLayout'

interface Props {
  value: Recurrence | null
  onChange: (r: Recurrence | null) => void
  defaultStartDate?: string
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Mode = 'none' | 'daily' | 'weekly'

export function recurrenceError(value: Recurrence | null): string | null {
  if (!value) return null
  if (value.freq === 'weekly' && !value.days?.length) return 'Choose at least one weekday.'
  if (value.startDate && value.endDate && value.endDate < value.startDate) return 'Repeat until must be on or after Repeat from.'
  return null
}

export default function RecurrencePicker({ value, onChange, defaultStartDate }: Props) {
  const mode: Mode = value ? value.freq : 'none'
  const startDate = value?.startDate || defaultStartDate || localDateInput()

  function setMode(m: Mode) {
    if (m === 'none') onChange(null)
    else if (m === 'daily') onChange({ ...value, freq: 'daily', days: undefined, startDate })
    else onChange({ ...value, freq: 'weekly', days: value?.days ?? [localDay(startDate).getDay()], startDate })
  }

  function toggleDay(d: number) {
    const days = new Set(value?.days ?? [])
    if (days.has(d)) days.delete(d)
    else days.add(d)
    onChange({ ...value, freq: 'weekly', days: [...days].sort(), startDate })
  }

  return (
    <div className="space-y-2">
      <select aria-label="Repeat schedule" className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
        <option value="none">Does not repeat</option>
        <option value="daily">Every day</option>
        <option value="weekly">Specific weekdays</option>
      </select>

      {mode === 'weekly' && (
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((label, d) => {
            const on = value?.days?.includes(d)
            return (
              <button
                key={d}
                type="button"
                aria-pressed={!!on}
                onClick={() => toggleDay(d)}
                className={`h-9 w-11 rounded-xl text-xs font-bold transition ${
                  on ? 'bg-mint-ink text-white' : 'bg-slate-100/80 text-ink hover:bg-slate-200/80'
                }`}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}
      {value && (
        <>
          <div className="flex gap-3">
            <label className="min-w-0 flex-1 text-xs font-bold text-slate-500">
              Repeat from
              <input type="date" aria-label="Repeat from" className="input mt-1" value={startDate}
                onChange={(e) => onChange({ ...value, startDate: e.target.value || undefined })} />
            </label>
            <label className="min-w-0 flex-1 text-xs font-bold text-slate-500">
              Repeat until (optional)
              <input type="date" aria-label="Repeat until" className="input mt-1" value={value.endDate || ''} min={startDate}
                onChange={(e) => onChange({ ...value, startDate, endDate: e.target.value || undefined })} />
            </label>
          </div>
          <p className="text-xs font-semibold text-slate-400">
            {value.endDate ? `Includes both dates.${mode === 'weekly' ? ' Only the selected weekdays repeat.' : ''}` : 'Repeats until you stop it or choose an end date.'}
          </p>
        </>
      )}
    </div>
  )
}
