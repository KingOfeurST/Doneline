# Spec: Co-focus & Friend Presence

_Date: 2026-06-15_

## Problem
Doneline is shared between two friends, but focusing is solo. Co-focus lets you
see when your friend is in a focus session and nudge them to join, so studying
feels social and motivating.

## Users
The two (or more) people sharing a cloud workspace, each on their own machine.

## Goals
- See a friend's live focus status (focusing/idle, current task, time left).
- A header presence chip + presence shown inside the focus overlay.
- Nudge a friend with a preset message → fires an OS notification on their side.

## The "this is me" identity
Both devices see all profiles. Each device stores `selfPersonId` locally
(prefs.json) so it knows which profile it represents. Set in Settings ("This is
me"); defaults to the primary profile. Friends = workspace people minus self.

## Out of Scope (v1)
- Lockstep / synchronized timers (each person runs their own).
- Co-focus history or stats.
- Nudging anyone outside the shared workspace; group rooms.

## Data / schema
- New `presence` table: `person_id` (PK), `status` ('focusing'|'idle'),
  `phase` ('focus'|'break'|null), `task_title` TEXT, `ends_at` TEXT,
  `updated_at` TEXT. Synced via Turso.
- New `nudges` table: `id`, `from_person`, `to_person`, `message`, `created_at`,
  `seen` INTEGER. Synced via Turso.

## Architecture
- `core/presence.ts`: `setPresence(personId, {...})`, `listPresence()`,
  `sendNudge(from,to,message)`, `unseenNudgesFor(personId)`, `markNudgeSeen(id)`.
- `core/prefs.ts`: add `selfPersonId` to local prefs.
- IPC: `presence:update`, `presence:list`, `presence:self/get|set`,
  `nudge:send`. Each write triggers an immediate `cloudSync()` push.
- Main process: after each background `cloudSync()`, check `unseenNudgesFor(self)`
  → fire notification, mark seen. (Reuses notifications.ts.)
- Renderer:
  - `focus.tsx` calls `presence:update` on start / pause / reset / phase change
    (status, phase, ends_at = now + secondsLeft, task title), and a ~20s heartbeat
    while focusing. On stop → status idle.
  - `usePresence` hook: polls `presence:list` on mount + on `workspace:changed` +
    a 5s local tick (to recompute time-left and staleness).
  - `PresenceChip` in the header; presence panel inside `FocusOverlay`.
  - Settings: "This is me" picker.

## User Flow
1. (Once) Each person sets "This is me" in Settings.
2. You start a focus session → your presence goes live; your friend's app shows
   "🧑 Focusing · <task> · mm:ss".
3. You click the chip → pick a preset → friend gets an OS notification.
4. When you end/stop, your presence flips to idle and disappears from their chip.

## Error Handling
- Local-only (no workspace) → presence/nudge features hidden (nothing to share).
- Stale presence (updated_at > 60s old) treated as idle/offline.
- Nudge send failures are swallowed (best-effort, never block the UI).

## Success Criteria
- With both apps open + same workspace, starting focus on one shows on the other
  within ~10s, with correct ticking time-left.
- A nudge produces exactly one OS notification on the recipient.
- Setting "This is me" correctly identifies self vs friend on each device.

## Open Questions
- Heartbeat cadence (20s) vs battery/sync volume — fine for 2 users.
