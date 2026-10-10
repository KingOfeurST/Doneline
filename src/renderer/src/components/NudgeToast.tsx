import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Nudge } from '../../../shared/api'
import { playBuzz, playNudge } from '../lib/audioFx'
import { useProfile } from '../profile'

const AUTO_DISMISS_MS = 8000

/**
 * In-app notifications for incoming nudges and buzzes.
 *
 * This is the component that actually clears a nudge: it marks it seen only once
 * it has been rendered, so a nudge can never be silently swallowed by an OS
 * notification the user didn't see. Buzzes also play a sound and flash the card.
 */
export default function NudgeToast() {
  const { self } = useProfile()
  const [queue, setQueue] = useState<Nudge[]>([])
  const seenRef = useRef<Set<string>>(new Set())
  const displayedRef = useRef<Set<string>>(new Set())
  // The 5s poll and the workspace:changed listener can fire together; without a
  // guard two in-flight checks could both claim the same nudge.
  const inFlight = useRef(false)
  const requestId = useRef(0)

  const check = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    const request = ++requestId.current
    try {
      const unseen = await api.presence.unseenNudges()
      if (request !== requestId.current) return
      const fresh = unseen.filter((n) => !seenRef.current.has(n.id))
      for (const n of fresh) seenRef.current.add(n.id)
      if (fresh.length > 0) setQueue((q) => {
        const existing = new Set(q.map((n) => n.id))
        return [...q, ...fresh.filter((n) => !existing.has(n.id))]
      })

      // Sound once per batch rather than once per nudge, so a burst isn't deafening.
      if (fresh.some((n) => n.kind === 'buzz')) playBuzz()
      else if (fresh.length > 0) playNudge()

      // Retry failed delivery receipts without showing or sounding the toast twice.
      for (const n of unseen) {
        if (request !== requestId.current) return
        if (!displayedRef.current.has(n.id)) continue
        try {
          await api.presence.markNudgeSeen(n.id)
        } catch {}
      }
    } catch {
      // Polling resumes when the local/shared store becomes available again.
    } finally {
      inFlight.current = false
    }
  }, [self])

  useEffect(() => {
    setQueue([])
    seenRef.current.clear()
    displayedRef.current.clear()
    check()
    const off = api.workspace.onChanged(check)
    const poll = setInterval(check, 5000)
    return () => {
      off()
      requestId.current++
      clearInterval(poll)
    }
  }, [check])

  function dismiss(id: string) {
    setQueue((q) => q.filter((n) => n.id !== id))
  }
  const displayed = useCallback((id: string) => { displayedRef.current.add(id) }, [])

  if (queue.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-5 top-20 z-[90] flex w-[min(340px,88vw)] flex-col gap-2">
      {queue.map((n) => (
        <ToastCard key={n.id} nudge={n} onDisplayed={displayed} onDismiss={() => dismiss(n.id)} />
      ))}
    </div>
  )
}

function ToastCard({ nudge, onDismiss, onDisplayed }: {
  nudge: Nudge; onDismiss: () => void; onDisplayed: (id: string) => void
}) {
  const buzz = nudge.kind === 'buzz'
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss
  useEffect(() => {
    onDisplayed(nudge.id)
    void api.presence.markNudgeSeen(nudge.id).catch(() => {})
  }, [nudge.id, onDisplayed])

  useEffect(() => {
    const t = setTimeout(() => dismissRef.current(), AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [nudge.id])

  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 rounded-2xl border p-4 shadow-clay backdrop-blur ${
        buzz
          ? 'animate-[buzzShake_0.5s_ease-in-out] border-amber-200 bg-amber-50/95'
          : 'border-white/70 bg-white/95'
      }`}
    >
      <span className="text-2xl leading-none">{buzz ? '⚡' : (nudge.from_emoji ?? '👋')}</span>
      <div className="min-w-0 flex-1">
        <p className="font-bold text-ink">
          {nudge.from_name ?? 'A friend'} {buzz ? 'buzzed you' : 'nudged you'}
        </p>
        <p className="mt-0.5 break-words text-sm font-semibold text-slate-500">
          {buzz ? 'Wake up! 👀' : nudge.message}
        </p>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-full p-1 text-slate-300 transition hover:bg-slate-100 hover:text-ink"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 6l8 8M14 6l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
