import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useProfile } from '../profile'
import type { Person } from '../../../shared/api'
import { forgetNoteDraft, pendingNoteDraft, queueNoteWrite, registerNoteEditor, rememberNoteDraft, waitForNoteWrites } from '../lib/notePersistence'

const SAVE_DEBOUNCE_MS = 800

interface Props {
  day: string
  /** Whose note this is. Follows the profile switcher, so writing on a friend's
   *  profile writes their note and they actually see it. */
  personId: string
  /** Shown in the header when more than one note is on screen. */
  owner?: Person
  /** Shorter writing area, for when several notes stack in one column. */
  compact?: boolean
}

/**
 * One free-text note per day, per person, in the shared workspace. Autosaves on
 * a debounce so it never fights the typing cursor, and refreshes when a
 * background sync brings in the other person's edits.
 */
export default function DailyNote(props: Props) {
  // A new editor owns each note, so late responses from another day or person
  // cannot replace the note currently being written.
  return <NoteEditor key={`${props.day}:${props.personId}`} {...props} />
}

function NoteEditor({ day, personId, owner, compact = false }: Props) {
  const { tick } = useProfile()
  const [body, setBody] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const revision = useRef(0)
  const requestId = useRef(0)
  const writing = useRef(new Map<number, Promise<void>>())
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // Latest unsaved text (and who/when it belongs to) so the flush on unmount
  // writes the right thing even after the day or profile has changed.
  const pending = useRef<{ body: string; revision: number } | null>(null)
  const draftKey = `doneline.noteDraft:${day}:${personId}`

  /** Write immediately and drop the pending debounce. */
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const p = pending.current
    if (!p) return Promise.resolve()
    const existing = writing.current.get(p.revision)
    if (existing) return existing
    requestId.current++
    // Serialize writes to this note so an earlier slow save cannot arrive last.
    const operation = queueNoteWrite(draftKey, async () => {
        const persisted = await api.notes.set(day, p.body, personId)
        if (persisted.day !== day || persisted.person_id !== personId || persisted.body !== p.body) {
          throw new Error('The saved note did not match your draft.')
        }
        if (pending.current?.revision !== p.revision) return
        pending.current = null
        forgetNoteDraft(draftKey, p.revision)
        try {
          if (localStorage.getItem(draftKey) === p.body) localStorage.removeItem(draftKey)
        } catch {}
        if (!mounted.current) return
        setDirty(false)
        setError('')
        setSaved(true)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 1600)
      })
      .catch((cause) => {
        if (mounted.current && pending.current?.revision === p.revision) {
          setError('Could not save. Your draft is kept on this device.')
          setSaved(false)
        }
        throw cause
      })
      .finally(() => writing.current.delete(p.revision))
    writing.current.set(p.revision, operation)
    return operation
  }, [day, personId, draftKey])

  // Load when the day or the selected person changes. Flush first so text typed
  // just before the switch is saved against the note it was written for.
  useEffect(() => {
    if (!day || !personId) return
    let cancelled = false
    const request = ++requestId.current
    // Show a preserved draft even if the database read later fails at startup.
    let recovered = pendingNoteDraft(draftKey)
    if (!recovered) {
      try {
        const draft = localStorage.getItem(draftKey)
        if (draft !== null) recovered = rememberNoteDraft(draftKey, draft)
      } catch {}
    }
    if (recovered) {
      pending.current = recovered
      revision.current++
      setBody(recovered.body)
      setDirty(true)
    }
    waitForNoteWrites(draftKey).then(() => api.notes.get(day, personId)).then((n) => {
      if (cancelled || request !== requestId.current) return
      let draft = pendingNoteDraft(draftKey)
      if (!draft) {
        try {
          const stored = localStorage.getItem(draftKey)
          if (stored !== null) draft = rememberNoteDraft(draftKey, stored)
        } catch {}
      }
      setBody(draft?.body ?? n.body)
      pending.current = draft
      if (draft) {
        revision.current++
        setDirty(true)
        void flush().catch(() => {})
      } else setDirty(false)
    }).catch(() => {
      if (!cancelled && request === requestId.current) {
        const draft = pendingNoteDraft(draftKey)
        if (draft) {
          setBody(draft.body)
          pending.current = draft
          revision.current++
          setDirty(true)
          setError('Could not load the saved note. Your local draft is shown below.')
        } else {
          setLoadFailed(true)
          setError('Could not load this note. Please reopen it to try again.')
        }
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [day, personId, draftKey, flush])

  // A background sync may carry the other person's edits. Only pull them in when
  // this note has nothing unsaved and isn't being typed in, so a refresh can
  // never stomp the cursor or discard local text.
  useEffect(() => {
    if (!day || !personId || tick === 0) return
    if (pending.current || writing.current.size > 0 || loading) return
    if (document.activeElement === areaRef.current) return
    const request = ++requestId.current
    const currentRevision = revision.current
    api.notes.get(day, personId).then((n) => {
      if (!mounted.current || request !== requestId.current || currentRevision !== revision.current || pending.current) return
      setBody((cur) => n.body === cur ? cur : n.body)
    }).catch(() => {})
  }, [tick, day, personId, loading])

  // Save on unmount (tab switch) and on window close — a debounce that is merely
  // cancelled would silently discard the last keystrokes.
  useEffect(() => {
    mounted.current = true
    const unregister = registerNoteEditor(draftKey, () => pending.current !== null, flush)
    const beforeUnload = () => { void flush().catch(() => {}) }
    window.addEventListener('beforeunload', beforeUnload)
    return () => {
      mounted.current = false
      window.removeEventListener('beforeunload', beforeUnload)
      void flush().catch(() => {})
      unregister()
      if (savedTimer.current) clearTimeout(savedTimer.current)
    }
  }, [flush])

  function edit(next: string) {
    setBody(next)
    setSaved(false)
    setError('')
    setDirty(true)
    revision.current++
    pending.current = rememberNoteDraft(draftKey, next)
    // Preserve the final keystrokes if the window closes before IPC finishes.
    try { localStorage.setItem(draftKey, next) } catch {}
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void flush().catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }

  const words = body.trim() ? body.trim().split(/\s+/).length : 0

  return (
    <section
      className="rise flex flex-col overflow-hidden rounded-xl2 border border-amber-200/70 shadow-clay"
      style={{ background: 'linear-gradient(180deg,#fffdf5 0%,#fdf7e7 100%)' }}
    >
      <div className="flex items-center justify-between border-b border-amber-200/60 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          {owner ? (
            <span
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm"
              style={{ background: owner.color + '33' }}
            >
              {owner.emoji}
            </span>
          ) : (
            <svg viewBox="0 0 20 20" className="h-4 w-4 text-amber-700/70" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 16.5V14l9-9 2.5 2.5-9 9H4z" strokeLinejoin="round" />
            </svg>
          )}
          <h2 className="truncate text-lg font-extrabold text-amber-950">
            {owner ? `${owner.name}’s note` : 'Note'}
          </h2>
        </div>
        <span className="shrink-0 text-xs font-bold text-amber-700/60">
          {loading ? 'Loading…' : error ? 'Not saved' : saved ? 'Saved' : dirty ? 'Saving…' : words > 0 ? `${words} word${words === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <textarea
        ref={areaRef}
        value={body}
        disabled={loading || loadFailed}
        aria-label={owner ? `${owner.name}'s note` : 'Daily note'}
        onChange={(e) => edit(e.target.value)}
        placeholder={'Brain dump, plans, how today went…'}
        spellCheck={false}
        className={`${compact ? 'min-h-[168px]' : 'min-h-[320px]'} flex-1 resize-none bg-transparent px-5 py-4 text-[15px] font-medium leading-7 text-amber-950 outline-none placeholder:font-semibold placeholder:text-amber-700/35`}
        style={{
          backgroundImage:
            'repeating-linear-gradient(180deg, transparent 0px, transparent 27px, rgba(180,140,60,0.13) 28px)',
          backgroundAttachment: 'local'
        }}
      />
      {error && <div role="alert" className="px-5 pb-4 text-xs font-semibold text-rose-ink">
        {error}
        {pending.current && <button onClick={() => { void flush().catch(() => {}) }} className="ml-2 underline">Retry save</button>}
      </div>}
    </section>
  )
}
