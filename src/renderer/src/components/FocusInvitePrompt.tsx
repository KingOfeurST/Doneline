import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { FocusInvite } from '../../../shared/api'
import { useFocus } from '../focus'
import { useProfile } from '../profile'

/** Shows the "join" banner for incoming invites and, once joined, auto-starts the
 *  guest in sync the moment the host fires the shared start. */
export default function FocusInvitePrompt() {
  const { startAnchored, setWaiting, setOpen, waiting } = useFocus()
  const { personById, self } = useProfile()
  const [invite, setInvite] = useState<FocusInvite | null>(null)
  const consumedRef = useRef<string | null>(null)
  const waitingInvite = useRef<string | null>(null)
  const requestId = useRef(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const check = useCallback(async () => {
    const request = ++requestId.current
    try {
      const [pending, active] = await Promise.all([
        api.presence.pendingInvites(), api.presence.activeInvite()
      ])
      if (request !== requestId.current) return
      setInvite(pending[0] ?? null)

      // Joined a session → start in sync as soon as the host stamps the anchor.
      if (
        active &&
        active.to_person === self &&
        active.accepted === 1 &&
        active.started_at &&
        waiting && waitingInvite.current === active.id &&
        Date.now() < new Date(active.started_at).getTime() + active.focus_min * 60_000 &&
        consumedRef.current !== active.id
      ) {
        consumedRef.current = active.id
        startAnchored(active.started_at, active.focus_min, active.break_min)
      }
    } catch {}
  }, [self, waiting, startAnchored])

  useEffect(() => {
    check()
    const off = api.workspace.onChanged(check)
    const poll = setInterval(check, 8_000)
    return () => {
      off()
      clearInterval(poll)
      requestId.current++
    }
  }, [check])

  if (!invite) return null
  const from = personById(invite.from_person)

  async function join() {
    if (!invite || busy) return
    setBusy(true)
    setError('')
    try {
      await api.presence.acceptInvite(invite.id)
      waitingInvite.current = invite.id
      setInvite(null)
      setWaiting(true)
      setOpen(true)
    } catch {
      setError('Could not join. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function dismiss() {
    if (!invite || busy) return
    setBusy(true)
    setError('')
    try {
      await api.presence.markInviteSeen(invite.id)
      setInvite(null)
    } catch {
      setError('Could not dismiss this invite. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed bottom-6 left-1/2 z-[80] w-[min(420px,90vw)] -translate-x-1/2 rounded-2xl border border-white/70 bg-white/95 p-4 shadow-clay backdrop-blur">
      <p className="font-bold text-ink">
        {from?.emoji ?? '👋'} {from?.name ?? 'A friend'} wants to focus together
      </p>
      <p className="mt-0.5 text-sm font-semibold text-slate-500">
        A {invite.focus_min}-min focus · {invite.break_min}-min break
      </p>
      <div className="mt-3 flex gap-2">
        <button className="btn-primary flex-1 py-2.5" onClick={join} disabled={busy}>
          Join
        </button>
        <button className="btn-soft py-2.5" onClick={dismiss} disabled={busy}>
          Not now
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm font-semibold text-rose-ink">{error}</p>}
    </div>
  )
}
