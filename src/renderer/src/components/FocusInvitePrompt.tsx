import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { FocusInvite } from '../../../shared/api'
import { useFocus } from '../focus'
import { useProfile } from '../profile'

/** Shows the "join" banner for incoming invites and, once joined, auto-starts the
 *  guest in sync the moment the host fires the shared start. */
export default function FocusInvitePrompt() {
  const f = useFocus()
  const { personById, self } = useProfile()
  const [invite, setInvite] = useState<FocusInvite | null>(null)
  const consumedRef = useRef<string | null>(null)

  const check = useCallback(async () => {
    const pending = await api.presence.pendingInvites()
    setInvite(pending[0] ?? null)

    // Joined a session → start in sync as soon as the host stamps the anchor.
    const active = await api.presence.activeInvite()
    if (
      active &&
      active.to_person === self &&
      active.accepted === 1 &&
      active.started_at &&
      consumedRef.current !== active.id
    ) {
      consumedRef.current = active.id
      f.startAnchored(active.started_at, active.focus_min, active.break_min)
    }
  }, [self, f])

  useEffect(() => {
    check()
    const off = api.workspace.onChanged(check)
    const poll = setInterval(check, 8_000)
    return () => {
      off()
      clearInterval(poll)
    }
  }, [check])

  if (!invite) return null
  const from = personById(invite.from_person)

  async function join() {
    if (!invite) return
    await api.presence.acceptInvite(invite.id)
    setInvite(null)
    f.setWaiting(true)
    f.setOpen(true)
  }

  async function dismiss() {
    if (!invite) return
    await api.presence.markInviteSeen(invite.id)
    setInvite(null)
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
        <button className="btn-primary flex-1 py-2.5" onClick={join}>
          Join
        </button>
        <button className="btn-soft py-2.5" onClick={dismiss}>
          Not now
        </button>
      </div>
    </div>
  )
}
