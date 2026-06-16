import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { usePresence, clockFromSeconds, type FriendPresence } from '../presence'

const NUDGES = ["Let's focus 👊", 'Study with me? 📚', 'Break time? ☕']

export default function PresenceChip() {
  const { friends, nudge } = usePresence()
  const [cloud, setCloud] = useState(false)
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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

  if (!cloud || friends.length === 0) return null

  // Prefer showing a friend who's currently focusing.
  const friend: FriendPresence = friends.find((f) => f.status === 'focusing') ?? friends[0]

  const label =
    friend.status === 'focusing'
      ? `Focusing · ${clockFromSeconds(friend.secondsLeft)}`
      : friend.status === 'idle'
        ? 'Around'
        : 'Offline'

  async function sendNudge(message: string) {
    await nudge(friend.person.id, message)
    setSent(true)
    setTimeout(() => {
      setSent(false)
      setOpen(false)
    }, 1200)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full bg-white/70 py-1.5 pl-2 pr-3 shadow-clay-sm backdrop-blur transition hover:bg-white"
        title={`${friend.person.name} — ${label}`}
      >
        <span className="relative flex h-7 w-7 items-center justify-center rounded-full text-sm" style={{ background: friend.person.color + '33' }}>
          {friend.person.emoji}
          {friend.status === 'focusing' && (
            <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-mint-ink ring-2 ring-white" />
          )}
        </span>
        <span className="hidden text-xs font-bold text-ink sm:inline">{label}</span>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-60 rounded-2xl border border-white/70 bg-white/95 p-3 shadow-clay backdrop-blur">
          <p className="mb-2 px-1 text-sm font-bold text-ink">
            {friend.person.emoji} {friend.person.name}
          </p>
          <p className="mb-3 px-1 text-xs font-semibold text-slate-500">
            {friend.status === 'focusing'
              ? `Focusing${friend.taskTitle ? ` on ${friend.taskTitle}` : ''} · ${clockFromSeconds(friend.secondsLeft)} left`
              : friend.status === 'idle'
                ? 'Online, not focusing'
                : 'Offline'}
          </p>
          {sent ? (
            <p className="rounded-xl bg-mint-card px-3 py-2 text-sm font-bold text-mint-ink">Nudge sent 👍</p>
          ) : (
            <div className="space-y-1.5">
              {NUDGES.map((m) => (
                <button
                  key={m}
                  onClick={() => sendNudge(m)}
                  className="w-full rounded-xl bg-slate-100/80 px-3 py-2 text-left text-sm font-bold text-ink transition hover:bg-slate-200/80"
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
