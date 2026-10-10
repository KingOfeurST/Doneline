import type { CalEvent, DailyNote, Goal, TodoWithGoal } from '../../../shared/api'

export type AppTab = 'today' | 'calendar' | 'goals' | 'settings'
export type SearchSelection =
  | { kind: 'todo'; item: TodoWithGoal }
  | { kind: 'event'; item: CalEvent }
  | { kind: 'goal'; item: Goal }
  | { kind: 'note'; item: DailyNote }

export function searchTab(result: SearchSelection): AppTab {
  return result.kind === 'todo' ? 'today' : result.kind === 'goal' ? 'goals' : 'calendar'
}

/** Show context around a match without filling the row with the full note. */
export function searchExcerpt(body: string, query: string, maximum = 110): string {
  const text = body.replace(/\s+/g, ' ').trim()
  const index = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase())
  const start = index > 40 ? index - 30 : 0
  const excerpt = text.slice(start, start + maximum)
  return `${start ? '…' : ''}${excerpt}${start + maximum < text.length ? '…' : ''}`
}
