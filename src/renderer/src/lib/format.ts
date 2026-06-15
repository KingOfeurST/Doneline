/** Renderer-side date/time formatting helpers. */

export function fmtTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function fmtDayLabel(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

/** Build an ISO datetime from a date (YYYY-MM-DD) and time (HH:MM) in local zone. */
export function toISO(dateStr: string, timeStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm, 0).toISOString()
}

export function localDateInput(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function localTimeInput(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}
