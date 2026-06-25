import { useEffect, useState } from 'react'
import { api } from '../api'
import type { CalendarInfo, SafeCalDavConfig, Person, WorkspaceStatus, NotifPrefs, TodoWithGoal } from '../../../shared/api'
import { useProfile } from '../profile'
import { PALETTE } from '../lib/colors'
import { isMuted, setMuted, playDing } from '../lib/audioFx'

const DEFAULT_SERVER = 'https://caldav.icloud.com'
const EMOJIS = ['🙂', '🧑', '👩', '👨', '🐱', '🐶', '🌟', '🦊', '🐻', '🦄']

export default function SettingsView() {
  const { people, reloadPeople, active } = useProfile()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-3xl font-extrabold text-ink">Settings</h1>
      <WorkspaceSection />
      <NotificationsSection />
      <FocusTargetSection />
      <SoundsSection />
      <PeopleSection people={people} reload={reloadPeople} />
      <IdentitySection people={people} />
      <CalendarSection people={people} initialPerson={active === 'all' ? people[0]?.id : active} />
      <ArchiveSection />
      <UpdatesSection />
      <ClaudeSection />
    </div>
  )
}

/* ------------------------------- Updates ------------------------------ */

function UpdatesSection() {
  const [version, setVersion] = useState('')
  const [msg, setMsg] = useState('')
  const [downloaded, setDownloaded] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.updates.version().then(setVersion)
    return api.updates.onStatus((s) => {
      setBusy(s.state === 'checking' || s.state === 'downloading')
      if (s.state === 'checking') setMsg('Checking…')
      else if (s.state === 'available') setMsg(`Update ${s.version ?? ''} found — downloading…`)
      else if (s.state === 'downloading') setMsg(`Downloading… ${s.percent ?? 0}%`)
      else if (s.state === 'downloaded') {
        setMsg(`Update ${s.version ?? ''} ready.`)
        setDownloaded(true)
      } else if (s.state === 'not-available') setMsg("You're on the latest version 🎉")
      else if (s.state === 'error') setMsg(`Couldn't check: ${s.message ?? 'unknown error'}`)
    })
  }, [])

  async function check() {
    setBusy(true)
    setMsg('Checking…')
    const r = await api.updates.check()
    if (r.state === 'dev') {
      setBusy(false)
      setMsg('Updates only work in the installed app, not in dev mode.')
    } else if (r.state === 'error') {
      setBusy(false)
      setMsg(`Couldn't check: ${r.message ?? 'unknown error'}`)
    }
    // For 'checking': the result arrives via onStatus (electron-updater event), which resets busy
  }

  return (
    <section className="card space-y-3 p-7">
      <div>
        <h2 className="text-xl font-extrabold text-ink">Updates</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          Doneline updates itself automatically, but you can check right now.
          {version ? ` You're on v${version}.` : ''}
        </p>
      </div>

      {msg && (
        <p className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-bold text-slate-600">{msg}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <button className="btn-soft" onClick={check} disabled={busy}>
          Check for updates
        </button>
        {downloaded && (
          <button className="btn-primary" onClick={() => api.updates.install()}>
            Restart &amp; update
          </button>
        )}
      </div>
    </section>
  )
}

/* ------------------------------ Identity ------------------------------ */

function IdentitySection({ people }: { people: Person[] }) {
  const [self, setSelf] = useState('')

  useEffect(() => {
    api.presence.getSelf().then(setSelf)
  }, [])

  function choose(id: string) {
    setSelf(id)
    api.presence.setSelf(id)
  }

  return (
    <section className="card p-7">
      <h2 className="text-xl font-extrabold text-ink">This is me</h2>
      <p className="mb-3 mt-1 text-sm font-semibold text-slate-500">
        Which profile are you on this device? Used for co-focus presence and nudges — your
        friend sets theirs on their own machine.
      </p>
      <select className="input" value={self} onChange={(e) => choose(e.target.value)}>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.emoji} {p.name}
          </option>
        ))}
      </select>
    </section>
  )
}

/* ---------------------------- Focus target ---------------------------- */

