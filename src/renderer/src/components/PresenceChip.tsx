import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { usePresence, clockFromSeconds, type FriendPresence } from '../presence'
import { useFocus } from '../focus'

const MESSAGES = ['Study with me? 📚', 'Break time? ☕', 'How’s it going? 👀']
const BUZZ_COOLDOWN_MS = 10_000

type Status = { kind: 'sent' | 'delivered' | 'invited' | 'error'; text: string }

export default function PresenceChip() {
  const { friends, nudge } = usePresence()
  const f = useFocus()
  const [cloud, setCloud] = useState(false)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [buzzCooldown, setBuzzCooldown] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const receiptTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    api.workspace.status().then((s) => setCloud(s.cloud))
  }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [])

  // Tick the buzz cooldown down to zero.
  useEffect(() => {
    if (buzzCooldown <= 0) return
    const t = setTimeout(() => setBuzzCooldown((c) => Math.max(0, c - 1000)), 1000)
    return () => clearTimeout(t)
  }, [buzzCooldown])

  useEffect(() => {
    return () => {
      if (receiptTimer.current) clearInterval(receiptTimer.current)
    }
  }, [])

  if (!cloud || friends.length === 0) return null

  // Prefer showing a friend who's currently focusing.
  const friend: FriendPresence = friends.find((fr) => fr.status === 'focusing') ?? friends[0]
  const reachable = friend.status !== 'offline'

  const label =
    friend.status === 'focusing'
      ? `Focusing · ${clockFromSeconds(friend.secondsLeft)}`
      : friend.status === 'idle'
        ? 'Around'
        : 'Offline'

  /** Poll for the delivery receipt so you know the nudge actually landed. */
  function watchReceipt(nudgeId: string) {
    if (receiptTimer.current) clearInterval(receiptTimer.current)
    let waited = 0
    receiptTimer.current = setInterval(async () => {
      waited += 2000
      const seen = await api.presence.nudgeWasSeen(nudgeId).catch(() => false)
      if (seen) {
        setStatus({ kind: 'delivered', text: 'Delivered ✓' })
        if (receiptTimer.current) clearInterval(receiptTimer.current)
        setTimeout(() => setStatus(null), 2500)
      } else if (waited >= 30_000) {
        if (receiptTimer.current) clearInterval(receiptTimer.current)
        setStatus({ kind: 'sent', text: 'Sent · not seen yet' })
        setTimeout(() => setStatus(null), 3000)
      }
    }, 2000)
  }

  async function sendMessage(message: string) {
    try {
      const n = await nudge(friend.person.id, message)
      setStatus({ kind: 'sent', text: 'Sent 👍' })
      watchReceipt(n.id)
    } catch {
      setStatus({ kind: 'error', text: "Couldn't send" })
    }
  }

  async function sendBuzz() {
    if (buzzCooldown > 0) return
    setBuzzCooldown(BUZZ_COOLDOWN_MS)
    try {
      const n = await api.presence.nudge(friend.person.id, 'Buzz!', 'buzz')
      setStatus({ kind: 'sent', text: 'Buzzed ⚡' })
      watchReceipt(n.id)
    } catch {
      setStatus({ kind: 'error', text: "Couldn't buzz" })
    }
  }

  /** Real co-focus invite — the partner gets a Join banner. */
  async function inviteToFocus() {
    try {
      await api.presence.invite(friend.person.id, f.focusMin, f.breakMin)
      setStatus({
        kind: 'invited',
        text: `Invite sent · ${f.focusMin}min. Start when they join.`
      })
      f.setOpen(true)
      setTimeout(() => setStatus(null), 4000)
    } catch {
      setStatus({ kind: 'error', text: "Couldn't invite" })
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full bg-white/70 py-1.5 pl-2 pr-3 shadow-clay-sm backdrop-blur transition hover:bg-white"
        title={`${friend.person.name} — ${label}`}
      >
        <span
          className="relative flex h-7 w-7 items-center justify-center rounded-full text-sm"
          style={{ background: friend.person.color + '33' }}
        >
          {friend.person.emoji}
          {friend.status === 'focusing' && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-mint-ink ring-2 ring-white" />
          )}
          {friend.status === 'idle' && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-sky-400 ring-2 ring-white" />
          )}
        </span>
        <span className="hidden text-xs font-bold text-ink sm:inline">{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-2xl border border-white/70 bg-white/95 p-3 shadow-clay backdrop-blur">
          <p className="mb-2 px-1 text-sm font-bold text-ink">
            {friend.person.emoji} {friend.person.name}
          </p>
          <p className="mb-3 px-1 text-xs font-semibold text-slate-500">
            {friend.status === 'focusing'
              ? `Focusing${friend.taskTitle ? ` on ${friend.taskTitle}` : ''} · ${clockFromSeconds(friend.secondsLeft)} left`
              : friend.status === 'idle'
                ? 'Online, not focusing'
                : 'Offline · they’ll see this when they open the app'}
          </p>

          {status ? (
            <p
              className={`rounded-xl px-3 py-2 text-sm font-bold ${
                status.kind === 'error'
                  ? 'bg-rose-card text-rose-ink'
                  : status.kind === 'delivered'
                    ? 'bg-mint-card text-mint-ink'
                    : 'bg-slate-100 text-slate-600'
              }`}
            >
              {status.text}
            </p>
          ) : (
            <div className="space-y-1.5">
              <button
                onClick={inviteToFocus}
                className="w-full rounded-xl bg-mint-ink px-3 py-2.5 text-left text-sm font-bold text-white transition hover:brightness-110"
              >
                Let’s focus together 👊
              </button>

              {MESSAGES.map((m) => (
                <button
                  key={m}
                  onClick={() => sendMessage(m)}
                  className="w-full rounded-xl bg-slate-100/80 px-3 py-2 text-left text-sm font-bold text-ink transition hover:bg-slate-200/80"
                >
                  {m}
                </button>
              ))}

              <button
                onClick={sendBuzz}
                disabled={buzzCooldown > 0}
                title={reachable ? 'Shake their window' : 'They are offline right now'}
                className="w-full rounded-xl bg-amber-100 px-3 py-2 text-left text-sm font-bold text-amber-900 transition hover:bg-amber-200 disabled:opacity-40"
              >
                {buzzCooldown > 0
                  ? `⚡ Buzz (${Math.ceil(buzzCooldown / 1000)}s)`
                  : '⚡ Buzz them'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
