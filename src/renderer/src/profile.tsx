import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
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

  const reloadPeople = useCallback(async () => {
    setPeople(await api.people.list())
  }, [])

  useEffect(() => {
    reloadPeople()
  }, [reloadPeople])

  // A background cloud sync may have brought in new data — refresh everything.
  useEffect(() => {
    const off = api.workspace.onChanged(() => {
      reloadPeople()
      setTick((t) => t + 1)
    })
    return off
  }, [reloadPeople])

  const setActive = useCallback((id: string) => {
    setActiveState(id)
    localStorage.setItem(STORAGE_KEY, id)
  }, [])

  // If the active person was deleted, fall back to the combined view.
  useEffect(() => {
    if (active !== 'all' && people.length && !people.some((p) => p.id === active)) {
      setActive('all')
    }
  }, [people, active, setActive])

  const queryPersonId = active === 'all' ? undefined : active
  const defaultOwnerId = active === 'all' ? people[0]?.id : active
  const personById = (id: string | null | undefined) => people.find((p) => p.id === id)

  return (
    <Ctx.Provider
      value={{ people, reloadPeople, active, setActive, queryPersonId, defaultOwnerId, personById, tick }}
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
