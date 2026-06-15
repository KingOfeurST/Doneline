# Spec: Focus / Study Mode

_Date: 2026-06-15_

## Problem
While working in Doneline, Chris wants a dedicated "focus" state: a Pomodoro-style
timer with relaxing music to settle into studying/working on a task, without leaving
the app.

## Users
Chris (and any profile) using Doneline on desktop while working.

## Goals
- One-tap focus button in the header.
- Pomodoro timer with focus/break cycles and a gentle chime at transitions.
- Relaxing lo-fi/ambient music (streamed), with play/pause, volume, channel choice.
- Optionally tie a session to one of your open todos; quick "mark done" after.
- Timer keeps running if the overlay is closed; header shows the live countdown.

## Out of Scope (v1)
- Long-break-every-N-cycles logic (just focus/break alternation).
- Session history / focus stats / streaks.
- User-supplied custom stream URLs; Spotify/Apple Music integration.
- Offline music (chosen source is streamed; chime is generated so it works offline).
- Any backend / core / MCP changes.

## Architecture
Renderer-only feature.
- `focus.tsx` — `FocusProvider` context + `useFocus()` hook. Owns timer state
  (phase, secondsLeft, isRunning, durations), the current task id, and the music
  state (channel, playing, volume) plus the single shared `<audio>` element. The
  `setInterval` lives here so the session persists while the overlay is closed.
- `components/FocusButton.tsx` — header button; shows "Focus" or the live `MM:SS`
  + phase tint when running. Toggles the overlay.
- `components/FocusOverlay.tsx` — full-screen calm overlay: timer ring, controls,
  task picker/display, music controls, SomaFM credit, close button.
- `lib/sound.ts` — Web Audio chime generator (no audio files) + the curated
  channel list (name + stream URL).
- `App.tsx` — wrap content in `FocusProvider` (inside `ProfileProvider`), add
  `FocusButton` to the header, render `FocusOverlay`.
- `index.html` — extend CSP with `media-src` / `connect-src` for the stream hosts.

## Data shapes
```ts
type Phase = 'focus' | 'break'
interface FocusState {
  phase: Phase
  secondsLeft: number
  isRunning: boolean
  focusMin: number      // default 25
  breakMin: number      // default 5
  taskId: string | null
  channelId: string     // index into the channel list
  playing: boolean
  volume: number        // 0..1
}
interface Channel { id: string; name: string; url: string }
```
Persisted to localStorage: focusMin, breakMin, channelId, volume.

## User Flow
1. Click **Focus** in the header → overlay opens.
2. (Optional) pick a todo to focus on from your open todos (active profile).
3. Pick a music channel, hit play, set volume.
4. Press **Start** → focus countdown runs. Header shows live time even if you
   close the overlay.
5. At 0:00 a soft chime plays and it switches to **Break** (and back). User can
   Pause / Reset / Skip at any time.
6. When the task is done, hit **Mark done** (calls existing `todos.toggle`).
7. Close overlay to return; session keeps running until paused/reset.

## Error Handling
- Stream fails / offline: audio element `onerror` → show "Couldn't reach the
  music stream — check your connection" and stop the spinner; timer is unaffected.
- No open todos: task picker shows "No open todos" and the session runs blank.
- Chime uses Web Audio; if blocked, it's silently skipped (never blocks the timer).

## Testing approach
- Typecheck + full `electron-vite build` pass.
- Manual: start a short focus (set 1 min) → confirm chime + auto-switch to break;
  play/pause/volume/channel work; closing overlay keeps the header counting;
  marking the focused todo done updates Today.

## Success Criteria
- Focus button starts a Pomodoro session with music in two clicks.
- Music plays/stops/changes channel and volume reliably when online.
- Timer survives closing the overlay; chime fires at transitions.

## Open Questions
- Final channel list (defaulting to SomaFM Groove Salad, Drone Zone, Lush, Fluid).
