# Doneline — Design & Engineering Context

Persistent context for all future work on Doneline. Read this first.

## What it is
Doneline is a local-first desktop app (Mac + PC) for tracking tasks, goals, and
calendar events in one calm view. It syncs events two-way with Apple Calendar
(iCloud via CalDAV) and exposes an MCP server so Claude can read and add
tasks/events directly.

## Design Context

### Users
- Primary user: Chris (solo indie dev, CS student, Paris). Power user, keyboard-fast,
  wants speed and zero friction.
- Light social: one or two friends may share a calendar so they can see each
  other's events. Not a multi-tenant social product.
- Context of use: opened many times a day on a laptop/desktop to answer
  "what do I need to do / what's happening today" and to check things off.
- Job to be done: see everything due and planned at a glance, capture tasks fast,
  feel on top of life without anxiety.

### Brand Personality
- Three words: **calm, friendly, capable.**
- Voice: warm and plain. Encouraging, never naggy. Celebrates done things.
- Emotional goal: a quiet sense of control. Opening the app should feel like a
  clean desk, not an inbox.

### Aesthetic Direction
- Soft pastel claymorphism. Light, airy gradient backgrounds (pale blue to mint),
  large rounded cards with soft shadows, generous whitespace.
- Friendly 3D-style avatars as accents. Playful but never childish or cluttered.
- Color-coded events (each calendar/event gets a soft tint: green, rose, etc.).
- Wordmark "Doneline" set in a relaxed italic/script, muted green.
- Light mode first. Dark mode is a later add.
- References: the two supplied mockups (Today view + Calendar view).
- Anti-references: dense productivity tools (Jira, classic Outlook), harsh
  high-contrast "hacker" dashboards, gamified streak-shaming.

### Design Principles
1. **Calm over dense.** Whitespace and soft color do the work. Never crowd.
2. **Glance-first.** The most important answer (today's tasks + events) is visible
   with zero clicks.
3. **Capture in one move.** Adding a task or event is always one tap away.
4. **Celebrate done.** Completing things should feel good and visible.
5. **Soft, rounded, tactile.** Rounded corners, soft shadows, pastel tints
   everywhere — consistent claymorphism.

## Engineering Context
- Stack: Electron + React + Vite + TypeScript + Tailwind.
- Data: local SQLite (better-sqlite3) at `~/.doneline/doneline.db`. No accounts.
- Calendar: two-way sync with iCloud via CalDAV (`tsdav`), app-specific password.
- Claude access: MCP server (`@modelcontextprotocol/sdk`) over the same SQLite DB.
- Shared events: handled by subscribing to a shared iCloud calendar, not a backend.
