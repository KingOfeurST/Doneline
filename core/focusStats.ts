import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { getDailyTarget } from './prefs.js'
import type { FocusSession, FocusStats } from './types.js'

const MIN_SESSION_SECONDS = 60

/** Record a completed focus block. Ignores blocks shorter than a minute. */
export function recordFocusSession(input: {
  personId: string
  taskId?: string | null
  durationSeconds: number
  startedAt: string
  endedAt: string
}): void {
  if (input.durationSeconds < MIN_SESSION_SECONDS) return
  getDb()
    .prepare(
      `INSERT INTO focus_sessions (id, person_id, task_id, duration_seconds, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(uuid(), input.personId, input.taskId ?? null, Math.round(input.durationSeconds), input.startedAt, input.endedAt)
}

function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Compute today/week totals + streak for a person, grouped by local day. */
export function focusStats(personId: string): FocusStats {
  const target = getDailyTarget()
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const rows = getDb()
    .prepare('SELECT * FROM focus_sessions WHERE person_id = ? AND ended_at >= ? ORDER BY ended_at')
    .all(personId, since) as FocusSession[]

  // Bucket sessions + minutes by local day.
  const byDay = new Map<string, { sessions: number; seconds: number }>()
  for (const r of rows) {
    const key = localDayKey(new Date(r.ended_at))
    const b = byDay.get(key) ?? { sessions: 0, seconds: 0 }
    b.sessions += 1
    b.seconds += r.duration_seconds
    byDay.set(key, b)
  }

  const now = new Date()
  const todayKey = localDayKey(now)
  const today = byDay.get(todayKey) ?? { sessions: 0, seconds: 0 }

  let weekSeconds = 0
  for (let i = 0; i < 7; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    weekSeconds += byDay.get(localDayKey(d))?.seconds ?? 0
  }

  const targetMet = today.sessions >= target

  // Streak: consecutive days meeting target, counting back from today. Today not
  // yet met doesn't break the streak (it's still in progress).
  let streak = 0
  for (let i = 0; i < 90; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const met = (byDay.get(localDayKey(d))?.sessions ?? 0) >= target
    if (met) streak++
    else if (i === 0) continue // today in progress
    else break
  }

  return {
    todaySessions: today.sessions,
    todayMinutes: Math.round(today.seconds / 60),
    weekMinutes: Math.round(weekSeconds / 60),
    target,
    targetMet,
    streak
  }
}
