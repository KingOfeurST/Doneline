# Doneline

A calm desktop app for your tasks, goals, and calendar — for Mac and PC. Works
fully offline, or connect a free cloud workspace so you and a friend share the same
data across machines. Two-way syncs events with Apple Calendar (iCloud) and ships an
MCP server so Claude can read and add your tasks and events directly.

![status](https://img.shields.io/badge/status-v1%20working-2f7a4d)

## What it does

- **Today** — today's events and todos at a glance, check things off in one tap.
- **Todos with goals** — tasks with an optional goal, due date, and completion time.
- **Calendar** — month and week views, click any day to add an event.
- **Goals** — track goals (e.g. "Run a marathon") with progress bars from linked todos.
- **Profiles** — switch between people from the chip at the top right (e.g. you + a friend), or pick **Both** to see everyone's todos and calendars overlaid. Each profile has its own todos, goals, and calendar connection.
- **Shared cloud workspace** — connect a free Turso database and you + a friend share the same todos, goals, and events live across both your machines. Optional; off by default.
- **Apple Calendar sync** — two-way CalDAV sync with iCloud, per profile, works on Mac *and* PC.
- **Claude access** — an MCP server lets Claude list/add todos, goals, and events.

By default data lives locally in SQLite at `~/.doneline/`. Connecting a workspace
keeps a local replica that syncs with the shared cloud database.

## Tech

Electron + React + Vite + TypeScript + Tailwind, `libsql` for storage,
`tsdav` for CalDAV, `@modelcontextprotocol/sdk` for the MCP server.

## Setup

Requires Node 18+. Storage uses prebuilt N-API binaries, so no C++ toolchain or
native rebuild step is needed.

```bash
npm install        # installs deps
npm run dev        # launches the app with hot reload
```

Build a distributable:

```bash
npm run dist:win   # NSIS installer (Windows) → release/*.exe
npm run dist:mac   # DMG (macOS, must run on a Mac) → release/*.dmg
```

## Share with a friend (cloud workspace)

By default Doneline is offline and local. To let you and a friend see each other's
todos, goals, and events across two machines, connect a shared cloud database. It's
a free **Turso** (libSQL) database — the same engine the app already uses.

**1. Create the database (once, on your machine):**

Install the Turso CLI (<https://docs.turso.tech/cli/installation>), then:

```bash
turso auth signup                 # free account
turso db create doneline
turso db show doneline --url      # → libsql://doneline-<you>.turso.io
turso db tokens create doneline   # → a long auth token
```

**2. Connect in the app:** Doneline → **Settings → Shared workspace**. You can either
paste the URL + token, or build a single **connect code** (base64 of
`{"syncUrl":"libsql://…","authToken":"…"}`) and paste that. Hit **Connect workspace**.

**3. Share with her:** once connected, Settings shows a **connect code** with a Copy
button. Send it to your friend (any private channel). In her copy of Doneline she
pastes it into the same box → **Connect**. You're now on the same workspace and changes
sync both ways within a few seconds.

> **Is this safe / can anyone join?** No. The workspace is locked behind that auth
> token. Only someone you give the connect code to can join. The token is **not**
> baked into the app — each person enters their own. Treat the connect code like a
> password. If it leaks, run `turso db tokens invalidate doneline` and issue a new one.

Disconnect any time in Settings — your data stays on each machine.

## Connect Apple Calendar

1. Create an **app-specific password** at <https://account.apple.com> (Sign-In & Security
   → App-Specific Passwords). iCloud requires this; your normal password won't work.
2. Open Doneline → **Settings**.
3. Server stays `https://caldav.icloud.com`. Enter your Apple ID email and the
   app-specific password → **Test connection** → pick a calendar → **Save & sync**.

It syncs on launch and whenever you hit **Sync now**. New events you add in Doneline
are pushed up to that calendar.

> Todos, goals, and events sync between you and a friend through the **shared
> workspace** above. Apple Calendar sync is separate and per profile — each profile
> connects its own iCloud so "Both" overlays two real calendars.

## Give Claude access (MCP)

The MCP server reads the same local database the app uses. Storage is `libsql`
(N-API), so the same prebuilt binary works in both the app and a plain Node process —
no rebuilds, no Electron wrapper.

Build it once:

```bash
npm run build:mcp        # outputs out/mcp/server.cjs
```

Then add it to Claude Code (`~/.claude.json` or project `.mcp.json`) or Claude
Desktop (`claude_desktop_config.json`). Use an absolute path:

```json
{
  "mcpServers": {
    "doneline": {
      "command": "node",
      "args": ["C:\\path\\to\\Doneline\\out\\mcp\\server.cjs"]
    }
  }
}
```

(On macOS use the POSIX path, e.g. `/Users/you/Doneline/out/mcp/server.cjs`.)

Restart Claude. You'll get these tools:

| Tool | What it does |
| --- | --- |
| `list_today` | Today's todos + events in one snapshot |
| `list_todos` / `add_todo` / `update_todo` / `complete_todo` / `delete_todo` | Manage todos (`add_todo` supports `repeat` daily/weekly) |
| `list_archived_todos` | See completed/archived todos |
| `list_goals` / `add_goal` | Manage goals (`shared: true` = both people must complete its todos) |
| `list_events` / `add_event` | Manage events (multi-day via `ends_at`, plus `repeat`) |
| `list_people` / `add_person` | Manage profiles; pass a `person_id` to target one |
| `sync_calendar` | Two-way sync with iCloud |
| `run_maintenance` | Generate recurring instances + archive done todos |
| `nudge_friend` | Send a friend an OS-notification nudge |

When a workspace is connected, the MCP server pulls the latest shared data before
each read and pushes after each write, so Claude always sees current data.

Now you can say things like *"add a todo to call the landlord tomorrow at 10"* or
*"what's on my plate today?"* and Claude will read/write Doneline directly.

## Project layout

```
core/            shared data layer — used by app + MCP
  db.ts          schema, connection, cloud replica + sync
  config.ts      cloud workspace config + connect codes
  people.ts todos.ts goals.ts events.ts settings.ts
  caldav.ts ics.ts
src/main/        Electron main process + IPC handlers
src/preload/     contextBridge → window.doneline
src/renderer/    React UI (Today, Calendar, Goals, Settings)
src/shared/      IPC channel names + typed API surface
mcp/server.ts    MCP server for Claude
```

## Build installers for Mac + Windows (GitHub Actions)

You're on Windows, and a Mac `.dmg` can't be built on Windows. CI handles both.
Use a **private** repo — you still get free build minutes for occasional use and the
code stays hidden.

1. Create a private GitHub repo and push this project to it.
2. Go to the repo's **Actions** tab → **Build installers** → **Run workflow** (or push a
   tag like `v0.1.0`). It builds on a real Windows runner and a real macOS runner.
3. When it finishes, open the run and download the artifacts:
   `doneline-windows-latest` (the `.exe`) and `doneline-macos-latest` (the `.dmg`).
4. Send your friend the `.dmg`. She opens it and drags Doneline to Applications.

> **Gatekeeper note (macOS):** the app isn't code-signed (that needs a paid Apple
> Developer account). The first time she opens it, macOS may say it's from an
> unidentified developer. She right-clicks the app → **Open** → **Open**, just once.
> Proper signing/notarization is a later step.

The workflow lives in [.github/workflows/build.yml](.github/workflows/build.yml). The
macOS runner is Apple Silicon, so the `.dmg` targets Apple Silicon Macs (most recent
MacBooks). Intel-Mac builds can be added to the matrix later.

## Roadmap

- Code signing + notarization for a clean Mac install (paid Apple Developer account)
- Drag-to-reorder todos, recurring events
- Dark mode
- Notifications / reminders
