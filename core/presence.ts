import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import type { Presence, Nudge, FocusInvite } from './types.js'

export function setPresence(
  personId: string,
  p: { status: 'focusing' | 'idle'; phase?: 'focus' | 'break' | null; task_title?: string | null; ends_at?: string | null }
): void {
  getDb()
    .prepare(
      `INSERT INTO presence (person_id, status, phase, task_title, ends_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(person_id) DO UPDATE SET
         status = excluded.status, phase = excluded.phase,
         task_title = excluded.task_title, ends_at = excluded.ends_at,
         updated_at = excluded.updated_at`
    )
    .run(personId, p.status, p.phase ?? null, p.task_title ?? null, p.ends_at ?? null)
}

export function listPresence(): Presence[] {
  return getDb().prepare('SELECT * FROM presence').all() as Presence[]
}

export function sendNudge(fromPerson: string, toPerson: string, message: string): Nudge {
  const db = getDb()
  const id = uuid()
  db.prepare(
    'INSERT INTO nudges (id, from_person, to_person, message) VALUES (?, ?, ?, ?)'
  ).run(id, fromPerson, toPerson, message.trim())
  return db.prepare('SELECT * FROM nudges WHERE id = ?').get(id) as Nudge
}

export function unseenNudgesFor(personId: string): Nudge[] {
  return getDb()
    .prepare('SELECT * FROM nudges WHERE to_person = ? AND seen = 0 ORDER BY created_at')
    .all(personId) as Nudge[]
}

export function markNudgeSeen(id: string): void {
  getDb().prepare('UPDATE nudges SET seen = 1 WHERE id = ?').run(id)
}

/* ---------------------------- Focus invites ---------------------------- */

export function sendFocusInvite(
  fromPerson: string,
  toPerson: string,
  focusMin: number,
  breakMin: number
): FocusInvite {
  const db = getDb()
  const id = uuid()
  db.prepare(
    'INSERT INTO focus_invites (id, from_person, to_person, focus_min, break_min) VALUES (?, ?, ?, ?, ?)'
  ).run(id, fromPerson, toPerson, focusMin, breakMin)
  return db.prepare('SELECT * FROM focus_invites WHERE id = ?').get(id) as FocusInvite
}

/** Open invites for a person — unhandled and sent within the last 5 minutes. */
export function pendingInvitesFor(personId: string): FocusInvite[] {
  return getDb()
    .prepare(
      `SELECT * FROM focus_invites
       WHERE to_person = ? AND seen = 0 AND created_at > datetime('now', '-5 minutes')
       ORDER BY created_at DESC`
    )
    .all(personId) as FocusInvite[]
}

export function markInviteSeen(id: string): void {
  getDb().prepare('UPDATE focus_invites SET seen = 1 WHERE id = ?').run(id)
}

/** Friend accepted an invite — they're in the lobby waiting for the host to start. */
export function acceptInvite(id: string): void {
  getDb().prepare('UPDATE focus_invites SET accepted = 1, seen = 1 WHERE id = ?').run(id)
}

/** Host starts the shared session: stamps the anchor both clients start from. */
export function startCoFocus(id: string): string {
  const startedAt = new Date().toISOString()
  getDb().prepare('UPDATE focus_invites SET started_at = ? WHERE id = ?').run(startedAt, id)
  return startedAt
}

/** The most recent co-focus invite involving a person (host or guest), last 2h. */
export function activeInviteFor(personId: string): FocusInvite | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM focus_invites
       WHERE (from_person = ? OR to_person = ?) AND created_at > datetime('now', '-2 hours')
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(personId, personId) as FocusInvite | undefined
}
