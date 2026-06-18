import { useEffect, useState } from 'react'
import { api } from '../api'
import type { FocusStats } from '../../../shared/api'
import { useProfile } from '../profile'

/** Compact focus streak / today-progress card for the Today screen. */
export default function FocusStatsCard() {
  const { tick } = useProfile()
  const [stats, setStats] = useState<FocusStats | null>(null)

  useEffect(() => {
    const load = () => api.focus.stats().then(setStats)
    load()
    // Refresh right after a focus session is recorded (not just on cloud sync).
    window.addEventListener('doneline:stats', load)
    return () => window.removeEventListener('doneline:stats', load)
  }, [tick])

  if (!stats) return null
  // Hide until there's something to show (no sessions ever + no streak).
  if (stats.streak === 0 && stats.todaySessions === 0 && stats.weekMinutes === 0) return null

  const pct = Math.min(100, Math.round((stats.todaySessions / stats.target) * 100))

  return (
    <div className="card flex items-center gap-5 p-5">
      <div className="flex items-center gap-2">
        <span className="text-3xl">🔥</span>
        <div>
          <p className="text-2xl font-extrabold leading-none text-ink">{stats.streak}</p>
          <p className="text-xs font-bold text-slate-400">day streak</p>
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex justify-between text-xs font-bold text-slate-400">
          <span>{stats.todaySessions}/{stats.target} focus sessions today</span>
          <span>{stats.weekMinutes} min this week</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-mint-ink transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {stats.targetMet && (
        <span className="rounded-full bg-mint-card px-3 py-1 text-xs font-bold text-mint-ink">Goal met ✅</span>
      )}
    </div>
  )
}
