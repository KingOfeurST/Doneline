# Spec: Focus Stats & Streaks

_Date: 2026-06-15_

## Problem
Focus sessions vanish after they end — there's no sense of progress. Stats &
streaks record focus time and reward consistency, turning focus mode into a habit
loop.

## Users
Each profile, on their own device. Stats are personal and sync via the workspace.

## Goals
- Log every completed focus block.
- Show today's sessions vs a daily target, minutes focused today/this week.
- A streak = consecutive days the daily target was met (today counts as in-progress,
  doesn't break the streak before midnight).
- A stats card on the Today screen + a progress line on the focus ending screen.
- Daily target (sessions/day) configurable in Settings.

## Out of Scope (v1)
- Per-goal/task time breakdown; charts/graphs; editing or deleting past sessions;
  a dedicated Stats tab.

## Data / schema
- New `focus_sessions` table: `id`, `person_id`, `task_id` (nullable),
  `duration_seconds`, `started_at`, `ended_at`, `created_at`. Synced via Turso.
- `prefs.json` (device-local): `dailyFocusTarget` (number, default 4).

## Architecture
- `core/focusStats.ts`:
  - `recordFocusSession({ personId, taskId, durationSeconds, startedAt, endedAt })`
    — inserts a row (ignored if duration < 60s).
  - `focusStats(personId)` → `{ todaySessions, todayMinutes, weekMinutes, target,
    targetMet, streak }`. Reads recent rows (last ~90 days), groups by **local**
    date in JS (avoids UTC/local mismatch), counts sessions/day, walks back from
    today for the streak.
- `core/prefs.ts`: `getDailyTarget()` / `setDailyTarget(n)`.
- IPC: `focus:record`, `focus:stats`, `focus:targetGet`, `focus:targetSet`
  (record pushes a `cloudSync`). Preload + shared API additions.
- `focus.tsx`: record a session when a focus block ends — natural transition,
  skip, or End — with `durationSeconds = focusMin*60 − secondsLeft` (guard ≥60).
- Renderer: `FocusStatsCard` on the Today view; a stats line on the ending screen;
  a target setter in Settings.

## User Flow
1. (Optional) set a daily target in Settings (default 4 sessions).
2. Complete focus blocks → each logs automatically.
3. Today screen shows "🔥 5 · 3/4 today · 120 min this week".
4. Ending screen shows the same progress under the motivational quote.

## Error Handling
- Recording failures are best-effort (never block the timer).
- No sessions yet → card shows "Start your first focus session" (streak 0).
- Stats are per active profile; in "Both" view, show the device's own (self) stats.

## Success Criteria
- Finishing a focus block increments today's count and minutes.
- Hitting the target N days running shows a streak of N.
- A missed day (below target) resets the streak.

## Open Questions
- Whether to show stats for the active profile vs always "self" in Both view
  (v1: self / primary).
