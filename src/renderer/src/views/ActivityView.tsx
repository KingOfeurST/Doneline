import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ActivityEntry } from '../../../shared/api'
import { useProfile } from '../profile'

function humanize(entry: ActivityEntry): string {
  try {
    const p = JSON.parse(entry.payload)
    switch (entry.action) {
      case 'todo:created':
        return `added "${p.title}"`
      case 'todo:completed':
        return `finished "${p.title}"`
      case 'goal:created':
        return `created goal "${p.title}"`
      case 'reaction:added':
        return `reacted ${p.emoji} to "${p.title}"`
      default:
        return entry.action
    }
  } catch {
    return entry.action
  }
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffH = Math.floor(diffMin / 60)
  if (diffH < 24) return `${diffH}h ago`
  const diffD = Math.floor(diffH / 24)
  if (diffD === 1) return 'yesterday'
  return `${diffD} days ago`
}

export default function ActivityView() {
  const { tick } = useProfile()
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.activity.list(80).then((data) => {
      setEntries(data)
      setLoading(false)
    })
  }, [tick])

  return (
    <div className="space-y-5">
      <h1 className="text-3xl font-extrabold text-ink">Activity</h1>

      {loading ? (
        <div className="py-16 text-center text-slate-400 font-semibold">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="card py-16 text-center">
          <p className="text-3xl">📋</p>
          <p className="mt-3 font-bold text-slate-500">Nothing yet</p>
          <p className="text-sm font-semibold text-slate-400">
            Add todos, complete goals — it all shows up here.
          </p>
        </div>
      ) : (
        <div className="card divide-y divide-slate-100 p-0 overflow-hidden">
          {entries.map((entry, i) => (
            <div
              key={entry.id}
              className="rise flex items-start gap-4 px-6 py-4"
              style={{ animationDelay: `${i * 20}ms` }}
            >
              <span className="mt-0.5 text-2xl shrink-0">{entry.person_emoji ?? '🙂'}</span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-ink">
                  <span className="text-slate-500 font-semibold">{entry.person_name ?? 'Someone'} </span>
                  {humanize(entry)}
                </p>
                <p className="text-xs font-semibold text-slate-400 mt-0.5">
                  {relativeTime(entry.created_at)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
