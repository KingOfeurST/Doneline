import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

const SAVE_DEBOUNCE_MS = 800

/**
 * One free-text note per day, scoped to this device's profile. Autosaves on a
 * debounce so it never fights the typing cursor, and syncs like everything else.
 */
export default function DailyNote({ day }: { day: string }) {
  const [body, setBody] = useState('')
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  const loadedFor = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load whenever the day changes. Guarded so a pending save isn't clobbered.
  useEffect(() => {
    if (!day || loadedFor.current === day) return
    loadedFor.current = day
    api.notes.get(day).then((n) => {
      setBody(n.body)
      if (n.body.trim()) setOpen(true)
    })
  }, [day])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  function edit(next: string) {
    setBody(next)
    setSaved(false)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      api.notes
        .set(day, next)
        .then(() => {
          setSaved(true)
          setTimeout(() => setSaved(false), 1500)
        })
        .catch(() => {})
    }, SAVE_DEBOUNCE_MS)
  }

  const words = body.trim() ? body.trim().split(/\s+/).length : 0

  return (
    <section className="card rise p-7" style={{ animationDelay: '140ms' }}>
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <div className="text-left">
          <h2 className="text-2xl font-extrabold text-ink">Note</h2>
          <p className="mt-0.5 text-sm font-semibold text-slate-500">
            {open
              ? 'Brain dump, plans, how the day went.'
              : words > 0
                ? `${words} word${words === 1 ? '' : 's'} written today`
                : 'Nothing written yet today.'}
          </p>
        </div>
        <span className="flex items-center gap-2">
          {saved && <span className="text-xs font-bold text-mint-ink">Saved</span>}
          <span className="text-slate-400">{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {open && (
        <textarea
          value={body}
          onChange={(e) => edit(e.target.value)}
          placeholder="What's on your mind today?"
          rows={6}
          className="input mt-4 w-full resize-y leading-relaxed"
        />
      )}
    </section>
  )
}
