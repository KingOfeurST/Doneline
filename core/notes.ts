import { getDb } from './db.js'
import { getPerson, primaryPersonId } from './people.js'
import { parseLocalDate } from './recurrenceRules.js'
import type { DailyNote } from './types.js'

/** The note for one day and person. Returns an empty note rather than undefined
 *  so callers can bind a textarea straight to `body`. */
export function getDailyNote(day: string, personId?: string): DailyNote {
  parseLocalDate(day)
  const pid = personId || primaryPersonId()
  const row = getDb()
    .prepare('SELECT * FROM daily_notes WHERE day = ? AND person_id = ?')
    .get(day, pid) as DailyNote | undefined
  return row ?? { day, person_id: pid, body: '', updated_at: '' }
}

export function setDailyNote(day: string, body: string, personId?: string): DailyNote {
  parseLocalDate(day)
  if (typeof body !== 'string') throw new Error('A daily note must contain text.')
  const pid = personId || primaryPersonId()
  if (!getPerson(pid)) throw new Error('Select an existing profile.')
  getDb()
    .prepare(
      `INSERT INTO daily_notes (day, person_id, body, updated_at)
       VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(day, person_id) DO UPDATE SET
         body = excluded.body, updated_at = excluded.updated_at`
    )
    .run(day, pid, body)
  return getDailyNote(day, pid)
}

/** Days that have a non-empty note, newest first — for a future history view. */
export function listNoteDays(personId?: string, limit = 30): string[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Note history limit must be from 1 to 1000.')
  const pid = personId || primaryPersonId()
  const rows = getDb()
    .prepare(
      `SELECT day FROM daily_notes
       WHERE person_id = ? AND TRIM(body) != ''
       ORDER BY day DESC LIMIT ?`
    )
    .all(pid, limit) as Array<{ day: string }>
  return rows.map((r) => r.day)
}
