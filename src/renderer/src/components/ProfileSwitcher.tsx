import { useEffect, useRef, useState } from 'react'
import { useProfile } from '../profile'

export default function ProfileSwitcher() {
  const { people, active, setActive, personById } = useProfile()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [])

  const current = active === 'all' ? null : personById(active)
  const label = active === 'all' ? 'Both' : current?.name ?? 'Profile'

  function choose(id: string) {
    setActive(id)
    setOpen(false)
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full bg-white/70 py-1.5 pl-2 pr-3 shadow-clay-sm backdrop-blur transition hover:bg-white"
      >
        {active === 'all' ? (
          <span className="flex -space-x-2">
            {people.slice(0, 3).map((p) => (
              <span
                key={p.id}
                className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-sm"
                style={{ background: p.color + '33' }}
              >
                {p.emoji}
              </span>
            ))}
          </span>
        ) : (
          <span
            className="flex h-7 w-7 items-center justify-center rounded-full text-sm"
            style={{ background: (current?.color ?? '#2f7a4d') + '33' }}
          >
            {current?.emoji ?? '🙂'}
          </span>
        )}
        <span className="text-sm font-bold text-ink">{label}</span>
        <svg viewBox="0 0 20 20" className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-2xl border border-white/70 bg-white/95 p-2 shadow-clay backdrop-blur">
          <button
            onClick={() => choose('all')}
            className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50 ${
              active === 'all' ? 'bg-mint-card/60' : ''
            }`}
          >
            <span className="flex -space-x-2">
              {people.slice(0, 3).map((p) => (
                <span
                  key={p.id}
                  className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-sm"
                  style={{ background: p.color + '33' }}
                >
                  {p.emoji}
                </span>
              ))}
            </span>
            <span className="font-bold text-ink">Both</span>
            <span className="ml-auto text-xs font-semibold text-slate-400">combined</span>
          </button>

          <div className="my-1 h-px bg-slate-100" />

          {people.map((p) => (
            <button
              key={p.id}
              onClick={() => choose(p.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50 ${
                active === p.id ? 'bg-mint-card/60' : ''
              }`}
            >
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full text-sm"
                style={{ background: p.color + '33' }}
              >
                {p.emoji}
              </span>
              <span className="font-bold text-ink">{p.name}</span>
              <span className="ml-auto h-3 w-3 rounded-full" style={{ background: p.color }} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
