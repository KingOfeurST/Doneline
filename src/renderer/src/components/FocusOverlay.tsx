import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { TodoWithGoal } from '../../../shared/api'
import type { FocusInvite, FocusStats } from '../../../shared/api'
import { useFocus, formatClock } from '../focus'
import { useProfile } from '../profile'
import { usePresence, clockFromSeconds } from '../presence'
import { CHANNELS } from '../lib/sound'
import { MOODS, moodById } from '../lib/moods'
import { randomQuote, type Quote } from '../lib/quotes'
import FocusCanvas from './FocusCanvas'
import { isTodoDoneForSelf } from '../lib/todoCompletion'

const FOCUS_PRESETS = [15, 25, 45, 60]

export default function FocusOverlay() {
  const f = useFocus()
  const { queryPersonId, tick, self } = useProfile()
  const [todos, setTodos] = useState<TodoWithGoal[]>([])
  const [endQuote, setEndQuote] = useState<Quote | null>(null)
  const loadId = useRef(0)

  const loadTodos = useCallback(async () => {
    if (!f.open) return
    const request = ++loadId.current
    try {
      const loaded = await api.todos.list({ includeCompleted: false, personId: queryPersonId })
      if (request === loadId.current) setTodos(loaded.filter((todo) => !isTodoDoneForSelf(todo, self)))
    } catch {}
  }, [f.open, queryPersonId, tick, self])

  useEffect(() => {
    loadTodos()
    return () => { loadId.current++ }
  }, [loadTodos])

  if (!f.open) return null
  if (endQuote) return <Ending quote={endQuote} onClear={() => setEndQuote(null)} />
  if (f.waiting) return <Waiting />
  return f.started ? (
    <Ambient todos={todos} reload={loadTodos} onEnd={() => setEndQuote(randomQuote())} />
  ) : (
    <Setup todos={todos} />
  )
}

/* ------------------------------- Waiting ------------------------------- */

