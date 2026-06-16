import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { useProfile } from './profile'
import type { Person, Presence } from '../../shared/api'

const STALE_MS = 60_000

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
  const { people } = useProfile()
  const [self, setSelf] = useState<string>('')
  const [rows, setRows] = useState<Presence[]>([])
  const [, setNow] = useState(Date.now())

  const refresh = useCallback(async () => {
    setRows(await api.presence.list())
  }, [])

  useEffect(() => {
    api.presence.getSelf().then(setSelf)
    refresh()
    const off = api.workspace.onChanged(refresh)
    const poll = setInterval(refresh, 15_000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      off()
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [refresh])

  const now = Date.now()
  const friends: FriendPresence[] = people
    .filter((p) => p.id !== self)
    .map((person) => {
      const row = rows.find((r) => r.person_id === person.id)
      const fresh = row && now - new Date(row.updated_at).getTime() < STALE_MS
      const focusing = fresh && row!.status === 'focusing'
      const secondsLeft = focusing && row!.ends_at
        ? Math.max(0, Math.round((new Date(row!.ends_at).getTime() - now) / 1000))
        : 0
      return {
        person,
        status: focusing ? 'focusing' : fresh ? 'idle' : 'offline',
        taskTitle: focusing ? row!.task_title : null,
        secondsLeft
      }
    })

  const nudge = useCallback((toPerson: string, message: string) => {
    return api.presence.nudge(toPerson, message)
  }, [])

  return { self, friends, nudge }
}

export function clockFromSeconds(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
