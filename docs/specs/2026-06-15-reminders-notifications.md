# Spec: Reminders & Notifications

_Date: 2026-06-15_

## Problem
Doneline only helps when it's open — nothing pings you. Reminders make it useful in
the background: you get nudged about due todos, upcoming events, and a morning
overview, so things stop slipping.

## Users
Chris (and any profile) on desktop. Foundation also reused later by co-focus nudges.

## Goals
- OS notifications for: an event starting soon, a todo coming due, and a daily
  morning summary.
- A Notifications settings panel: master toggle, per-type toggles, event lead time,
  morning time, and a "Send test notification" button.
- Clicking a notification focuses the Doneline window.

## Out of Scope (v1)
- Focus phase OS notifications (in-app chime already covers it).
- Quiet hours, snooze, recurring-reminder rules.
- Deep-linking to the exact item (just focuses the app).
- Per-profile notification filtering (v1 covers all profiles on the device).

## Architecture
- `core/prefs.ts` — device-local prefs in `~/.doneline/prefs.json` (NOT synced):
  `{ enabled, eventsEnabled, eventLeadMin, todosEnabled, morningEnabled, morningTime }`.
  Defaults: enabled true, eventLeadMin 10, morningTime "08:00", all types on.
- `src/main/notifications.ts` — scheduler in the main process. `start()` runs a
  ~30s interval that reads prefs and the DB (via core `listEvents` / `listTodos`)
  and fires `new Notification(...)`. Tracks already-notified ids + the date the
  morning summary was sent, in memory. `reload()` re-reads prefs after a settings
  change; `stop()` clears the timer. On click, shows + focuses the main window.
- IPC: `notif:get`, `notif:set`, `notif:test`. Preload exposes `window.doneline.notifications`.
- `src/renderer/.../views/SettingsView.tsx` — a Notifications section.
- `src/main/index.ts` — start the scheduler after `initDb()` + window creation;
  stop on quit.

## Firing rules
- **Event soon**: each tick, events whose start is within `(now, now + leadMin]`,
  not all-day, not already notified → notify once. Body: "<title> in N min" (+ person
  name prefix when >1 profile).
- **Todo due**: todos with `due_at <= now`, not completed, `due_at >= appStartTime`,
  not already notified → notify. Avoids spamming items already overdue at launch.
- **Morning summary**: if `morningEnabled` and local time >= `morningTime` and not yet
  sent today → notify "Good morning · X events, Y todos due today". Mark date sent.

## Data shapes
```ts
interface NotifPrefs {
  enabled: boolean
  eventsEnabled: boolean
  eventLeadMin: number
  todosEnabled: boolean
  morningEnabled: boolean
  morningTime: string // "HH:MM"
}
```
No database schema change — reads existing events/todos.

## User Flow
1. Settings → Notifications → toggle types, set lead time + morning time, optionally
   hit "Send test notification" to confirm the OS shows them.
2. In normal use, notifications appear at the right moments; clicking one brings
   Doneline to the front.

## Error Handling
- If the OS blocks notifications (e.g. macOS not yet allowed), the test button still
  calls `.show()`; nothing crashes. README notes enabling notifications on macOS.
- Scheduler never throws into the app: each tick is wrapped in try/catch.

## Testing approach
- Manual: set a todo due in ~1 min and an event ~11 min out → confirm both fire;
  "Send test notification" shows immediately; clicking focuses the window.
- Typecheck + full build pass.

## Success Criteria
- Due todos and upcoming events notify without the window focused.
- Settings changes take effect without a restart (`reload()`).
- No duplicate notifications for the same item in one app run.

## Open Questions
- Should notifications later be limited to the active/primary profile? (v1: all
  profiles, name-prefixed when more than one.)