function Waiting() {
  const f = useFocus()
  const mood = moodById(f.mood)
  return (
    <div className="fixed inset-0 z-[90] overflow-hidden" style={{ background: mood.base }}>
      <FocusCanvas moodId={f.mood} />
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center text-white">
        <p className="text-5xl" style={{ animation: 'pop 1s ease-in-out infinite alternate' }}>
          ⏳
        </p>
        <p className="mt-4 text-2xl font-extrabold" style={{ textShadow: '0 4px 30px rgba(0,0,0,0.35)' }}>
          Waiting for your friend to start…
        </p>
        <p className="mt-2 text-sm font-bold text-white/70">You'll both begin at the same moment.</p>
        <style>{`@keyframes pop { 0%{transform:scale(0.9);opacity:0.6} 100%{transform:scale(1.1);opacity:1} }`}</style>
        <button
          className="mt-8 rounded-2xl bg-white/15 px-5 py-3 font-bold text-white backdrop-blur transition hover:bg-white/25"
          onClick={() => {
            f.setWaiting(false)
            f.setOpen(false)
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/* -------------------------------- Setup -------------------------------- */

function Setup({ todos }: { todos: TodoWithGoal[] }) {
  const f = useFocus()
  const { friends } = usePresence()
  const { self, personById } = useProfile()
  const [invited, setInvited] = useState(false)
  const [activeInvite, setActiveInvite] = useState<FocusInvite | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let requestId = 0
    const check = async () => {
      const request = ++requestId
      try {
        const invite = await api.presence.activeInvite()
        if (!cancelled && request === requestId) setActiveInvite(invite)
      } catch {}
    }
    check()
    const off = api.workspace.onChanged(check)
    const poll = setInterval(check, 5000)
    return () => {
      off()
      cancelled = true
      clearInterval(poll)
    }
  }, [self])

  const hostedAccepted =
    !!activeInvite && activeInvite.from_person === self && activeInvite.accepted === 1 && !activeInvite.started_at
  const friendName = activeInvite ? personById(activeInvite.to_person)?.name ?? 'Your friend' : ''

  async function inviteFriend(toId: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await api.presence.invite(toId, f.focusMin, f.breakMin)
      setInvited(true)
      setTimeout(() => setInvited(false), 2500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send your invitation. Please try again.')
    } finally { busyRef.current = false; setBusy(false) }
  }

  async function startTogether() {
    if (!activeInvite) return f.start()
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const startedAt = await api.presence.startInvite(activeInvite.id)
      f.startAnchored(startedAt, activeInvite.focus_min, activeInvite.break_min)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start this session. Please try again.')
    } finally { busyRef.current = false; setBusy(false) }
  }

  return (
    <div
      className="fixed inset-0 z-[90] flex flex-col items-center overflow-y-auto px-6 py-10"
      style={{
        background:
          'radial-gradient(900px 600px at 18% 8%, #c7f0d8 0%, transparent 55%), radial-gradient(900px 620px at 100% 16%, #cdeefb 0%, transparent 55%), linear-gradient(180deg, #dcf0fb 0%, #e3f6ec 100%)'
      }}
    >
      <div className="flex w-full max-w-lg items-center justify-between">
        <span className="font-brand text-2xl text-mint-ink/80">Focus</span>
        <button
          onClick={() => f.setOpen(false)}
          className="rounded-full bg-white/70 p-2 text-slate-500 shadow-clay-sm transition hover:text-ink"
          aria-label="Close"
        >
          <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="mt-6 w-full max-w-lg space-y-5">
        {/* task */}
        <div className="card p-5">
          <p className="mb-2 text-xs font-extrabold uppercase tracking-widest text-slate-400">
            What are you working on?
          </p>
          <select
            className="input"
            value={f.taskId ?? ''}
            onChange={(e) => {
              const id = e.target.value || null
              f.setTaskId(id)
              f.setTaskTitle(todos.find((t) => t.id === id)?.title ?? null)
            }}
          >
            <option value="">Just focus (no task)</option>
            {todos.map((t) => (
              <option key={t.id} value={t.id}>
                {t.person_emoji ? `${t.person_emoji} ` : ''}
                {t.title}
              </option>
            ))}
          </select>
        </div>

        {/* duration */}
        <div className="card p-5">
          <p className="mb-3 text-xs font-extrabold uppercase tracking-widest text-slate-400">
            How long?
          </p>
          <div className="mb-4 flex flex-wrap gap-2">
            {FOCUS_PRESETS.map((m) => (
              <button
                key={m}
                onClick={() => f.setFocusMin(m)}
                className={`rounded-full px-4 py-2 text-sm font-bold transition ${
                  f.focusMin === m ? 'bg-mint-ink text-white' : 'bg-slate-100/80 text-ink hover:bg-slate-200/80'
                }`}
              >
                {m} min
              </button>
            ))}
          </div>
          <div className="flex gap-6">
            <Stepper label="Focus" value={f.focusMin} onChange={f.setFocusMin} />
            <Stepper label="Break" value={f.breakMin} onChange={f.setBreakMin} />
          </div>
        </div>

        {/* mood */}
        <div className="card p-5">
          <p className="mb-3 text-xs font-extrabold uppercase tracking-widest text-slate-400">
            Ambient display
          </p>
          <div className="grid grid-cols-3 gap-3">
            {MOODS.map((m) => (
              <button
                key={m.id}
                onClick={() => f.setMood(m.id)}
                className={`overflow-hidden rounded-2xl border-2 p-0 transition ${
                  f.mood === m.id ? 'border-mint-ink' : 'border-transparent'
                }`}
              >
                <span
                  className="flex h-12 items-end p-2 text-xs font-bold text-white"
                  style={{
                    background: `radial-gradient(40px 30px at 25% 30%, ${m.colors[0]}, transparent), radial-gradient(40px 30px at 80% 60%, ${m.colors[1]}, transparent), ${m.base}`
                  }}
                >
                  {m.name}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* music */}
        <div className="card p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-extrabold uppercase tracking-widest text-slate-400">Music</p>
            <a href="https://somafm.com" target="_blank" rel="noreferrer" className="text-xs font-semibold text-slate-400 underline">
              Powered by SomaFM
            </a>
          </div>
          <div className="flex flex-wrap gap-2">
            {CHANNELS.map((c) => (
              <button
                key={c.id}
                onClick={() => f.setChannel(c.id)}
                title={c.desc}
                className={`rounded-2xl px-3 py-2 text-sm font-bold transition ${
                  f.channelId === c.id ? 'bg-mint-ink text-white' : 'bg-slate-100/80 text-ink hover:bg-slate-200/80'
                }`}
              >
                {c.name}
              </button>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm font-bold text-slate-500">
            <input
              type="checkbox"
              checked={f.playing}
              onChange={f.togglePlay}
            />
            Play music when I start
          </label>
        </div>

        {hostedAccepted ? (
          <>
            <p className="rounded-2xl bg-mint-card px-4 py-2 text-center text-sm font-bold text-mint-ink">
              🎉 {friendName} joined — start when you're ready
            </p>
            <button className="btn-primary w-full py-4 text-lg" onClick={startTogether} disabled={busy}>
              Start together · {f.focusMin} min
            </button>
          </>
        ) : (
          <>
            <button className="btn-primary w-full py-4 text-lg" onClick={f.start}>
              Start focus · {f.focusMin} min
            </button>
            {friends.length > 0 && (
              <button
                className="btn-soft w-full"
                onClick={() => inviteFriend(friends[0].person.id)}
                disabled={invited || busy}
              >
                {invited
                  ? 'Invite sent — waiting for them to join…'
                  : `Invite ${friends[0].person.emoji} ${friends[0].person.name} to focus together`}
              </button>
            )}
          </>
        )}
        {error && <p role="alert" className="mt-3 text-sm font-semibold text-rose-ink">{error}</p>}
      </div>

      <div className="h-8 shrink-0" />
    </div>
  )
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex-1">
      <p className="mb-1 text-sm font-bold text-slate-500">{label}</p>
      <div className="flex items-center gap-2">
        <button className="btn-soft px-3 py-2" onClick={() => onChange(value - 5)} aria-label={`${label} minus`}>
          −
        </button>
        <input
          type="number"
          min={1}
          max={180}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="input w-16 text-center"
        />
        <button className="btn-soft px-3 py-2" onClick={() => onChange(value + 5)} aria-label={`${label} plus`}>
          +
        </button>
      </div>
    </div>
  )
}

/* ------------------------------- Ambient ------------------------------- */

function Ambient({
  todos,
  reload,
  onEnd
}: {
  todos: TodoWithGoal[]
  reload: () => void
  onEnd: () => void
}) {
  const f = useFocus()
  const { friends } = usePresence()
  const focusingFriends = friends.filter((fr) => fr.status === 'focusing')
  const task = todos.find((t) => t.id === f.taskId) || null
  const [taskError, setTaskError] = useState('')
  const taskBusy = useRef(false)
  const mood = moodById(f.mood)

  async function markDone() {
    if (!f.taskId || taskBusy.current) return
    const taskId = f.taskId
    const taskTitle = f.taskTitle
    taskBusy.current = true
    setTaskError('')
    f.setTaskId(null)
    f.setTaskTitle(null)
    try {
      const updated = await api.todos.toggle(taskId, true)
      if (!updated) throw new Error('This todo no longer exists.')
      window.dispatchEvent(new Event('doneline:todos'))
      reload()
    } catch {
      f.setTaskId(taskId)
      f.setTaskTitle(taskTitle)
      setTaskError('Could not mark this todo done. Please try again.')
    } finally {
      taskBusy.current = false
    }
  }

  return (
    <div className="fixed inset-0 z-[90] overflow-hidden" style={{ background: mood.base }}>
      <FocusCanvas moodId={f.mood} />

      {/* close (keeps the session running in the background) */}
      <button
        onClick={() => f.setOpen(false)}
        title="Minimize (keeps running)"
        className="absolute right-5 top-5 z-10 rounded-full bg-white/15 p-2 text-white/90 backdrop-blur transition hover:bg-white/25"
        aria-label="Minimize focus"
      >
        <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
        </svg>
      </button>

      {/* timer */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 text-center text-white">
        <p className="mb-1 text-xs font-extrabold uppercase tracking-[0.4em] text-white/50">
          Session {f.round}
        </p>
        <p
          key={f.phase}
          className="text-sm font-extrabold uppercase tracking-[0.3em] text-white/70"
          style={{ animation: 'phaseIn 750ms cubic-bezier(0.22, 1, 0.36, 1)' }}
        >
          {f.preparing ? 'Get ready' : f.phase === 'focus' ? 'Focus' : 'Break'}
        </p>
        <style>{`
          @keyframes phaseIn {
            0% { opacity: 0; transform: translateY(90px) scale(2.2); }
            55% { opacity: 1; transform: translateY(40px) scale(1.5); }
            100% { opacity: 1; transform: translateY(0) scale(1); }
          }
          @keyframes pop {
            0% { opacity: 0.4; transform: scale(0.7); }
            100% { opacity: 1; transform: scale(1); }
          }
        `}</style>
        {f.preparing ? (
          <p
            key={f.countdown}
            className="mt-2 text-[9rem] font-extrabold leading-none tabular-nums"
            style={{ textShadow: '0 4px 30px rgba(0,0,0,0.35)', animation: 'pop 300ms ease-out' }}
          >
            {f.countdown}
          </p>
        ) : (
          <p
            className="mt-2 text-[7rem] font-extrabold leading-none tabular-nums"
            style={{ textShadow: '0 4px 30px rgba(0,0,0,0.35)' }}
          >
            {formatClock(f.secondsLeft)}
          </p>
        )}
        {task && <p className="mt-4 max-w-md truncate text-lg font-bold text-white/85">{task.title}</p>}

        {focusingFriends.map((fr) => (
          <p key={fr.person.id} className="mt-2 text-sm font-bold text-white/70">
            {fr.person.emoji} {fr.person.name} is focusing too
            {fr.taskTitle ? ` · ${fr.taskTitle}` : ''} · {clockFromSeconds(fr.secondsLeft)}
          </p>
        ))}

        {/* controls */}
        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <button onClick={f.isRunning ? f.pause : f.start} disabled={f.preparing} className="rounded-2xl bg-white px-6 py-3 font-bold text-ink shadow-clay transition hover:brightness-105">
            {f.preparing ? 'Get ready…' : f.isRunning ? 'Pause' : 'Resume'}
          </button>
          <GlassBtn onClick={() => f.addMinutes(5)}>+5 min</GlassBtn>
          <GlassBtn onClick={f.skip}>Skip</GlassBtn>
          {f.taskId && <GlassBtn onClick={markDone}>Mark done</GlassBtn>}
          <GlassBtn
            onClick={() => {
              f.recordFocusBlock()
              f.pause()
              f.stopMusic()
              onEnd()
            }}
          >
            End
          </GlassBtn>
        </div>

        {/* music mini-control */}
        <div className="mt-8 flex items-center gap-4">
          <GlassBtn onClick={f.togglePlay}>{f.playing ? 'Pause music' : 'Play music'}</GlassBtn>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={f.volume}
            onChange={(e) => f.setVolume(Number(e.target.value))}
            className="w-40 accent-white"
          />
        </div>

        {f.audioError && (
          <p className="mt-4 rounded-2xl bg-black/30 px-4 py-2 text-sm font-bold text-white/90">
            Couldn't reach the music stream — the timer keeps running.
          </p>
        )}
        {(taskError || f.recordError) && <p role="alert" className="mt-4 rounded-2xl bg-black/30 px-4 py-2 text-sm font-bold text-white/90">{taskError || f.recordError}</p>}
      </div>
    </div>
  )
}

/* ------------------------------- Ending -------------------------------- */

function Ending({ quote, onClear }: { quote: Quote; onClear: () => void }) {
  const f = useFocus()
  const mood = moodById(f.mood)
  const [stats, setStats] = useState<FocusStats | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () => { void api.focus.stats().then((s) => { if (!cancelled) setStats(s) }).catch(() => {}) }
    load()
    window.addEventListener('doneline:stats', load)
    return () => { cancelled = true; window.removeEventListener('doneline:stats', load) }
  }, [])

  function startAnother() {
    f.reset()
    onClear()
  }
  function done() {
    f.reset()
    onClear()
    f.setOpen(false)
  }

  return (
    <div className="fixed inset-0 z-[90] overflow-hidden" style={{ background: mood.base }}>
      <FocusCanvas moodId={f.mood} />
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-8 text-center text-white">
        {f.recordError && <p role="alert" className="mb-4 text-sm font-bold">{f.recordError}</p>}
        <p className="text-sm font-extrabold uppercase tracking-[0.3em] text-white/70">Session complete</p>
        <p className="mt-3 text-4xl">✨</p>
        <blockquote
          className="mt-6 max-w-2xl text-3xl font-extrabold leading-snug"
          style={{ textShadow: '0 4px 30px rgba(0,0,0,0.35)' }}
        >
          “{quote.text}”
        </blockquote>
        <p className="mt-4 text-lg font-bold text-white/80">— {quote.author}</p>

        {stats && (
          <p className="mt-6 rounded-2xl bg-white/15 px-5 py-2.5 text-sm font-bold text-white backdrop-blur">
            {stats.todaySessions}/{stats.target} sessions today
            {stats.streak > 0 ? ` · 🔥 ${stats.streak}-day streak` : ''}
          </p>
        )}

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={startAnother}
            className="rounded-2xl bg-white px-6 py-3 font-bold text-ink shadow-clay transition hover:brightness-105"
          >
            Start another
          </button>
          <GlassBtn onClick={done}>Done</GlassBtn>
        </div>
      </div>
    </div>
  )
}

function GlassBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-2xl bg-white/15 px-5 py-3 font-bold text-white backdrop-blur transition hover:bg-white/25"
    >
      {children}
    </button>
  )
}
