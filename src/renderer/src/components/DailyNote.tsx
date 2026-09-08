import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useProfile } from '../profile'
import type { Person } from '../../../shared/api'

const SAVE_DEBOUNCE_MS = 800

interface Props {
  day: string
  /** Whose note this is. Follows the profile switcher, so writing on a friend's
   *  profile writes their note and they actually see it. */
  personId: string
  /** Shown in the header when more than one note is on screen. */
  owner?: Person
}

/**
 * One free-text note per day, per person, in the shared workspace. Autosaves on
 * a debounce so it never fights the typing cursor, and refreshes when a
 * background sync brings in the other person's edits.
 */
export default function DailyNote({ day, personId, owner }: Props) {
  const { tick } = useProfile()
  const [body, setBody] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const loadedFor = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // Latest unsaved text (and who/when it belongs to) so the flush on unmount
  // writes the right thing even after the day or profile has changed.
  const pending = useRef<{ day: string; personId: string; body: string } | null>(null)

  /** Write immediately and drop the pending debounce. */
  function flush() {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const p = pending.current
    if (!p) return
    pending.current = null
    api.notes.set(p.day, p.body, p.personId).catch(() => {})
  }

  // Load when the day or the selected person changes. Flush first so text typed
  // just before the switch is saved against the note it was written for.
  const key = `${day}:${personId}`
  useEffect(() => {
    if (!day || !personId || loadedFor.current === key) return
    flush()
    loadedFor.current = key
    api.notes.get(day, personId).then((n) => setBody(n.body))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // A background sync may carry the other person's edits. Only pull them in when
  // this note has nothing unsaved and isn't being typed in, so a refresh can
  // never stomp the cursor or discard local text.
  useEffect(() => {
    if (!day || !personId || tick === 0) return
    if (pending.current || dirty) return
    if (document.activeElement === areaRef.current) return
    api.notes.get(day, personId).then((n) => setBody((cur) => (n.body === cur ? cur : n.body)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  // Save on unmount (tab switch) and on window close — a debounce that is merely
  // cancelled would silently discard the last keystrokes.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function edit(next: string) {
    setBody(next)
    setSaved(false)
    setDirty(true)
    pending.current = { day, personId, body: next }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const p = pending.current
      if (!p) return
      pending.current = null
      api.notes
        .set(p.day, p.body, p.personId)
        .then(() => {
          setDirty(false)
          setSaved(true)
          setTimeout(() => setSaved(false), 1600)
        })
        .catch(() => {})
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
          {saved ? 'Saved' : dirty ? 'Saving…' : words > 0 ? `${words} word${words === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <textarea
        ref={areaRef}
        value={body}
        onChange={(e) => edit(e.target.value)}
        placeholder={'Brain dump, plans, how today went…'}
        spellCheck={false}
        className="min-h-[320px] flex-1 resize-none bg-transparent px-5 py-4 text-[15px] font-medium leading-7 text-amber-950 outline-none placeholder:font-semibold placeholder:text-amber-700/35"
        style={{
          backgroundImage:
            'repeating-linear-gradient(180deg, transparent 0px, transparent 27px, rgba(180,140,60,0.13) 28px)',
          backgroundAttachment: 'local'
        }}
      />
    </section>
  )
}
