import { v4 as uuid } from 'uuid'
import { getDb } from './db.js'
import type { ActivityEntry } from './types.js'

export function logActivity(personId: string, action: string, payload: Record<string, unknown> = {}): void {
  try {
    getDb()
      .prepare('INSERT INTO activity_log (id, person_id, action, payload) VALUES (?, ?, ?, ?)')
      .run(uuid(), personId, action, JSON.stringify(payload))
  } catch {
    // activity logging must never crash the caller
  }
}

export function listActivity(limit = 60): ActivityEntry[] {
  return getDb()
    .prepare(`
      SELECT al.*, p.name AS person_name, p.emoji AS person_emoji
      FROM activity_log al
      LEFT JOIN people p ON p.id = al.person_id
      ORDER BY al.created_at DESC
      LIMIT ?
    `)
    .all(limit) as ActivityEntry[]
}
