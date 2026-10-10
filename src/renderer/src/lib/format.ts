/** Renderer-side date/time formatting helpers. */
import { localDay } from './calendarLayout'

/** SQLite's legacy datetime('now') values are UTC despite having no zone. */
export function parseCreatedAt(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? value.replace(' ', 'T') + 'Z' : value)
}

export function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function fmtDayLabel(iso: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? localDay(iso) : new Date(iso)
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

/** Build an ISO datetime from a date (YYYY-MM-DD) and time (HH:MM) in local zone. */
export function toISO(dateStr: string, timeStr: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('Choose a valid date.')
  const clock = timeStr || '00:00'
  if (!/^\d{2}:\d{2}$/.test(clock)) throw new Error('Choose a valid time.')
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = clock.split(':').map(Number)
  const calendarDate = new Date(0)
  calendarDate.setUTCHours(0, 0, 0, 0)
  calendarDate.setUTCFullYear(y, m - 1, d)
  if (calendarDate.getUTCFullYear() !== y || calendarDate.getUTCMonth() !== m - 1 || calendarDate.getUTCDate() !== d) {
    throw new Error('Choose a valid date.')
  }
  if (hh > 23 || mm > 59) throw new Error('Choose a valid time.')
  // A local ISO string also handles years below 100 without Date's 1900 offset.
  const local = new Date(`${dateStr}T${clock}:00`)
  if (!Number.isFinite(local.getTime()) || local.getFullYear() !== y || local.getMonth() !== m - 1 ||
      local.getDate() !== d || local.getHours() !== hh || local.getMinutes() !== mm) {
    throw new Error('This time does not exist in your time zone. Choose another time.')
  }
  return local.toISOString()
}

export function localDateInput(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function localTimeInput(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
