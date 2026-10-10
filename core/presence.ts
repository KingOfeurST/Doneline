import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import { getPerson } from './people.js'
import { timestamp } from './validation.js'
import type { Presence, Nudge, NudgeKind, FocusInvite } from './types.js'

export function setPresence(
  personId: string,
  p: { status: 'focusing' | 'idle'; phase?: 'focus' | 'break' | null; task_title?: string | null; ends_at?: string | null }
): void {
  requirePerson(personId)
  if (p.status !== 'focusing' && p.status !== 'idle') throw new Error('Invalid presence status.')
  if (p.phase != null && p.phase !== 'focus' && p.phase !== 'break') throw new Error('Invalid focus phase.')
  const endsAt = p.status === 'focusing' && p.ends_at ? timestamp(p.ends_at, 'Focus end') : null
  if (p.status === 'focusing' && !endsAt) throw new Error('A focusing status needs an end time.')
  getDb()
    .prepare(
      `INSERT INTO presence (person_id, status, phase, task_title, ends_at, updated_at)
       VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
       ON CONFLICT(person_id) DO UPDATE SET
         status = excluded.status, phase = excluded.phase,
         task_title = excluded.task_title, ends_at = excluded.ends_at,
         updated_at = excluded.updated_at`
    )
    .run(personId, p.status, p.status === 'focusing' ? p.phase ?? null : null,
      p.status === 'focusing' ? p.task_title ?? null : null, endsAt)
}

function requirePerson(id: string): void {
  if (!getPerson(id)) throw new Error('Select an existing profile.')
}

function requirePair(from: string, to: string): void {
  requirePerson(from)
  requirePerson(to)
  if (from === to) throw new Error('Choose another profile.')
}

export function listPresence(): Presence[] {
  return getDb().prepare('SELECT r.* FROM presence r JOIN people p ON p.id = r.person_id').all() as Presence[]
}

export function sendNudge(
  fromPerson: string,
  toPerson: string,
  message: string,
  kind: NudgeKind = 'message'
): Nudge {
  requirePair(fromPerson, toPerson)
  if (kind !== 'message' && kind !== 'buzz') throw new Error('Invalid nudge kind.')
  if (typeof message !== 'string' || (kind === 'message' && !message.trim())) throw new Error('Please enter a nudge message.')
  const db = getDb()
  const id = uuid()
  // Explicit UTC ISO (matching presence/reactions/notes) rather than the column's
  // datetime('now') default: that format is space-separated with no zone, which
  // JS Date misparses as local time.
  db.prepare(
    `INSERT INTO nudges (id, from_person, to_person, message, kind, created_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
  ).run(id, fromPerson, toPerson, message.trim(), kind)
  return db.prepare('SELECT * FROM nudges WHERE id = ?').get(id) as Nudge
}

/** Unseen nudges for a person, with the sender's name/emoji joined in.
 *  Anything older than 10 minutes is skipped so reopening the app after a long
 *  break doesn't dump a backlog of stale buzzes. */
export function unseenNudgesFor(personId: string): Nudge[] {
  return getDb()
    .prepare(
      `SELECT n.*, p.name AS from_name, p.emoji AS from_emoji
       FROM nudges n
       JOIN people p ON p.id = n.from_person
       WHERE n.to_person = ? AND n.seen = 0
         AND julianday(n.created_at) > julianday('now', '-10 minutes')
       ORDER BY julianday(n.created_at)`
    )
    .all(personId) as Nudge[]
}

/** True once the recipient's client has marked the nudge seen (delivery receipt). */
export function nudgeWasSeen(id: string): boolean {
  const row = getDb().prepare('SELECT seen FROM nudges WHERE id = ?').get(id) as
    | { seen: number }
    | undefined
  return row?.seen === 1
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
  requirePair(fromPerson, toPerson)
  if (![focusMin, breakMin].every((value) => Number.isInteger(value) && value >= 1 && value <= 180)) {
    throw new Error('Focus and break lengths must be whole minutes from 1 to 180.')
  }
  const db = getDb()
  const id = uuid()
  db.prepare(
    "INSERT INTO focus_invites (id, from_person, to_person, focus_min, break_min, created_at) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))"
  ).run(id, fromPerson, toPerson, focusMin, breakMin)
  return db.prepare('SELECT * FROM focus_invites WHERE id = ?').get(id) as FocusInvite
}

/** Open invites for a person — unhandled and sent within the last 5 minutes. */
export function pendingInvitesFor(personId: string): FocusInvite[] {
  return getDb()
    .prepare(
      `SELECT * FROM focus_invites
       WHERE to_person = ? AND seen = 0 AND accepted = 0 AND started_at IS NULL
         AND julianday(created_at) > julianday('now', '-5 minutes')
       ORDER BY julianday(created_at) DESC`
    )
    .all(personId) as FocusInvite[]
}

export function markInviteSeen(id: string): void {
  getDb().prepare('UPDATE focus_invites SET seen = 1 WHERE id = ?').run(id)
}

/** Friend accepted an invite — they're in the lobby waiting for the host to start. */
export function acceptInvite(id: string): void {
  const db = getDb()
  const invite = db.prepare('SELECT * FROM focus_invites WHERE id = ?').get(id) as FocusInvite | undefined
  if (!invite) throw new Error('This focus invite no longer exists.')
  if (invite.accepted === 1) return
  const result = db.prepare(`UPDATE focus_invites SET accepted = 1, seen = 1 WHERE id = ? AND seen = 0
    AND started_at IS NULL AND julianday(created_at) > julianday('now', '-5 minutes')`).run(id)
  if (!result.changes) throw new Error('This focus invite expired or was dismissed.')
}

/** Host starts the shared session: stamps the anchor both clients start from. */
export function startCoFocus(id: string): string {
  const db = getDb()
  return db.transaction(() => {
    const invite = db.prepare('SELECT * FROM focus_invites WHERE id = ?').get(id) as FocusInvite | undefined
    if (!invite || invite.accepted !== 1) throw new Error('Your friend must join before you start together.')
    // Retried requests must keep the same anchor for both clients.
    if (invite.started_at) return invite.started_at
    const recent = db.prepare("SELECT 1 FROM focus_invites WHERE id = ? AND julianday(created_at) > julianday('now', '-2 hours')").get(id)
    if (!recent) throw new Error('This focus invite expired. Send a new invite.')
    const startedAt = new Date().toISOString()
    db.prepare('UPDATE focus_invites SET started_at = ? WHERE id = ?').run(startedAt, id)
    return startedAt
  }).immediate()
}

/** The most recent co-focus invite involving a person (host or guest), last 2h. */
export function activeInviteFor(personId: string): FocusInvite | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM focus_invites
       WHERE (from_person = ? OR to_person = ?) AND (
         (accepted = 0 AND seen = 0 AND julianday(created_at) > julianday('now', '-5 minutes'))
         OR (accepted = 1 AND started_at IS NULL AND julianday(created_at) > julianday('now', '-2 hours'))
         OR (accepted = 1 AND started_at IS NOT NULL
           AND julianday(started_at) + (focus_min + break_min) / 1440.0 > julianday('now'))
       )
       ORDER BY julianday(created_at) DESC LIMIT 1`
    )
    .get(personId, personId) as FocusInvite | undefined
}
