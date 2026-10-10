import { getDb } from './db.js'
import { editICSScoped, excludeICSOccurrence, icsIncludesOccurrenceIdentity, type ICSInput, type ICSEditScope } from './ics.js'
import type { CalendarResource } from './calendarResources.js'

export interface CalendarResourceChange {
  id: string
  person_id: string
  uid: string
  url: string | null
  patch: string
  created_at: string
}

export interface CalendarResourceEdit {
  scope: ICSEditScope
  recurrenceId?: string | null
  input: ICSInput
}
export interface CalendarResourceExclusion { scope: 'exclude'; recurrenceId: string; uid: string }
export type CalendarResourcePatch = CalendarResourceEdit | CalendarResourceExclusion

export function resourceChanges(personId: string, uid?: string): CalendarResourceChange[] {
  return getDb().prepare(`SELECT * FROM calendar_resource_changes WHERE person_id = ?${uid ? ' AND uid = ?' : ''} ORDER BY created_at, rowid`)
    .all(personId, ...(uid ? [uid] : [])) as CalendarResourceChange[]
}

export function applyResourceChanges(resource: CalendarResource, changes = resourceChanges(resource.person_id, resource.uid)): string {
  let ics = resource.ics
  for (const change of changes) {
    if (change.url && resource.url && change.url !== resource.url) continue
    const patch = JSON.parse(change.patch) as CalendarResourcePatch
    ics = patch.scope === 'exclude' ? excludeICSOccurrence(ics, patch.uid, patch.recurrenceId) : editICSScoped(ics, patch.input, patch.scope, patch.recurrenceId)
  }
  return ics
}

/** Called inside Trash restore: retain deletions if the series has since changed. */
export function prepareRestoredRemoteOccurrence(personId: string, uid: string, recurrenceId: string): boolean {
  const resource = getDb().prepare('SELECT * FROM calendar_resources WHERE person_id = ? AND uid = ?').get(personId, uid) as CalendarResource | undefined
  if (!resource || !icsIncludesOccurrenceIdentity(applyResourceChanges(resource), uid, recurrenceId)) return false
  for (const change of resourceChanges(personId, uid)) {
    const patch = JSON.parse(change.patch) as CalendarResourcePatch
    if (patch.scope === 'exclude' && patch.recurrenceId === recurrenceId) getDb().prepare('DELETE FROM calendar_resource_changes WHERE id = ?').run(change.id)
  }
  return true
}
