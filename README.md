# Doneline

I built Doneline so my friend and I could keep our lives in one calm place and
actually get things done together instead of texting each other "did you do the
thing yet?". It's a little desktop app for our tasks, goals, and calendar. We can
see each other's stuff, share goals we both have to finish, and even sit down and
focus at the same time.

It runs on Mac and PC, works offline, and quietly syncs between our two computers
when we want it to. No accounts to manage, no subscription, no one else's servers
reading our todos.

## What it does for us

- **Today** is the home screen: everything happening today and everything left to
  do, so the first thing I see in the morning is just "here's the day."
- **Quick add** lets me type things the lazy way, like "gym tomorrow 9am", and it
  figures out the date on its own.
- **Goals** are the bigger things we're chasing (run a marathon, finish the
  semester). Todos hang off a goal and a little bar fills up as we go.
- **Shared goals** are the fun part: I can make a goal that *both* of us have to
  tick off, so neither of us can quietly skip leg day.
- **Calendar** holds our events: single days, multi-day trips, repeating stuff, and
  events we share so they show up for both of us. Click a day to see everything on
  it.
- **Profiles** let me flip between "me", "my friend", or **Both** at the top right,
  so I can peek at what's on her plate or see everything overlaid.
- **Focus mode** is for actually doing the work: a calm full-screen timer with
  drifting colors, lofi/rain in the background, a little countdown to ease in, and a
  nice quote when I'm done. We can even **focus together**, where we both start at
  the same moment and see each other's timer.
- **Streaks** keep me honest, counting the days I hit my focus goal.
- **Reminders** ping me about events and due todos so things stop slipping.
- **Claude** can do all of this for me too: I just ask, and it adds todos, makes
  events, checks things off, the works.

Everything lives on my own computer (in `~/.doneline/`). When my friend and I want
to share, we connect a tiny free cloud database and our two apps stay in sync.

## Running it from source

You only need Node 18+. There's no painful native build step.

```bash
npm install     # grab the dependencies
npm run dev     # open the app with live reload
```

To make an installer you can actually hand to someone:

```bash
npm run dist:win   # Windows installer  → release/*.exe
npm run dist:mac   # Mac app (build this on a Mac) → release/*.dmg
```

## Sharing it with my friend

Out of the box Doneline is just mine and lives on my machine. To share our todos,
goals, and events across both computers, we connect one small shared cloud database.
It's a free **Turso** database, the same engine the app already runs on.

**1. I create the database once, on my machine.** Easiest way is the Turso website
(turso.tech) since their CLI is fussy on Windows: sign up, create a database called
`doneline`, then grab two things from its page: the **database URL** (starts with
`libsql://`) and an **auth token**.

**2. I connect in the app.** Settings → **Shared workspace**, paste the URL and
token, hit **Connect**.

**3. I send her the connect code.** Once I'm connected, Settings shows a single
**connect code** with a Copy button. I send it to her privately, she pastes it into
the same box in her Doneline, and that's it. Whatever either of us changes shows up
for the other within a few seconds.

> **Can anyone just join our stuff?** No. It's locked behind that token, and the
> token isn't hidden inside the app, we each paste our own. So treat the connect
> code like a password and only send it to her. If it ever leaks, make a new token
> in Turso and the old one stops working.

We can disconnect any time in Settings and our data stays put on each machine.

### One thing to set: "This is me"

Because both of our profiles show up on both computers, each device needs to know
which one it is. The first time you connect, Doneline asks **"Which one is you?"**.
I pick me, she picks her. That's what makes presence, focusing together, and shared
todos know who's who. (You can change it later in Settings.)

## Hooking up Apple Calendar

If I want my real iCloud events in here:

1. Make an **app-specific password** at account.apple.com (Sign-In & Security →
   App-Specific Passwords). iCloud needs this, your normal password won't work.
2. Doneline → **Settings**, leave the server as `https://caldav.icloud.com`, enter
   your Apple ID email and that app-specific password, test it, pick a calendar,
   and save.

It syncs when the app opens and whenever I hit **Sync now**, and anything I add in
Doneline gets pushed up to that calendar. Each profile connects its own iCloud, so
"Both" really is two real calendars side by side. (Our shared Doneline events are a
separate, simpler thing that rides on the workspace above.)

## Letting Claude run it

Doneline ships a little MCP server so Claude can read and change my stuff directly.

Build it once:

```bash
npm run build:mcp     # creates out/mcp/server.cjs
```

Then point Claude Desktop at it (`claude_desktop_config.json`) with a full path:

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

(On a Mac use the normal path, like `/Users/you/Doneline/out/mcp/server.cjs`. If
Claude Desktop came from the Microsoft Store, the config lives in its sandboxed
folder, not the usual `%APPDATA%\Claude`.)

Restart Claude and it can use these:

| Tool | What it does |
| --- | --- |
| `list_today` | Everything for today in one go |
| `list_todos` / `add_todo` / `update_todo` / `complete_todo` / `delete_todo` | My todos (`add_todo` can repeat daily/weekly) |
| `list_archived_todos` | The things I've already finished |
| `list_goals` / `add_goal` | Goals (`shared: true` means we both have to finish them) |
| `list_events` / `add_event` | Events (multi-day and repeating too) |
| `list_people` / `add_person` | Profiles |
| `focus_stats` | My focus sessions, minutes, and streak |
| `sync_calendar` | Sync with iCloud |
| `run_maintenance` | Roll over recurring todos + tidy up finished ones |
| `nudge_friend` | Poke my friend with a little notification |

So I can just say "add a todo to call the landlord tomorrow at 10" or "what's on my
plate today?" and it happens.

## How it's put together

```
core/            the shared brain — used by the app and by Claude's MCP server
  db.ts          database, cloud replica + sync
  todos.ts goals.ts events.ts people.ts presence.ts focusStats.ts recurrence.ts
  caldav.ts      Apple Calendar sync
src/main/        the Electron app's backend (window, tray, notifications, updates)
src/preload/     the safe bridge to the UI
src/renderer/    the React app you actually see
mcp/server.ts    the server that lets Claude in
```

## Getting it onto both our computers

I'm on Windows and a Mac `.dmg` can't be built on Windows, so GitHub builds both for
us. Push the project to GitHub, then in the **Actions** tab run **Build installers**.
It builds on a real Windows machine and a real Mac and publishes them as a release,
which also means the app can **update itself** from then on (no more re-downloading
every time I change something).

> **Mac heads-up:** the app isn't signed with a paid Apple account yet, so the first
> time my friend opens it, macOS calls it "damaged" or "unidentified". The fix is to
> drag it to Applications and run this once in Terminal:
> `xattr -cr /Applications/Doneline.app`. After that it opens normally and updates
> itself quietly.

## What's next

- Proper Mac signing so there's no scary first-open warning
- Dark mode
- A few more focus-music channels
- Real-time sync of the friend's todo list straight from her machine (today shared
  events ride the workspace; this would make everything instant)

Made with love for two people who just wanted to stop dropping the ball. 💚
