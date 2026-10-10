import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from './api'
import type { Person } from '../../shared/api'

interface ProfileCtx {
  people: Person[]
  reloadPeople: () => Promise<void>
  /** Currently selected view: a person id, or 'all' for the combined "Both" view. */
  active: string
  setActive: (id: string) => void
  /** personId to pass to queries — undefined means "everyone". */
  queryPersonId: string | undefined
  /** Owner to assign to newly created items. */
  defaultOwnerId: string | undefined
  /** Look up a person by id. */
  personById: (id: string | null | undefined) => Person | undefined
  /** This device's own profile id (for mutual todos / presence). */
  self: string
  /** Increments whenever a background cloud sync brings in new data. Views can
   *  depend on it to refresh. */
  tick: number
}

const Ctx = createContext<ProfileCtx | null>(null)

const STORAGE_KEY = 'doneline.activeProfile'

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [people, setPeople] = useState<Person[]>([])
  const [active, setActiveState] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) || 'all'
  )
  const [tick, setTick] = useState(0)
  const [self, setSelf] = useState('')
  const loadedPeople = useRef(false)
  const requestId = useRef(0)
  const identityRequest = useRef(0)

  const reloadPeople = useCallback(async () => {
    const request = ++requestId.current
    const list = await api.people.list()
    if (request !== requestId.current) return
    loadedPeople.current = true
    setPeople(list)
  }, [])
  const reloadSelf = useCallback(async () => {
    const request = ++identityRequest.current
    try {
      const id = await api.presence.getSelf()
      if (request === identityRequest.current) setSelf(id)
    } catch {
      if (request === identityRequest.current) setSelf('')
    }
  }, [])

  useEffect(() => {
    void reloadPeople().catch(() => {})
    void reloadSelf()
    window.addEventListener('doneline:identity', reloadSelf)
    return () => {
      window.removeEventListener('doneline:identity', reloadSelf)
      requestId.current++
      identityRequest.current++
    }
  }, [reloadPeople, reloadSelf])

  // A background cloud sync may have brought in new data — refresh everything.
  useEffect(() => {
    const off = api.workspace.onChanged(() => {
      void reloadPeople().catch(() => {})
      void reloadSelf()
      setTick((t) => t + 1)
    })
    return off
  }, [reloadPeople, reloadSelf])

  const setActive = useCallback((id: string) => {
    setActiveState(id)
    localStorage.setItem(STORAGE_KEY, id)
  }, [])

  // If the active person was deleted, fall back to the combined view.
  useEffect(() => {
    if (active !== 'all' && loadedPeople.current && !people.some((p) => p.id === active)) {
      setActive('all')
    }
  }, [people, active, setActive])

  const queryPersonId = active === 'all' ? undefined : active
  const defaultOwnerId = active === 'all' ? self || people[0]?.id : active
  const personById = (id: string | null | undefined) => people.find((p) => p.id === id)

  return (
    <Ctx.Provider
      value={{ people, reloadPeople, active, setActive, queryPersonId, defaultOwnerId, personById, self, tick }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useProfile(): ProfileCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useProfile must be used inside ProfileProvider')
  return ctx
}
