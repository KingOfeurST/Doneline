import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

const SAVE_DEBOUNCE_MS = 800

/**
 * One free-text note per day, scoped to this device's profile. Autosaves on a
 * debounce so it never fights the typing cursor, and syncs like everything else.
 * Always visible (no collapse) — a scratchpad you can't see is a scratchpad you
 * won't use.
 */
export default function DailyNote({ day }: { day: string }) {
  const [body, setBody] = useState('')
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const loadedFor = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Latest unsaved text (and the day it belongs to) so the flush on unmount
  // writes the right thing even after `day` has rolled over.
  const pending = useRef<{ day: string; body: string } | null>(null)

  /** Write immediately and drop the pending debounce. */
  function flush() {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const p = pending.current
    if (!p) return
    pending.current = null
    api.notes.set(p.day, p.body).catch(() => {})
  }

  // Load whenever the day changes. Flush first so text typed just before a
  // midnight rollover is saved against the day it was written for.
  useEffect(() => {
    if (!day || loadedFor.current === day) return
    flush()
    loadedFor.current = day
    api.notes.get(day).then((n) => setBody(n.body))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day])

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
    pending.current = { day, body: next }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      const p = pending.current
      if (!p) return
      pending.current = null
      api.notes
        .set(p.day, p.body)
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
      style={{ animationDelay: '140ms', background: 'linear-gradient(180deg,#fffdf5 0%,#fdf7e7 100%)' }}
    >
      <div className="flex items-center justify-between border-b border-amber-200/60 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 20 20" className="h-4 w-4 text-amber-700/70" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 16.5V14l9-9 2.5 2.5-9 9H4z" strokeLinejoin="round" />
          </svg>
          <h2 className="text-lg font-extrabold text-amber-950">Note</h2>
        </div>
        <span className="text-xs font-bold text-amber-700/60">
          {saved ? 'Saved' : dirty ? 'Saving…' : words > 0 ? `${words} word${words === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      <textarea
        value={body}
        onChange={(e) => edit(e.target.value)}
        placeholder={'Brain dump, plans, how today went…'}
        spellCheck={false}
        className="min-h-[320px] flex-1 resize-none bg-transparent px-5 py-4 text-[15px] font-medium leading-7 text-amber-950 outline-none placeholder:font-semibold placeholder:text-amber-700/35"
        style={{
          // Faint ruled lines, aligned to the 28px line-height.
          backgroundImage:
            'repeating-linear-gradient(180deg, transparent 0px, transparent 27px, rgba(180,140,60,0.13) 28px)',
          backgroundAttachment: 'local'
        }}
      />
    </section>
  )
}
