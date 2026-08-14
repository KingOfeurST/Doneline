import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Nudge } from '../../../shared/api'
import { playBuzz, playNudge } from '../lib/audioFx'

const AUTO_DISMISS_MS = 8000

/**
 * In-app notifications for incoming nudges and buzzes.
 *
 * This is the component that actually clears a nudge: it marks it seen only once
 * it has been rendered, so a nudge can never be silently swallowed by an OS
 * notification the user didn't see. Buzzes also play a sound and flash the card.
 */
export default function NudgeToast() {
  const [queue, setQueue] = useState<Nudge[]>([])
  const seenRef = useRef<Set<string>>(new Set())

  const check = useCallback(async () => {
    const unseen = await api.presence.unseenNudges()
    const fresh = unseen.filter((n) => !seenRef.current.has(n.id))
    if (fresh.length === 0) return

    for (const n of fresh) seenRef.current.add(n.id)
    setQueue((q) => [...q, ...fresh])

    // Sound once per batch rather than once per nudge, so a burst isn't deafening.
    if (fresh.some((n) => n.kind === 'buzz')) playBuzz()
    else playNudge()

    // Displayed → safe to clear server-side.
    for (const n of fresh) api.presence.markNudgeSeen(n.id).catch(() => {})
  }, [])

  useEffect(() => {
    check()
    const off = api.workspace.onChanged(check)
    const poll = setInterval(check, 5000)
    return () => {
      off()
      clearInterval(poll)
    }
  }, [check])

  function dismiss(id: string) {
    setQueue((q) => q.filter((n) => n.id !== id))
  }

  if (queue.length === 0) return null

  return (
    <div className="pointer-events-none fixed right-5 top-20 z-[90] flex w-[min(340px,88vw)] flex-col gap-2">
      {queue.map((n) => (
        <ToastCard key={n.id} nudge={n} onDismiss={() => dismiss(n.id)} />
      ))}
    </div>
  )
}

function ToastCard({ nudge, onDismiss }: { nudge: Nudge; onDismiss: () => void }) {
  const buzz = nudge.kind === 'buzz'

  useEffect(() => {
    const t = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [onDismiss])

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