function FocusTargetSection() {
  const [target, setTarget] = useState(4)

  useEffect(() => {
    api.focus.getTarget().then(setTarget)
  }, [])

  function update(n: number) {
    const v = Math.min(20, Math.max(1, n))
    setTarget(v)
    api.focus.setTarget(v)
  }

  return (
    <section className="card p-7">
      <h2 className="text-xl font-extrabold text-ink">Daily focus goal</h2>
      <p className="mb-3 mt-1 text-sm font-semibold text-slate-500">
        How many focus sessions you aim for each day. Hitting it keeps your 🔥 streak alive.
      </p>
      <div className="flex items-center gap-2">
        <button className="btn-soft px-3 py-2" onClick={() => update(target - 1)} aria-label="Fewer">
          −
        </button>
        <input
          type="number"
          min={1}
          max={20}
          value={target}
          onChange={(e) => update(Number(e.target.value))}
          className="input w-16 text-center"
        />
        <button className="btn-soft px-3 py-2" onClick={() => update(target + 1)} aria-label="More">
          +
        </button>
        <span className="ml-1 text-sm font-bold text-slate-500">sessions / day</span>
      </div>
    </section>
  )
}

/* ------------------------------- Sounds ------------------------------- */

function SoundsSection() {
  const [on, setOn] = useState(!isMuted())

  function toggle(v: boolean) {
    setOn(v)
    setMuted(!v)
    if (v) playDing() // little preview
  }

  return (
    <section className="card p-7">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-extrabold text-ink">Sounds</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Check-off dings, focus chimes, last-5-second ticks, and subtle clicks.
          </p>
        </div>
        <Toggle checked={on} onChange={toggle} />
      </div>
    </section>
  )
}

/* ------------------------------ Archive ------------------------------- */

function ArchiveSection() {
  const [items, setItems] = useState<TodoWithGoal[]>([])
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (open) api.todos.archived().then(setItems)
  }, [open])

  return (
    <section className="card space-y-3 p-7">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <div className="text-left">
          <h2 className="text-xl font-extrabold text-ink">Archive</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Completed todos move here at midnight and are kept for 14 days, then removed.
          </p>
        </div>
        <span className="text-slate-400">{open ? '▲' : '▼'}</span>
      </button>

      {open &&
        (items.length === 0 ? (
          <p className="py-4 text-center text-sm font-semibold text-slate-400">Nothing archived yet.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {items.map((t) => (
              <div key={t.id} className="flex items-center justify-between py-2.5">
                <span className="truncate font-bold text-slate-500 line-through">
                  {t.person_emoji ? `${t.person_emoji} ` : ''}
                  {t.title}
                </span>
                <span className="ml-3 shrink-0 text-xs font-semibold text-slate-400">
                  {t.completed_at ? new Date(t.completed_at).toLocaleDateString() : ''}
                </span>
              </div>
            ))}
          </div>
        ))}
    </section>
  )
}

/* ----------------------------- Workspace ------------------------------ */

