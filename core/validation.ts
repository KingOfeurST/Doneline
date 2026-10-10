/** Keep every writer (UI, MCP and calendar sync) on the same date convention. */
export function timestamp(value: string, label = 'Date'): string {
  if (typeof value !== 'string') throw new Error(`${label} is not valid.`)
  const text = value.trim()
  const fields = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(text)
  if (!fields) throw new Error(`${label} is not valid. Use a calendar date or ISO date/time.`)
  const [, year, month, dateNumber, hour, minute, second, , zone] = fields
  const calendar = new Date(0)
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(dateNumber))
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(dateNumber) ||
      Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59) {
    throw new Error(`${label} is not a valid calendar date/time.`)
  }
  let date: Date
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (day) {
    date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    if (date.getFullYear() !== Number(day[1]) || date.getMonth() !== Number(day[2]) - 1 || date.getDate() !== Number(day[3])) {
      throw new Error(`${label} is not a valid calendar date.`)
    }
  } else {
    date = new Date(text.replace(' ', 'T'))
    if (!zone && Number.isFinite(date.getTime()) && (date.getHours() !== Number(hour) || date.getMinutes() !== Number(minute))) {
      throw new Error(`${label} does not exist in your time zone. Choose another time.`)
    }
  }
  if (!text || !Number.isFinite(date.getTime())) throw new Error(`${label} is not valid.`)
  return date.toISOString()
}

export function itemTitle(value: string): string {
  if (typeof value !== 'string') throw new Error('Please enter a title.')
  const title = value.trim()
  if (!title) throw new Error('Please enter a title.')
  return title
}

export function eventTimes(startValue: string, endValue: string, allDay: boolean): { start: string; end: string } {
  const start = new Date(timestamp(startValue, 'Start'))
  const end = new Date(timestamp(endValue, 'End'))
  if (allDay) {
    start.setHours(0, 0, 0, 0)
    // Legacy/UI inclusive ends become an exclusive next-midnight boundary.
    // An already exclusive midnight (from iCalendar) stays unchanged.
    if (end.getHours() || end.getMinutes() || end.getSeconds() || end.getMilliseconds() || end.getTime() === start.getTime()) {
      end.setDate(end.getDate() + 1)
      end.setHours(0, 0, 0, 0)
    }
  }
  if (end <= start) throw new Error('The event must end after it starts.')
  return { start: start.toISOString(), end: end.toISOString() }
}
