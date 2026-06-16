import type { Recurrence } from '../../../shared/api'

interface Props {
  value: Recurrence | null
  onChange: (r: Recurrence | null) => void
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Mode = 'none' | 'daily' | 'weekly'

export default function RecurrencePicker({ value, onChange }: Props) {
  const mode: Mode = value ? value.freq : 'none'

  function setMode(m: Mode) {
    if (m === 'none') onChange(null)
    else if (m === 'daily') onChange({ freq: 'daily' })
    else onChange({ freq: 'weekly', days: value?.days ?? [new Date().getDay()] })
  }

  function toggleDay(d: number) {
    const days = new Set(value?.days ?? [])
    if (days.has(d)) days.delete(d)
    else days.add(d)
    onChange({ freq: 'weekly', days: [...days].sort() })
  }

  return (
    <div className="space-y-2">
      <select className="input" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
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
    </div>
  )
}
