export interface DeletedItems {
  trashIds: string[]
  label: string
}

/** A single app-level toast follows deletions across tabs and profiles. */
export function notifyDeleted(trashId: string | string[] | null | undefined, label: string): void {
  const trashIds = (Array.isArray(trashId) ? trashId : [trashId]).filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (trashIds.length) window.dispatchEvent(new CustomEvent<DeletedItems>('doneline:deleted', { detail: { trashIds, label } }))
}
