import type { Recurrence } from '../../../shared/api'
import { localDateInput } from '../lib/format'
import { localDay } from '../lib/calendarLayout'
import { parseLocalDate, previewRecurrence } from '../../../../core/recurrenceRules'

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
  try {
    if (value.startDate && value.endDate && previewRecurrence(value, value.startDate).total === 0) return 'This date range has no occurrences on the selected weekdays.'
  } catch (cause) { return cause instanceof Error ? cause.message : 'Choose a valid repeat schedule.' }
  return null
}

export function RecurrencePreviewPanel({ value, anchorDate }: { value: Recurrence; anchorDate: string }) {
  let preview: ReturnType<typeof previewRecurrence>
  try { preview = previewRecurrence(value, anchorDate) } catch { return null }
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const description = value.freq === 'daily' ? 'Every day' : value.days?.length === 1 ? `Every ${weekdays[value.days[0]]}` : `Every ${(value.days ?? []).map((day) => DAYS[day]).join(', ')}`
  const formatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
  return <div aria-label="Recurrence preview" aria-live="polite" className="space-y-2 rounded-2xl bg-slate-50 p-3">
    <p className="text-xs font-bold text-ink">{description} · {preview.total === null ? 'upcoming dates' : `${preview.total} occurrence${preview.total === 1 ? '' : 's'}`}</p>
    <div className="flex flex-wrap gap-1.5">{preview.dates.map((day) => <span key={day} title={day} className="rounded-lg border border-slate-200/70 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600">{formatter.format(parseLocalDate(day))}</span>)}</div>
    {preview.hasMore && <p className="text-[11px] font-semibold text-slate-400">{preview.total === null ? 'Continues until you stop it or choose an end date.' : `+${preview.total - preview.dates.length} more dates`}</p>}
  </div>
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
          <RecurrencePreviewPanel value={{ ...value, startDate }} anchorDate={startDate} />
        </>
      )}
    </div>
  )
}
