import { Notification, type BrowserWindow } from 'electron'
import {
  getNotifPrefs,
  getSelfPersonId,
  primaryPersonId,
  unseenNudgesFor,
  markNudgeSeen,
  pendingInvitesFor,
  listEvents,
  listDayEvents,
  listTodos,
  listPeople,
  localDay
} from '../../core/index.js'

let timer: NodeJS.Timeout | null = null
let getWindow: () => BrowserWindow | null = () => null

const notifiedEvents = new Set<string>()
const notifiedTodos = new Set<string>()
const notifiedInvites = new Set<string>()
let morningSentDay = ''
let appStart = Date.now()

function show(title: string, body: string): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, silent: false })
  n.on('click', () => {
    const w = getWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
  n.show()
}

function tick(): void {
  try {
    const prefs = getNotifPrefs()
    if (!prefs.enabled) return

    const people = listPeople()
    const multi = people.length > 1
    const pmap = new Map(people.map((p) => [p.id, p]))
    const tag = (pid: string) => {
      if (!multi) return ''
      const p = pmap.get(pid)
      return p ? `${p.emoji} ${p.name} · ` : ''
    }

    const now = Date.now()

    // --- events starting soon ---
    if (prefs.eventsEnabled) {
      const leadMs = prefs.eventLeadMin * 60_000
      const evs = listEvents({
        from: new Date(now).toISOString(),
        to: new Date(now + leadMs + 60_000).toISOString()
      })
      for (const e of evs) {
        if (e.all_day) continue
        const start = new Date(e.starts_at).getTime()
        if (start > now && start <= now + leadMs && !notifiedEvents.has(e.id)) {
          notifiedEvents.add(e.id)
          const mins = Math.max(1, Math.round((start - now) / 60_000))
          show('Upcoming event', `${tag(e.person_id)}${e.title} in ${mins} min`)
        }
      }
    }

    // --- todos coming due (only ones that fall due while the app is running) ---
    if (prefs.todosEnabled) {
      for (const t of listTodos({ includeCompleted: false })) {
        if (!t.due_at) continue
        const due = new Date(t.due_at).getTime()
        if (due <= now && due >= appStart && !notifiedTodos.has(t.id)) {
          notifiedTodos.add(t.id)
          show('Todo due', `${tag(t.person_id)}${t.title}`)
        }
      }
    }

    // --- daily morning summary ---
    if (prefs.morningEnabled) {
      const d = new Date()
      const today = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
      const [hh, mm] = prefs.morningTime.split(':').map(Number)
      const minutesSince = d.getHours() * 60 + d.getMinutes() - (hh * 60 + mm)
      // Fire within a 2h window after the chosen time so opening the app at night
      // doesn't trigger a "good morning".
      if (minutesSince >= 0 && minutesSince <= 120 && morningSentDay !== today) {
        morningSentDay = today
        const day = localDay()
        const events = listDayEvents(day).length
        const dueToday = listTodos({ includeCompleted: false }).filter(
          (t) => t.due_at && new Date(t.due_at).toDateString() === d.toDateString()
        ).length
        show('Good morning ☀️', `${events} event(s) today · ${dueToday} todo(s) due`)
      }
    }
  } catch (err) {
    console.error('[doneline] notification tick failed:', err)
  }
}

export function startNotifications(getWin: () => BrowserWindow | null): void {
  getWindow = getWin
  appStart = Date.now()
  morningSentDay = ''
  notifiedEvents.clear()
  notifiedTodos.clear()
  if (timer) clearInterval(timer)
  tick()
  timer = setInterval(tick, 30_000)
}

/** Re-evaluate immediately after a settings change (prefs are read each tick). */
export function reloadNotifications(): void {
  tick()
}

export function stopNotifications(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export function testNotification(): void {
  show('Doneline', 'Notifications are working 🎉')
}

/** Notify (once) for nudges a friend sent to this device's profile. */
export function notifyIncomingNudges(getWin: () => BrowserWindow | null): void {
  try {
    const self = getSelfPersonId() ?? primaryPersonId()
    const nudges = unseenNudgesFor(self)
    if (nudges.length === 0) return
    getWindow = getWin
    const people = new Map(listPeople().map((p) => [p.id, p]))
    for (const n of nudges) {
      const from = people.get(n.from_person)
      show(`${from?.emoji ?? '👋'} ${from?.name ?? 'A friend'} nudged you`, n.message)
      markNudgeSeen(n.id)
    }
  } catch (err) {
    console.error('[doneline] nudge check failed:', err)
  }
}

/** Notify (once) for focus-together invites — leaves them unseen so the in-app
 *  "Join?" prompt still shows until accepted/dismissed. */
export function notifyIncomingInvites(getWin: () => BrowserWindow | null): void {
  try {
    const self = getSelfPersonId() ?? primaryPersonId()
    const invites = pendingInvitesFor(self)
    if (invites.length === 0) return
    getWindow = getWin
    const people = new Map(listPeople().map((p) => [p.id, p]))
    for (const inv of invites) {
      if (notifiedInvites.has(inv.id)) continue
      notifiedInvites.add(inv.id)
      const from = people.get(inv.from_person)
      show(
        `${from?.emoji ?? '👋'} ${from?.name ?? 'A friend'} wants to focus together`,
        `Tap Doneline to join a ${inv.focus_min}-min session`
      )
    }
  } catch (err) {
    console.error('[doneline] invite check failed:', err)
  }
}
