import { useEffect, useState } from 'react'
import { api } from '../api'
import type { FocusStats } from '../../../shared/api'
import { useProfile } from '../profile'

interface PersonStats {
  personId: string
  name: string
  emoji: string
  stats: FocusStats
}

export default function FocusStatsCard() {
  const { people, self, tick } = useProfile()
  const [myStats, setMyStats] = useState<FocusStats | null>(null)
  const [allStats, setAllStats] = useState<PersonStats[]>([])
  const [sharedStreak, setSharedStreak] = useState(0)

  useEffect(() => {
    const load = async () => {
      const s = await api.focus.stats()
      setMyStats(s)

      if (people.length > 1) {
        const results = await Promise.all(
          people.map(async (p) => ({
            personId: p.id,
            name: p.name,
            emoji: p.emoji,
            stats: await api.focus.stats(p.id)
          }))
        )
        setAllStats(results)
        const ss = await api.focus.sharedStreak(people.map((p) => p.id))
        setSharedStreak(ss)
      }
    }
    load()
    window.addEventListener('doneline:stats', load)
    return () => window.removeEventListener('doneline:stats', load)
  }, [tick, people])

  if (!myStats) return null
  if (myStats.streak === 0 && myStats.todaySessions === 0 && myStats.weekMinutes === 0) return null

  const pct = Math.min(100, Math.round((myStats.todaySessions / myStats.target) * 100))
  const showFaceoff = allStats.length > 1
  const maxWeekSessions = showFaceoff ? Math.max(...allStats.map((s) => s.stats.weekSessions), 1) : 1

  return (
    <div className="space-y-3">
      <div className="card flex items-center gap-5 p-5">
        <div className="flex items-center gap-2">
          <span className="text-3xl">🔥</span>
          <div>
            <p className="text-2xl font-extrabold leading-none text-ink">{myStats.streak}</p>
            <p className="text-xs font-bold text-slate-400">day streak</p>
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex justify-between text-xs font-bold text-slate-400">
            <span>{myStats.todaySessions}/{myStats.target} sessions today</span>
            <span>{myStats.weekMinutes} min this week</span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className="h-full rounded-full bg-mint-ink transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {myStats.targetMet && (
          <span className="rounded-full bg-mint-card px-3 py-1 text-xs font-bold text-mint-ink">
            Goal met ✅
          </span>
        )}
      </div>

      {showFaceoff && (
        <div className="card p-5">
          <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">This week</p>
          <div className="space-y-3">
            {allStats.map((ps) => {
              const barPct = Math.round((ps.stats.weekSessions / maxWeekSessions) * 100)
              const isMe = ps.personId === self
              return (
                <div key={ps.personId} className="flex items-center gap-3">
                  <span className="w-6 shrink-0 text-center text-lg">{ps.emoji}</span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center justify-between text-xs font-bold">
                      <span className={isMe ? 'text-mint-ink' : 'text-slate-500'}>
                        {isMe ? 'You' : ps.name}
                      </span>
                      <span className="text-slate-400">{ps.stats.weekSessions} sessions</span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                      <div
                        className={`h-full rounded-full transition-all ${isMe ? 'bg-mint-ink' : 'bg-slate-300'}`}
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {sharedStreak > 0 && (
            <div className="mt-4 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2">
              <span className="text-xl">🤝</span>
              <div>
                <p className="text-sm font-extrabold text-amber-700">
                  {sharedStreak} day together streak
                </p>
                <p className="text-xs font-semibold text-amber-500">Both focused every day</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
