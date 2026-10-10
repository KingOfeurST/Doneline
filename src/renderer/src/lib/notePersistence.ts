import { KeyedSerialQueue } from './serialQueue'

const writes = new KeyedSerialQueue()
const inFlight = new Set<Promise<unknown>>()
const editors = new Map<symbol, { key: string; active: boolean; hasPending: () => boolean; flush: () => Promise<void> }>()
const drafts = new Map<string, { body: string; revision: number }>()
let nextRevision = 0

export function rememberNoteDraft(key: string, body: string): { body: string; revision: number } {
  const draft = { body, revision: ++nextRevision }
  drafts.set(key, draft)
  return draft
}

export function pendingNoteDraft(key: string): { body: string; revision: number } | null {
  return drafts.get(key) ?? null
}

export function forgetNoteDraft(key: string, revision: number): void {
  if (drafts.get(key)?.revision === revision) drafts.delete(key)
}

function pruneInactiveEditors() {
  for (const [id, editor] of editors) {
    if (!editor.active && !editor.hasPending()) editors.delete(id)
  }
}

export function queueNoteWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const operation = writes.run(key, task)
  inFlight.add(operation)
  const settled = () => { inFlight.delete(operation); pruneInactiveEditors() }
  operation.then(settled, settled)
  return operation
}

export function waitForNoteWrites(key: string): Promise<unknown> {
  return writes.wait(key)
}

export function registerNoteEditor(key: string, hasPending: () => boolean, flush: () => Promise<void>): () => void {
  // The replacement editor adopts the preserved draft. Its newer saves must
  // never be overwritten by retrying an inactive editor's obsolete closure.
  for (const [id, previous] of editors) {
    if (previous.key === key && !previous.active) editors.delete(id)
  }
  const id = Symbol('note editor')
  const editor = { key, active: true, hasPending, flush }
  editors.set(id, editor)
  return () => {
    editor.active = false
    // A failed unmounted save must still be retried before quitting.
    pruneInactiveEditors()
  }
}

/** Resolves only after all current drafts, including inactive editors, are saved. */
export async function flushPendingNotes(): Promise<void> {
  do {
    await Promise.all([...editors.values()].map((editor) => editor.flush()))
    await Promise.all([...inFlight])
    pruneInactiveEditors()
    // An edit made while a previous write was pending needs its own acknowledgement.
  } while (inFlight.size > 0 || [...editors.values()].some((editor) => editor.hasPending()))
}
