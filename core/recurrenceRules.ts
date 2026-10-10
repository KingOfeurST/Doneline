import type { Recurrence } from './types.js'

const DAY_MS = 86_400_000

/** Parse a calendar date without the UTC shift caused by new Date('YYYY-MM-DD'). */
export function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error('Use a calendar date in YYYY-MM-DD format.')
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const result = new Date(0)
  result.setFullYear(year, month - 1, day)
  result.setHours(0, 0, 0, 0)
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) {
    throw new Error(`Invalid calendar date: ${value}`)
  }
  return result
}

export function localDateKey(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date.')
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localCalendarDate(value: string | Date): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return parseLocalDate(value)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date.')
  return parseLocalDate(localDateKey(date))
}

/** Count calendar days, rather than assuming every local day lasts 24 hours. */
export function calendarDayDifference(from: Date, to: Date): number {
  function ordinal(date: Date): number {
    const utc = new Date(0)
    utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate())
    utc.setUTCHours(0, 0, 0, 0)
    return utc.getTime() / DAY_MS
  }
  return ordinal(to) - ordinal(from)
}

/** Bound explicit materialization before opening a transaction or writing rows. */
export function assertCalendarRange(from: Date, to: Date): void {
  const days = calendarDayDifference(from, to)
  if (!Number.isFinite(days) || days < 0) throw new Error('The range must end on or after it starts.')
  if (days > 3660) throw new Error('Choose a range of ten years or less.')
}

function calendarBound(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a date in YYYY-MM-DD format.`)
  parseLocalDate(value)
  return value
}

/** Validate at the write boundary; never turn a malformed rule into a daily repeat. */
export function normalizeRecurrence(value: unknown, fallbackStartDate?: string): Recurrence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid repeat rule.')
  }
  const input = value as Record<string, unknown>
  if (input.freq !== 'daily' && input.freq !== 'weekly') {
    throw new Error('Repeat must be daily or weekly.')
  }
  const result: Recurrence = { freq: input.freq }
  if (input.freq === 'weekly') {
    if (!Array.isArray(input.days) || !input.days.length) {
      throw new Error('Choose at least one weekday for a weekly repeat.')
    }
    if (input.days.some((day) => typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error('Weekdays must be numbers from 0 (Sunday) to 6 (Saturday).')
    }
    result.days = [...new Set(input.days as number[])].sort((a, b) => a - b)
  }
  const start = calendarBound(input.startDate, 'Repeat start') ?? calendarBound(fallbackStartDate, 'Repeat start')
  const end = calendarBound(input.endDate, 'Repeat end')
  if (start && end && end < start) throw new Error('Repeat end must be on or after its start date.')
  if (start) result.startDate = start
  if (end) result.endDate = end
  if (input.excludedDates !== undefined) {
    if (!Array.isArray(input.excludedDates)) throw new Error('Excluded repeat dates must be a list of dates.')
    const excluded = input.excludedDates.map((date) => {
      const day = calendarBound(date, 'Excluded date')
      if (!day) throw new Error('Excluded repeat dates must be valid dates.')
      return day
    })
    if (excluded.length) result.excludedDates = [...new Set(excluded)].sort()
  }
  return result
}

export function normalizeRecurrenceJson(json: string | null | undefined, fallbackStartDate?: string): string | null {
  if (json === undefined || json === null || json === '') return null
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new Error('Invalid repeat rule JSON.') }
  return JSON.stringify(normalizeRecurrence(value, fallbackStartDate))
}

/** Corrupt legacy rules should be skipped during maintenance, not crash startup. */
export function parseRecurrence(json: string | null, fallbackStartDate?: string): Recurrence | null {
  if (!json) return null
  try { return normalizeRecurrence(JSON.parse(json), fallbackStartDate) } catch { return null }
}

export function recurrenceMatchesDate(rule: Recurrence, day: Date): boolean {
  const key = localDateKey(day)
  if (rule.startDate && key < rule.startDate) return false
  if (rule.endDate && key > rule.endDate) return false
  if (rule.excludedDates?.includes(key)) return false
  return rule.freq === 'daily' || (rule.freq === 'weekly' && !!rule.days?.includes(day.getDay()))
}

export interface RecurrencePreview {
  /** Exact dated occurrences, limited only for display. */
  dates: string[]
  /** Null means the rule has no end date. */
  total: number | null
  hasMore: boolean
}

/** Use the same matching rules as materialization; preview never creates rows. */
export function previewRecurrence(value: Recurrence, anchorDate: string, options: { limit?: number } = {}): RecurrencePreview {
  const rule = normalizeRecurrence(value, anchorDate)
  const first = parseLocalDate(rule.startDate ?? anchorDate)
  const limit = options.limit ?? 12
  if (!Number.isInteger(limit) || limit < 1 || limit > 3661) throw new Error('Choose a preview limit between 1 and 3661.')
  const last = rule.endDate ? parseLocalDate(rule.endDate) : new Date(first)
  if (!rule.endDate) last.setDate(last.getDate() + 3660)
  assertCalendarRange(first, last)
  const dates: string[] = []
  let total = 0
  for (let day = new Date(first); day <= last; day.setDate(day.getDate() + 1)) {
    if (!recurrenceMatchesDate(rule, day)) continue
    total++
    if (dates.length < limit) dates.push(localDateKey(day))
    if (!rule.endDate && total > limit) break
  }
  return { dates, total: rule.endDate ? total : null, hasMore: rule.endDate ? total > dates.length : total > limit }
}

/** Repeat wall-clock times and calendar-day duration across DST transitions. */
export function occurrenceTimes(templateStart: Date, templateEnd: Date, day: Date): { start: Date; end: Date } {
  if (!Number.isFinite(templateStart.getTime()) || !Number.isFinite(templateEnd.getTime()) ||
      templateEnd.getTime() <= templateStart.getTime()) {
    throw new Error('An event must end after it starts.')
  }
  const start = localCalendarDate(day)
  start.setHours(templateStart.getHours(), templateStart.getMinutes(), templateStart.getSeconds(), templateStart.getMilliseconds())
  const end = localCalendarDate(day)
  end.setDate(end.getDate() + calendarDayDifference(templateStart, templateEnd))
  end.setHours(templateEnd.getHours(), templateEnd.getMinutes(), templateEnd.getSeconds(), templateEnd.getMilliseconds())
  // A nonexistent spring-forward time can normalize past the intended end.
  // Keep a positive duration when that happens, while retaining local clocks otherwise.
  if (end.getTime() <= start.getTime()) {
    return { start, end: new Date(start.getTime() + templateEnd.getTime() - templateStart.getTime()) }
  }
  return { start, end }
}
