import { useEffect, useState } from 'react'
import { api } from '../api'
import type { Person } from '../../../shared/api'

/**
 * One-time "Who are you on this device?" prompt. Shows only when a cloud workspace
 * is connected, there's more than one profile, and the user hasn't picked their
 * identity yet — which is required for presence and co-focus to work.
 */
export default function SelfSetupBanner() {
  const [need, setNeed] = useState(false)
  const [people, setPeople] = useState<Person[]>([])

  useEffect(() => {
    ;(async () => {
      const status = await api.workspace.status()
      if (!status.cloud) return
      const raw = await api.presence.getSelfRaw()
      if (raw) return
      const list = await api.people.list()
      if (list.length > 1) {
        setPeople(list)
        setNeed(true)
      }
    })()
  }, [])

  if (!need) return null

  async function pick(id: string) {
    await api.presence.setSelf(id)
    setNeed(false)
  }

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/30 p-4 backdrop-blur-sm">
      <div className="card w-full max-w-md p-7 text-center">
        <p className="text-4xl">👋</p>
        <h2 className="mt-2 text-2xl font-extrabold text-ink">Which one is you?</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          Pick your profile on this device. It's how presence and focusing together know who's
          who. Your friend picks theirs on their own machine.
        </p>
        <div className="mt-5 space-y-2">
          {people.map((p) => (
            <button
              key={p.id}
              onClick={() => pick(p.id)}
              className="flex w-full items-center gap-3 rounded-2xl bg-slate-50/80 p-3 text-left font-bold text-ink transition hover:bg-mint-card/60"
            >
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full text-lg"
                style={{ background: p.color + '22' }}
              >
                {p.emoji}
              </span>
              I'm {p.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