function WorkspaceSection() {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null)
  const [url, setUrl] = useState('') // Turso database URL (libsql://…)
  const [token, setToken] = useState('') // Turso auth token
  const [code, setCode] = useState('') // OR a ready-made connect code from a friend
  const [myCode, setMyCode] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setStatus(await api.workspace.status())
    setMyCode(await api.workspace.myCode())
  }
  useEffect(() => {
    refresh()
  }, [])

  const canConnect = (url.trim() && token.trim()) || code.trim()

  async function connect() {
    if (!canConnect) return
    setBusy(true)
    setMsg({ kind: 'info', text: 'Connecting & syncing…' })
    try {
      // Prefer the URL + token fields; fall back to a friend's connect code.
      const input =
        url.trim() && token.trim()
          ? { syncUrl: url.trim(), authToken: token.trim() }
          : { code: code.trim() }
      await api.workspace.connect(input)
      // Full refresh so every view reloads from the shared workspace.
      window.location.reload()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Could not connect.' })
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    try {
      await api.workspace.disconnect()
      window.location.reload()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Failed.' })
      setBusy(false)
    }
  }

  async function syncNow() {
    setBusy(true)
    setMsg({ kind: 'info', text: 'Syncing…' })
    try {
      await api.workspace.sync()
      setMsg({ kind: 'ok', text: 'Synced.' })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Sync failed.' })
    } finally {
      setBusy(false)
    }
  }

  function copyCode() {
    if (!myCode) return
    navigator.clipboard.writeText(myCode)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const connected = status?.cloud

  return (
    <section className="card space-y-4 p-7">
      <div>
        <h2 className="text-xl font-extrabold text-ink">Shared workspace (sync)</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          Connect a cloud workspace so your devices — and a friend's — share the same todos,
          goals, and events. See the README to create a free Turso database and get a connect code.
        </p>
      </div>

      {connected ? (
        <>
          <p className="inline-block rounded-full bg-mint-card px-3 py-1 text-sm font-bold text-mint-ink">
            Connected & syncing
          </p>
          <div>
            <p className="mb-1 text-sm font-bold text-slate-500">
              Connect code (share this with your friend so she joins the same workspace):
            </p>
            <div className="flex gap-2">
              <input className="input font-mono text-xs" readOnly value={myCode ?? ''} onFocus={(e) => e.target.select()} />
              <button className="btn-soft" onClick={copyCode}>
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="btn-soft" onClick={syncNow} disabled={busy}>
              Sync now
            </button>
            <button className="btn-soft text-rose-ink" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-2">
            <p className="text-sm font-bold text-slate-500">
              Setting it up yourself? Paste your Turso database URL and token:
            </p>
            <input
              className="input font-mono text-xs"
              placeholder="libsql://your-db-name.turso.io"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <input
              className="input font-mono text-xs"
              type="password"
              placeholder="Auth token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-3 text-xs font-bold uppercase text-slate-400">
            <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
          </div>

          <textarea
            className="input font-mono text-xs"
            rows={2}
            placeholder="Paste a connect code from a friend"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />

          <button className="btn-primary" onClick={connect} disabled={busy || !canConnect}>
            Connect workspace
          </button>
        </>
      )}

      {msg && (
        <p
          className={`rounded-2xl px-4 py-3 text-sm font-bold ${
            msg.kind === 'ok'
              ? 'bg-mint-card text-mint-ink'
              : msg.kind === 'err'
                ? 'bg-rose-card text-rose-ink'
                : 'bg-slate-100 text-slate-500'
          }`}
        >
          {msg.text}
        </p>
      )}
    </section>
  )
}

/* --------------------------- Notifications ---------------------------- */

function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotifPrefs | null>(null)
  const [tested, setTested] = useState(false)

  useEffect(() => {
    api.notifications.get().then(setPrefs)
  }, [])

  function update(patch: Partial<NotifPrefs>) {
    setPrefs((cur) => {
      if (!cur) return cur
      const next = { ...cur, ...patch }
      api.notifications.set(next)
      return next
    })
  }

  async function test() {
    await api.notifications.test()
    setTested(true)
    setTimeout(() => setTested(false), 2000)
  }

  if (!prefs) return null

  return (
    <section className="card space-y-4 p-7">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-extrabold text-ink">Notifications</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Reminders for due todos, upcoming events, and a morning summary. Saved on this
            device only.
          </p>
        </div>
        <Toggle checked={prefs.enabled} onChange={(v) => update({ enabled: v })} />
      </div>

      <div className={prefs.enabled ? 'space-y-4' : 'pointer-events-none space-y-4 opacity-40'}>
        <Row label="Event starting soon">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={120}
              value={prefs.eventLeadMin}
              onChange={(e) => update({ eventLeadMin: Math.min(120, Math.max(1, Number(e.target.value))) })}
              className="input w-16 text-center"
            />
            <span className="text-sm font-semibold text-slate-500">min before</span>
            <Toggle checked={prefs.eventsEnabled} onChange={(v) => update({ eventsEnabled: v })} />
          </div>
        </Row>

        <Row label="Todo due">
          <Toggle checked={prefs.todosEnabled} onChange={(v) => update({ todosEnabled: v })} />
        </Row>

        <Row label="Morning summary">
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={prefs.morningTime}
              onChange={(e) => update({ morningTime: e.target.value })}
              className="input w-32"
            />
            <Toggle checked={prefs.morningEnabled} onChange={(v) => update({ morningEnabled: v })} />
          </div>
        </Row>
      </div>

      <button className="btn-soft" onClick={test}>
        {tested ? 'Sent — check your notifications' : 'Send test notification'}
      </button>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-100 pb-3 last:border-0">
      <span className="font-bold text-ink">{label}</span>
      {children}
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      className={`relative h-7 w-12 shrink-0 rounded-full transition ${checked ? 'bg-mint-ink' : 'bg-slate-300'}`}
    >
      <span
        className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${
          checked ? 'left-6' : 'left-1'
        }`}
      />
    </button>
  )
}

/* ------------------------------- People ------------------------------- */

function PeopleSection({ people, reload }: { people: Person[]; reload: () => Promise<void> }) {
  const [newName, setNewName] = useState('')
  const [newEmoji, setNewEmoji] = useState('🙂')

  async function addPerson() {
    if (!newName.trim()) return
    await api.people.create({ name: newName, emoji: newEmoji, color: PALETTE[2].value })
    setNewName('')
    setNewEmoji('🙂')
    reload()
  }

  return (
    <section className="card space-y-4 p-7">
      <div>
        <h2 className="text-xl font-extrabold text-ink">People</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          Each profile has its own todos, goals, and calendar. Switch between them (or see
          everyone with “Both”) from the chip at the top right.
        </p>
      </div>

      <div className="space-y-3">
        {people.map((p) => (
          <PersonRow key={p.id} person={p} canDelete={people.length > 1} reload={reload} />
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-slate-100 pt-4">
        <select
          className="input w-20 text-center text-lg"
          value={newEmoji}
          onChange={(e) => setNewEmoji(e.target.value)}
        >
          {EMOJIS.map((em) => (
            <option key={em} value={em}>
              {em}
            </option>
          ))}
        </select>
        <input
          className="input flex-1"
          placeholder="Add a person (e.g. Alex)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addPerson()}
        />
        <button className="btn-primary" onClick={addPerson} disabled={!newName.trim()}>
          Add
        </button>
      </div>
    </section>
  )
}

function PersonRow({
  person,
  canDelete,
  reload
}: {
  person: Person
  canDelete: boolean
  reload: () => Promise<void>
}) {
  const [name, setName] = useState(person.name)
  const [emoji, setEmoji] = useState(person.emoji)
  const [color, setColor] = useState(person.color)
  const dirty = name !== person.name || emoji !== person.emoji || color !== person.color

  async function save() {
    await api.people.update(person.id, { name, emoji, color })
    reload()
  }
  async function remove() {
    await api.people.remove(person.id)
    reload()
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50/70 p-3">
      <select className="input w-16 text-center text-lg" value={emoji} onChange={(e) => setEmoji(e.target.value)}>
        {EMOJIS.map((em) => (
          <option key={em} value={em}>
            {em}
          </option>
        ))}
      </select>
      <input className="input w-36 flex-1" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="flex items-center gap-1.5">
        {PALETTE.map((p) => (
          <button
            key={p.value}
            onClick={() => setColor(p.value)}
            aria-label={p.name}
            className={`h-6 w-6 rounded-full border-2 transition ${
              color === p.value ? 'scale-110 border-ink' : 'border-white'
            }`}
            style={{ background: p.value }}
          />
        ))}
      </div>
      <button className="btn-primary py-2 text-sm disabled:opacity-40" onClick={save} disabled={!dirty}>
        Save
      </button>
      {canDelete && (
        <button className="btn-soft py-2 text-sm text-rose-ink" onClick={remove}>
          Delete
        </button>
      )}
    </div>
  )
}

/* ------------------------------ Calendar ------------------------------ */

function CalendarSection({ people, initialPerson }: { people: Person[]; initialPerson?: string }) {
  const [personId, setPersonId] = useState(initialPerson || people[0]?.id || '')
  const [current, setCurrent] = useState<SafeCalDavConfig | null>(null)
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [calendarUrl, setCalendarUrl] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'info'; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!personId) return
    setStatus(null)
    setCalendars([])
    setPassword('')
    api.caldav.getConfig(personId).then((c) => {
      setCurrent(c)
      setServerUrl(c?.serverUrl || DEFAULT_SERVER)
      setUsername(c?.username || '')
    })
  }, [personId])

  async function test() {
    setBusy(true)
    setStatus(null)
    try {
      const cals = await api.caldav.test({ serverUrl, username, password })
      setCalendars(cals)
      setCalendarUrl(cals[0]?.url ?? '')
      setStatus({ kind: 'ok', msg: `Connected. Found ${cals.length} calendar(s).` })
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message || 'Connection failed.' })
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    setBusy(true)
    try {
      const name = calendars.find((c) => c.url === calendarUrl)?.name
      await api.caldav.setConfig(personId, { serverUrl, username, password, calendarUrl, calendarName: name })
      setStatus({ kind: 'ok', msg: 'Saved. Running first sync…' })
      const res = await api.caldav.sync(personId)
      setStatus({ kind: 'ok', msg: `Synced "${res.calendar}" — pulled ${res.pulled}, pushed ${res.pushed}.` })
      setCurrent(await api.caldav.getConfig(personId))
      setPassword('')
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message || 'Save failed.' })
    } finally {
      setBusy(false)
    }
  }

  async function syncNow() {
    setBusy(true)
    setStatus({ kind: 'info', msg: 'Syncing…' })
    try {
      const res = await api.caldav.sync(personId)
      setStatus({ kind: 'ok', msg: `Synced "${res.calendar}" — pulled ${res.pulled}, pushed ${res.pushed}.` })
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message || 'Sync failed.' })
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    await api.caldav.clear(personId)
    setCurrent(null)
    setCalendars([])
    setPassword('')
    setStatus({ kind: 'info', msg: 'Disconnected. Events stay in Doneline.' })
  }

  return (
    <section className="card space-y-4 p-7">
      <div>
        <h2 className="text-xl font-extrabold text-ink">Apple Calendar (iCloud)</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          Connect a calendar <em>per person</em> with an{' '}
          <a
            className="text-mint-ink underline"
            href="https://account.apple.com/account/manage"
            target="_blank"
            rel="noreferrer"
          >
            app-specific password
          </a>
          . Two friends can each connect their own iCloud, then “Both” overlays them.
        </p>
      </div>

      <select className="input" value={personId} onChange={(e) => setPersonId(e.target.value)}>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.emoji} {p.name}
          </option>
        ))}
      </select>

      {current && (
        <p className="inline-block rounded-full bg-mint-card px-3 py-1 text-sm font-bold text-mint-ink">
          Connected as {current.username}
          {current.calendarName ? ` · ${current.calendarName}` : ''}
        </p>
      )}

      <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="CalDAV server URL" />
      <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Apple ID email" autoComplete="username" />
      <input
        className="input"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="App-specific password"
        autoComplete="current-password"
      />

      {calendars.length > 0 && (
        <select className="input" value={calendarUrl} onChange={(e) => setCalendarUrl(e.target.value)}>
          {calendars.map((c) => (
            <option key={c.url} value={c.url}>
              {c.name}
            </option>
          ))}
        </select>
      )}

      {status && (
        <p
          className={`rounded-2xl px-4 py-3 text-sm font-bold ${
            status.kind === 'ok'
              ? 'bg-mint-card text-mint-ink'
              : status.kind === 'err'
                ? 'bg-rose-card text-rose-ink'
                : 'bg-slate-100 text-slate-500'
          }`}
        >
          {status.msg}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button className="btn-soft" onClick={test} disabled={busy || !username || !password}>
          Test connection
        </button>
        <button className="btn-primary" onClick={save} disabled={busy || !calendarUrl}>
          Save & sync
        </button>
        {current && (
          <>
            <button className="btn-soft" onClick={syncNow} disabled={busy}>
              Sync now
            </button>
            <button className="btn-soft text-rose-ink" onClick={disconnect} disabled={busy}>
              Disconnect
            </button>
          </>
        )}
      </div>
    </section>
  )
}

/* ------------------------------- Claude ------------------------------- */

function ClaudeSection() {
  return (
    <section className="card space-y-2 p-7">
      <h2 className="text-xl font-extrabold text-ink">Claude access</h2>
      <p className="text-sm font-semibold text-slate-500">
        Doneline ships with an MCP server so Claude can read and add your tasks and events
        (per person). See the README for the one-line config to add it to Claude Code or Claude
        Desktop. It reads the same local database this app uses.
      </p>
    </section>
  )
}
