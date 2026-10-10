import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { CalendarInfo, SafeCalDavConfig, Person, WorkspaceStatus, NotifPrefs, Recurrence, Todo, TodoWithGoal, UpdateStatus } from '../../../shared/api'
import RecurrencePicker, { recurrenceError } from '../components/RecurrencePicker'
import { useProfile } from '../profile'
import { PALETTE } from '../lib/colors'
import { isMuted, setMuted, playDing } from '../lib/audioFx'
import { localDateInput, parseCreatedAt } from '../lib/format'
import { KeyedSerialQueue } from '../lib/serialQueue'
import { useTodoCompletion } from '../lib/useTodoCompletion'

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
      <RecurringTasksSection />
      <ArchiveSection />
      <UpdatesSection />
      <ClaudeSection />
    </div>
  )
}

/* ------------------------------- Updates ------------------------------ */

function UpdatesSection() {
  const [version, setVersion] = useState('')
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const statusRef = useRef<UpdateStatus | null>(null)
  const revision = useRef(0)

  function applyStatus(next: UpdateStatus) {
    statusRef.current = next
    setStatus(next)
    busyRef.current = next.state === 'checking' || next.state === 'downloading' || next.state === 'installing' ||
      (next.state === 'available' && next.canAutoInstall)
    setBusy(busyRef.current)
  }

  useEffect(() => {
    let cancelled = false
    api.updates.version().then((v) => { if (!cancelled) setVersion(v) }).catch(() => {})
    const off = api.updates.onStatus((next) => {
      if (cancelled) return
      revision.current++
      applyStatus(next)
    })
    const requestedAt = revision.current
    api.updates.status().then((next) => {
      if (!cancelled && revision.current === requestedAt) applyStatus(next)
    }).catch((cause) => {
      if (!cancelled && revision.current === requestedAt) applyStatus({ state: 'error', canAutoInstall: false,
        message: cause instanceof Error ? cause.message : 'Could not load update status.' })
    })
    return () => { cancelled = true; off() }
  }, [])

  async function check() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const requestedAt = ++revision.current
    try {
      const next = await api.updates.check()
      if (revision.current === requestedAt) applyStatus(next)
    } catch (cause) {
      applyStatus({ state: 'error', canAutoInstall: statusRef.current?.canAutoInstall ?? false,
        message: cause instanceof Error ? cause.message : 'Could not check for updates. Please try again.' })
    }
  }

  async function install() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await api.updates.install()
    } catch (cause) {
      applyStatus({ state: 'error', canAutoInstall: statusRef.current?.canAutoInstall ?? false,
        message: cause instanceof Error ? cause.message : 'Could not install this update. Please try again.' })
    } finally {
      busyRef.current = statusRef.current?.state === 'installing'
      setBusy(busyRef.current)
    }
  }

  const message = !status || status.state === 'idle' ? ''
    : status.state === 'dev' ? 'Updates only work in the installed app, not in dev mode.'
    : status.state === 'checking' ? 'Checking…'
    : status.state === 'available' ? (status.canAutoInstall
      ? `Update ${status.version ?? ''} found — downloading…`
      : `Update ${status.version ?? ''} available. Open the downloads page to install it.`)
    : status.state === 'downloading' ? `Downloading… ${status.percent ?? 0}%`
    : status.state === 'downloaded' ? `Update ${status.version ?? ''} ready.`
    : status.state === 'installing' ? 'Restarting to install the update…'
    : status.state === 'not-available' ? "You're on the latest version 🎉"
    : `Update failed: ${status.message ?? 'unknown error'}`
  const actionable = status && ((status.state === 'downloaded' && status.canAutoInstall) ||
    (status.state === 'available' && !status.canAutoInstall))

  return (
    <section className="card space-y-3 p-7">
      <div>
        <h2 className="text-xl font-extrabold text-ink">Updates</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          {status?.canAutoInstall
            ? 'Doneline downloads new releases automatically and installs them when you quit.'
            : 'This build checks for new releases. Download and install available updates from GitHub.'}
          {version ? ` You're on v${version}.` : ''}
        </p>
      </div>

      {message && (
        <p role={status?.state === 'error' ? 'alert' : 'status'} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-bold text-slate-600">{message}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <button className="btn-soft" onClick={check} disabled={busy}>
          Check for updates
        </button>
        {actionable && (
          <button className="btn-primary" onClick={install} disabled={busy}>
            {status.canAutoInstall ? 'Restart & update' : 'Open downloads page'}
          </button>
        )}
      </div>
    </section>
  )
}

/* ------------------------------ Identity ------------------------------ */

function IdentitySection({ people }: { people: Person[] }) {
  const { self } = useProfile()
  const [selected, setSelected] = useState(self)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!busyRef.current) setSelected(people.some((p) => p.id === self) ? self : people[0]?.id ?? '')
  }, [self, people])

  async function choose(id: string) {
    if (busyRef.current || !people.some((p) => p.id === id)) return
    const before = selected
    busyRef.current = true
    setBusy(true)
    setSelected(id)
    setError('')
    try {
      await api.presence.setSelf(id)
      window.dispatchEvent(new Event('doneline:identity'))
    } catch (cause) {
      setSelected(before)
      setError(cause instanceof Error ? cause.message : 'Could not select this profile. Please try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <section className="card p-7">
      <h2 className="text-xl font-extrabold text-ink">This is me</h2>
      <p className="mb-3 mt-1 text-sm font-semibold text-slate-500">
        Which profile are you on this device? Used for co-focus presence and nudges — your
        friend sets theirs on their own machine.
      </p>
      <select aria-label="This device's profile" className="input" value={selected} onChange={(e) => choose(e.target.value)} disabled={busy || !people.length}>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.emoji} {p.name}
          </option>
        ))}
      </select>
      {error && <p role="alert" className="mt-2 text-sm font-semibold text-rose-ink">{error}</p>}
    </section>
  )
}

