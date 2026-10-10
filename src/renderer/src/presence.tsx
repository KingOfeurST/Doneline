import { useEffect, useState } from 'react'
import { api } from './api'
import { useProfile } from './profile'
import type { Person, Presence } from '../../shared/api'

const STALE_MS = 120_000

export interface FriendPresence {
  person: Person
  status: 'focusing' | 'idle' | 'offline'
  taskTitle: string | null
  secondsLeft: number
}

/**
 * Live presence for everyone in the workspace except this device's own profile.
 * Re-fetches on background sync + a periodic poll; ticks every second so the
 * remaining time counts down smoothly (computed locally from `ends_at`).
 */
export function usePresence() {
  const { people, self } = useProfile()
  const [rows, setRows] = useState<Presence[]>([])
  const [, setNow] = useState(Date.now())

  useEffect(() => {
    let cancelled = false
    let request = 0
    const refresh = async () => {
      const current = ++request
      try {
        const next = await api.presence.list()
        if (!cancelled && current === request) setRows(next)
      } catch {}
    }
    void refresh()
    const off = api.workspace.onChanged(refresh)
    const poll = setInterval(refresh, 15_000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      cancelled = true
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [])

  const now = Date.now()
  const friends: FriendPresence[] = people
    .filter((p) => !!self && p.id !== self)
    .map((person) => {
      const row = rows.find((r) => r.person_id === person.id)
      const fresh = row && now - new Date(row.updated_at).getTime() < STALE_MS
      const end = row?.ends_at ? new Date(row.ends_at).getTime() : 0
      const focusing = fresh && row!.status === 'focusing' && Number.isFinite(end) && end > now
      const secondsLeft = focusing && row!.ends_at
        ? Math.max(0, Math.ceil((end - now) / 1000))
        : 0
      return {
        person,
        status: focusing ? 'focusing' : fresh ? 'idle' : 'offline',
        taskTitle: focusing ? row!.task_title : null,
        secondsLeft
      }
    })

  const nudge = (toPerson: string, message: string) => {
    return api.presence.nudge(toPerson, message)
  }

  return { self, friends, nudge }
}

export function clockFromSeconds(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
