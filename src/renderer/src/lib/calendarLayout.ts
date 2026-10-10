/** Local calendar dates and half-open event intervals, shared by calendar views. */
export function localDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date)
}

export function nextDay(day: Date): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
}

export interface TimedEvent {
  id: string
  starts_at: string
  ends_at: string
}

export function eventOverlapsDay(event: TimedEvent, day: Date): boolean {
  return new Date(event.starts_at).getTime() < nextDay(day).getTime()
    && new Date(event.ends_at).getTime() > day.getTime()
}

export interface EventPlacement<T extends TimedEvent> {
  event: T
  startMinute: number
  endMinute: number
  column: number
  columns: number
}

/** Clip overnight events to the visible local day and split overlapping groups. */
export function layoutTimedEvents<T extends TimedEvent>(events: T[], day: Date, minimumMinutes = 0): EventPlacement<T>[] {
  const dayStart = day.getTime()
  const dayEnd = nextDay(day).getTime()
  const minute = (time: number) => {
    if (time === dayEnd) return 24 * 60
    const date = new Date(time)
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60
  }
  const placements = events
    .filter((event) => eventOverlapsDay(event, day))
    .map((event) => {
      const start = Math.max(dayStart, new Date(event.starts_at).getTime())
      const end = Math.min(dayEnd, new Date(event.ends_at).getTime())
      const startMinute = minute(start)
      const endMinute = minute(end)
      return {
        event,
        startMinute,
        // During the repeated DST hour, elapsed time can move backwards on the clock.
        endMinute: endMinute > startMinute ? endMinute : Math.min(1440, startMinute + (end - start) / 60_000),
        column: 0,
        columns: 1
      }
    })
    .sort((a, b) => a.startMinute - b.startMinute || b.endMinute - a.endMinute || a.event.id.localeCompare(b.event.id))

  let group: EventPlacement<T>[] = []
  let columnEnds: number[] = []
  let groupEnd = -1
  function finishGroup() {
    for (const placement of group) placement.columns = columnEnds.length
    group = []
    columnEnds = []
  }
  for (const placement of placements) {
    if (placement.startMinute >= groupEnd) finishGroup()
    let column = columnEnds.findIndex((end) => end <= placement.startMinute)
    if (column < 0) column = columnEnds.length
    placement.column = column
    // Short adjacent events must not cover each other's minimum clickable height.
    const visualEnd = Math.min(1440, Math.max(placement.endMinute, placement.startMinute + minimumMinutes))
    columnEnds[column] = visualEnd
    group.push(placement)
    groupEnd = Math.max(groupEnd, visualEnd)
  }
  finishGroup()
  return placements
}