/* ---------------------------- Focus target ---------------------------- */

function FocusTargetSection() {
  const [target, setTarget] = useState(4)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const targetRef = useRef(target)
  const writes = useRef(new KeyedSerialQueue()).current

  useEffect(() => {
    let cancelled = false
    const started = revision.current
    api.focus.getTarget().then((n) => {
      if (!cancelled && revision.current === started) { targetRef.current = n; setTarget(n) }
    }).catch(() => { if (!cancelled) setError('Could not load the daily goal.') })
    return () => { cancelled = true }
  }, [])

  function update(n: number) {
    if (!Number.isFinite(n)) return
    const v = Math.min(20, Math.max(1, Math.round(n)))
    const current = ++revision.current
    targetRef.current = v
    setTarget(v)
    setError('')
    writes.run('target', () => api.focus.setTarget(v)).then(() => {
      window.dispatchEvent(new Event('doneline:stats'))
    }).catch(async () => {
      if (revision.current !== current) return
      setError('Could not save the daily goal. Please try again.')
      try {
        const saved = await api.focus.getTarget()
        if (revision.current === current) { targetRef.current = saved; setTarget(saved) }
      } catch {}
    })
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
      {error && <p role="alert" className="mt-2 text-sm font-semibold text-rose-ink">{error}</p>}
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

/* ------------------------- Recurring tasks ---------------------------- */

function parseRec(json: string | null): Recurrence | null {
  if (!json) return null
  try { return JSON.parse(json) as Recurrence } catch { return null }
}

function recLabel(t: Todo): string {
  const rec = parseRec(t.recurrence)
  if (!rec) return ''
  let schedule = 'Every day'
  if (rec.freq === 'weekly') {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    schedule = (rec.days ?? []).map((d: number) => names[d]).join(', ')
  }
  return [schedule, rec.startDate && `from ${rec.startDate}`, rec.endDate && `until ${rec.endDate}`,
    rec.excludedDates?.length && `${rec.excludedDates.length} skipped date${rec.excludedDates.length === 1 ? '' : 's'}`]
    .filter(Boolean).join(' · ')
}

function RecurringTasksSection() {
  const { tick } = useProfile()
  const [templates, setTemplates] = useState<TodoWithGoal[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editRec, setEditRec] = useState<Recurrence | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestId = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestId.current
    setLoading(true)
    try {
      const rows = await api.todos.templates()
      if (request === requestId.current) setTemplates(rows)
    } catch (cause) {
      if (request === requestId.current) setError(cause instanceof Error ? cause.message : 'Could not load repeat rules.')
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
    return () => { requestId.current++ }
  }, [open, tick, load])

  async function remove(id: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await api.todos.removeTemplate(id)
      if (editing === id) setEditing(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove this repeat rule.')
    } finally { busyRef.current = false; setBusy(false) }
  }

  function startEdit(t: TodoWithGoal) {
    if (busyRef.current) return
    setError('')
    setEditing(t.id)
    setEditTitle(t.title)
    setEditRec(parseRec(t.recurrence))
  }

  function cancelEdit() {
    if (busyRef.current) return
    setEditing(null)
  }

  async function saveEdit(id: string) {
    if (busyRef.current) return
    if (!editTitle.trim()) { setError('Please enter a title.'); return }
    const recError = recurrenceError(editRec)
    if (recError) { setError(recError); return }
    const original = parseRec(templates.find((t) => t.id === id)?.recurrence ?? null)
    const recurrence = editRec ? { ...editRec, excludedDates: editRec.excludedDates ?? original?.excludedDates } : null
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const updated = await api.todos.update(id, { title: editTitle.trim(), recurrence: recurrence ? JSON.stringify(recurrence) : null })
      if (!updated) throw new Error('This repeat rule no longer exists.')
      setEditing(null)
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this repeat rule.')
    } finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <section className="card space-y-3 p-7">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <div className="text-left">
          <h2 className="text-xl font-extrabold text-ink">Recurring tasks</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Active repeat rules. Edit or delete them here.
          </p>
        </div>
        <span className="text-slate-400">{open ? '▲' : '▼'}</span>
      </button>

      {error && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p>}
      {open && (
        loading && templates.length === 0 ? <p className="py-4 text-center text-sm font-semibold text-slate-400">Loading…</p> : templates.length === 0 ? (
          <p className="py-4 text-center text-sm font-semibold text-slate-400">No recurring tasks.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {templates.map((t) => (
              <div key={t.id} className="py-3">
                {editing === t.id ? (
                  <div className="space-y-3">
                    <input
                      className="input w-full"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(t.id); if (e.key === 'Escape') cancelEdit() }}
                      autoFocus
                      disabled={busy}
                    />
                    <fieldset disabled={busy}>
                      <RecurrencePicker value={editRec} onChange={setEditRec}
                        defaultStartDate={localDateInput(t.due_at ? new Date(t.due_at) : parseCreatedAt(t.created_at))} />
                    </fieldset>
                    <div className="flex gap-2">
                      <button className="btn-primary py-2 text-sm" onClick={() => saveEdit(t.id)} disabled={busy || !editTitle.trim()}>{busy ? 'Saving…' : 'Save'}</button>
                      <button className="btn-soft py-2 text-sm" onClick={cancelEdit} disabled={busy}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-base"
                        style={{ background: (t.goal_color || '#2f7a4d') + '22' }}
                        title={t.person_name ?? 'Unassigned'}
                      >
                        {t.person_emoji ?? '🙂'}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate font-bold text-ink">{t.title}</p>
                        <p className="truncate text-xs font-semibold text-slate-400">
                          {t.person_name ?? 'Unassigned'} · {recLabel(t)}
                          {t.goal_title && (
                            <span style={{ color: t.goal_color ?? undefined }}> · {t.goal_title}</span>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        className="rounded-xl px-3 py-1.5 text-sm font-bold text-slate-500 transition hover:bg-slate-100"
                        onClick={() => startEdit(t)}
                        disabled={busy}
                      >
                        Edit
                      </button>
                      <button
                        className="rounded-xl px-3 py-1.5 text-sm font-bold text-rose-ink transition hover:bg-rose-card"
                        onClick={() => remove(t.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </section>
  )
}

/* ------------------------------ Archive ------------------------------- */

function ArchiveSection() {
  const { queryPersonId, self, people, tick } = useProfile()
  const [items, setItems] = useState<TodoWithGoal[]>([])
  const [open, setOpen] = useState(false)
  const completion = useTodoCompletion(self, people.map((p) => p.id))
  const { guard, setError } = completion
  const load = useCallback(async () => {
    const request = guard.beginLoad()
    try {
      const rows = await api.todos.archived(queryPersonId)
      if (guard.isCurrent(request)) setItems(guard.applyPending(rows).filter((t) => t.completed_at !== null))
    } catch {
      if (guard.isCurrent(request)) setError('Could not load the archive.')
    }
  }, [guard, setError, queryPersonId])
  const latestLoad = useRef(load)
  latestLoad.current = load

  useEffect(() => {
    if (open) void load()
  }, [open, tick, load])

  function reopen(todo: TodoWithGoal) {
    void completion.toggle(todo, (updated) => {
      setItems((prev) => updated.completed_at === null
        ? prev.filter((t) => t.id !== updated.id)
        : [updated, ...prev.filter((t) => t.id !== updated.id)].sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? '')))
    }, () => latestLoad.current(), false)
  }

  return (
    <section className="card space-y-3 p-7">
      <button className="flex w-full items-center justify-between" onClick={() => setOpen((o) => !o)}>
        <div className="text-left">
          <h2 className="text-xl font-extrabold text-ink">Archive</h2>
          <p className="mt-1 text-sm font-semibold text-slate-500">
            Completed todos move here at midnight. Goal history is kept; other items are removed after 14 days.
          </p>
        </div>
        <span className="text-slate-400">{open ? '▲' : '▼'}</span>
      </button>
      {completion.error && <p role="alert" className="text-sm font-semibold text-rose-ink">{completion.error}</p>}

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
                <button className="btn-soft ml-3 py-1.5 text-xs" onClick={() => reopen(t)} disabled={completion.pendingIds.has(t.id)}>Reopen</button>
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
  const busyRef = useRef(false)
  const requestId = useRef(0)

  const refresh = useCallback(async () => {
    const request = ++requestId.current
    try {
      const [nextStatus, nextCode] = await Promise.all([api.workspace.status(), api.workspace.myCode()])
      if (request === requestId.current) { setStatus(nextStatus); setMyCode(nextCode) }
    } catch {
      if (request === requestId.current) setMsg({ kind: 'err', text: 'Could not load workspace settings.' })
    }
  }, [])
  useEffect(() => {
    refresh()
    const off = api.workspace.onChanged(refresh)
    return () => { requestId.current++; off() }
  }, [refresh])

  const canConnect = (url.trim() && token.trim()) || code.trim()

  async function connect() {
    if (!canConnect || busyRef.current || !status) return
    busyRef.current = true
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
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function disconnect() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await api.workspace.disconnect()
      window.location.reload()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Failed.' })
      setBusy(false)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function syncNow() {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setMsg({ kind: 'info', text: 'Syncing…' })
    try {
      await api.workspace.sync()
      setMsg({ kind: 'ok', text: 'Synced.' })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || 'Sync failed.' })
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  async function copyCode() {
    if (!myCode) return
    try {
      await navigator.clipboard.writeText(myCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setMsg({ kind: 'err', text: 'Could not copy the code. Select and copy it from the field.' })
    }
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

          <button className="btn-primary" onClick={connect} disabled={busy || !status || !canConnect}>
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
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const prefsRef = useRef<NotifPrefs | null>(null)
  const revision = useRef(0)
  const writes = useRef(new KeyedSerialQueue()).current

  useEffect(() => {
    let cancelled = false
    const started = revision.current
    api.notifications.get().then((next) => {
      if (!cancelled && revision.current === started) { prefsRef.current = next; setPrefs(next) }
    }).catch(() => { if (!cancelled) setError('Could not load notification settings.') })
    return () => { cancelled = true }
  }, [])

  function update(patch: Partial<NotifPrefs>) {
    const cur = prefsRef.current
    if (!cur) return
    if (patch.eventLeadMin !== undefined && !Number.isFinite(patch.eventLeadMin)) return
    if (patch.morningTime !== undefined && !/^\d{2}:\d{2}$/.test(patch.morningTime)) return
    const next = { ...cur, ...patch }
    const current = ++revision.current
    prefsRef.current = next
    setPrefs(next)
    setError('')
    writes.run('notifications', () => api.notifications.set(next)).catch(async () => {
      if (revision.current !== current) return
      setError('Could not save notification settings. Please try again.')
      try {
        const saved = await api.notifications.get()
        if (revision.current === current) { prefsRef.current = saved; setPrefs(saved) }
      } catch {}
    })
  }

  async function test() {
    if (testing) return
    setTesting(true)
    setError('')
    try {
      await api.notifications.test()
      setTested(true)
      setTimeout(() => setTested(false), 2000)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send a test notification.')
    } finally { setTesting(false) }
  }

  if (!prefs) return error ? <section className="card p-7"><p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p></section> : null

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

      {error && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p>}
      <button className="btn-soft" onClick={test} disabled={testing}>
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
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')

  async function addPerson() {
    if (!newName.trim() || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await api.people.create({ name: newName.trim(), emoji: newEmoji, color: PALETTE[2].value })
      setNewName('')
      setNewEmoji('🙂')
      await reload()
      window.dispatchEvent(new Event('doneline:identity'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add this profile. Please try again.')
    } finally { busyRef.current = false; setBusy(false) }
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
          disabled={busy}
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
          disabled={busy}
        />
        <button className="btn-primary" onClick={addPerson} disabled={!newName.trim() || busy}>
          Add
        </button>
      </div>
      {error && <p role="alert" className="text-sm font-semibold text-rose-ink">{error}</p>}
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
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const base = useRef(person)
  const editing = useRef(false)
  const dirty = name !== base.current.name || emoji !== base.current.emoji || color !== base.current.color
  useEffect(() => {
    if (editing.current || busyRef.current) return
    base.current = person
    setName(person.name)
    setEmoji(person.emoji)
    setColor(person.color)
  }, [person])

  async function save() {
    if (busyRef.current || !name.trim()) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const patch = {
        ...(name !== base.current.name ? { name: name.trim() } : {}),
        ...(emoji !== base.current.emoji ? { emoji } : {}),
        ...(color !== base.current.color ? { color } : {})
      }
      const updated = await api.people.update(person.id, patch)
      if (!updated) throw new Error('This profile no longer exists.')
      base.current = updated
      editing.current = false
      setName(updated.name); setEmoji(updated.emoji); setColor(updated.color)
      await reload()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this profile.')
    } finally { busyRef.current = false; setBusy(false) }
  }
  async function remove() {
    if (busyRef.current || !canDelete) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await api.people.remove(person.id)
      await reload()
      window.dispatchEvent(new Event('doneline:identity'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this profile.')
    } finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-50/70 p-3">
      <select aria-label="Profile emoji" className="input w-16 text-center text-lg" value={emoji} disabled={busy} onChange={(e) => { editing.current = true; setEmoji(e.target.value) }}>
        {EMOJIS.map((em) => (
          <option key={em} value={em}>
            {em}
          </option>
        ))}
      </select>
      <input aria-label="Profile name" className="input w-36 flex-1" value={name} disabled={busy} onChange={(e) => { editing.current = true; setName(e.target.value) }} />
      <div className="flex items-center gap-1.5">
        {PALETTE.map((p) => (
          <button
            key={p.value}
            onClick={() => { editing.current = true; setColor(p.value) }}
            disabled={busy}
            aria-label={p.name}
            className={`h-6 w-6 rounded-full border-2 transition ${
              color === p.value ? 'scale-110 border-ink' : 'border-white'
            }`}
            style={{ background: p.value }}
          />
        ))}
      </div>
      <button className="btn-primary py-2 text-sm disabled:opacity-40" onClick={save} disabled={!dirty || !name.trim() || busy}>
        Save
      </button>
      {editing.current && <button className="btn-soft py-2 text-sm" disabled={busy} onClick={() => {
        editing.current = false; base.current = person
        setName(person.name); setEmoji(person.emoji); setColor(person.color); setError('')
      }}>Reset</button>}
      {canDelete && (
        <button className="btn-soft py-2 text-sm text-rose-ink" disabled={busy} onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      )}
      {confirmDelete && canDelete && <div className="w-full text-sm font-semibold text-rose-ink">
        Delete {person.name} and all their tasks, goals, events, and notes?
        <div className="mt-2 flex gap-2">
          <button className="btn-primary bg-rose-ink py-2 text-sm" onClick={remove} disabled={busy}>Delete profile and items</button>
          <button className="btn-soft py-2 text-sm" onClick={() => setConfirmDelete(false)} disabled={busy}>Keep profile</button>
        </div>
      </div>}
      {error && <p role="alert" className="w-full text-sm font-semibold text-rose-ink">{error}</p>}
    </div>
  )
}

/* ------------------------------ Calendar ------------------------------ */

function CalendarSection({ people, initialPerson }: { people: Person[]; initialPerson?: string }) {
  const [personId, setPersonId] = useState(initialPerson || people[0]?.id || '')
  useEffect(() => {
    if (initialPerson && people.some((p) => p.id === initialPerson)) setPersonId(initialPerson)
  }, [initialPerson])
  useEffect(() => {
    if (!people.some((p) => p.id === personId)) setPersonId(people[0]?.id ?? '')
  }, [people, personId])
  return <CalendarPersonSettings key={personId} people={people} personId={personId} selectPerson={setPersonId} />
}

function CalendarPersonSettings({ people, personId, selectPerson }: {
  people: Person[]; personId: string; selectPerson: (id: string) => void
}) {
  const [current, setCurrent] = useState<SafeCalDavConfig | null>(null)
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [calendarUrl, setCalendarUrl] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'info'; msg: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const busyRef = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    if (!personId) { setLoading(false); return }
    let cancelled = false
    setStatus(null)
    setCalendars([])
    setPassword('')
    api.caldav.getConfig(personId).then((c) => {
      if (cancelled) return
      setCurrent(c)
      setServerUrl(c?.serverUrl || DEFAULT_SERVER)
      setUsername(c?.username || '')
    }).catch((cause) => {
      if (!cancelled) setStatus({ kind: 'err', msg: cause instanceof Error ? cause.message : 'Could not load this calendar connection.' })
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true; mounted.current = false }
  }, [personId])

  function startOperation(): boolean {
    if (busyRef.current || loading || !personId) return false
    busyRef.current = true
    setBusy(true)
    setStatus(null)
    return true
  }
  function finishOperation() {
    busyRef.current = false
    if (mounted.current) setBusy(false)
  }

  async function test() {
    if (!username.trim() || !password.trim() || !startOperation()) return
    try {
      const cals = await api.caldav.test({ serverUrl, username, password })
      if (!mounted.current) return
      setCalendars(cals)
      setCalendarUrl(cals[0]?.url ?? '')
      setStatus({ kind: cals.length ? 'ok' : 'info', msg: cals.length ? `Connected. Found ${cals.length} calendar(s).` : 'Connected, but no writable calendars were found.' })
    } catch (e) {
      if (mounted.current) setStatus({ kind: 'err', msg: (e as Error).message || 'Connection failed.' })
    } finally {
      finishOperation()
    }
  }

  async function save() {
    if (!calendarUrl || !username.trim() || !password.trim() || !startOperation()) return
    try {
      const name = calendars.find((c) => c.url === calendarUrl)?.name
      await api.caldav.setConfig(personId, { serverUrl, username, password, calendarUrl, calendarName: name })
      if (mounted.current) {
        setCurrent(await api.caldav.getConfig(personId))
        setPassword('')
      }
      if (!mounted.current) return
      setStatus({ kind: 'ok', msg: 'Saved. Running first sync…' })
      const res = await api.caldav.sync(personId)
      if (!mounted.current) return
      setStatus({ kind: 'ok', msg: `Synced "${res.calendar}" — pulled ${res.pulled}, pushed ${res.pushed}.` })
    } catch (e) {
      if (mounted.current) setStatus({ kind: 'err', msg: (e as Error).message || 'Save failed.' })
    } finally {
      finishOperation()
    }
  }

  async function syncNow() {
    if (!startOperation()) return
    setStatus({ kind: 'info', msg: 'Syncing…' })
    try {
      const res = await api.caldav.sync(personId)
      if (mounted.current) setStatus({ kind: 'ok', msg: `Synced "${res.calendar}" — pulled ${res.pulled}, pushed ${res.pushed}.` })
    } catch (e) {
      if (mounted.current) setStatus({ kind: 'err', msg: (e as Error).message || 'Sync failed.' })
    } finally {
      finishOperation()
    }
  }

  async function disconnect() {
    if (!startOperation()) return
    try {
      await api.caldav.clear(personId)
      if (!mounted.current) return
      setCurrent(null)
      setCalendars([])
      setCalendarUrl('')
      setPassword('')
      setStatus({ kind: 'info', msg: 'Disconnected. Events stay in Doneline.' })
    } catch (cause) {
      if (mounted.current) setStatus({ kind: 'err', msg: cause instanceof Error ? cause.message : 'Could not disconnect this calendar.' })
    } finally { finishOperation() }
  }

  function invalidateTest() {
    setCalendars([])
    setCalendarUrl('')
    setStatus(null)
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

      <select aria-label="Calendar profile" className="input" value={personId} onChange={(e) => selectPerson(e.target.value)} disabled={busy || !people.length}>
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

      <input className="input" value={serverUrl} disabled={busy || loading} onChange={(e) => { setServerUrl(e.target.value); invalidateTest() }} placeholder="CalDAV server URL" />
      <input className="input" value={username} disabled={busy || loading} onChange={(e) => { setUsername(e.target.value); invalidateTest() }} placeholder="Apple ID email" autoComplete="username" />
      <input
        className="input"
        type="password"
        value={password}
        onChange={(e) => { setPassword(e.target.value); invalidateTest() }}
        disabled={busy || loading}
        placeholder="App-specific password"
        autoComplete="current-password"
      />

      {calendars.length > 0 && (
        <select aria-label="Connected calendar" className="input" value={calendarUrl} onChange={(e) => setCalendarUrl(e.target.value)} disabled={busy}>
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
        <button className="btn-soft" onClick={test} disabled={busy || loading || !personId || !username.trim() || !password.trim()}>
          Test connection
        </button>
        <button className="btn-primary" onClick={save} disabled={busy || loading || !calendarUrl || !password.trim()}>
          Save & sync
        </button>
        {current && (
          <>
            <button className="btn-soft" onClick={syncNow} disabled={busy || loading}>
              Sync now
            </button>
            <button className="btn-soft text-rose-ink" onClick={disconnect} disabled={busy || loading}>
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
