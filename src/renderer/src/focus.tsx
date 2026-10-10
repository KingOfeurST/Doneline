import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { api } from './api'
import { CHANNELS, channelById } from './lib/sound'
import { playChime, playTick, startRain, type RainHandle } from './lib/audioFx'
import { MOODS } from './lib/moods'
import { FocusClock } from './lib/focusClock'
import { useProfile } from './profile'

type Phase = 'focus' | 'break'

interface FocusCtx {
  open: boolean
  setOpen: (v: boolean) => void

  /** True once a session has been started (controls setup vs ambient view). */
  started: boolean
  /** Which focus block we're on (1, 2, 3, …). */
  round: number
  /** Pre-focus get-ready countdown is running. */
  preparing: boolean
  /** Seconds left in the get-ready countdown. */
  countdown: number
  /** Joined a co-focus session, waiting for the host to start. */
  waiting: boolean
  setWaiting: (v: boolean) => void
  /** Start (or join) a session anchored to a shared timestamp, in sync. */
  startAnchored: (startedAtISO: string, focusMin: number, breakMin: number) => void

  phase: Phase
  secondsLeft: number
  totalSeconds: number
  isRunning: boolean
  focusMin: number
  breakMin: number

  taskId: string | null
  setTaskId: (id: string | null) => void
  taskTitle: string | null
  setTaskTitle: (t: string | null) => void

  mood: string
  setMood: (id: string) => void

  channelId: string
  setChannel: (id: string) => void
  playing: boolean
  togglePlay: () => void
  stopMusic: () => void
  volume: number
  setVolume: (v: number) => void
  audioError: boolean
  recordError: string

  start: () => void
  pause: () => void
  reset: () => void
  skip: () => void
  recordFocusBlock: () => void
  addMinutes: (m: number) => void
  setFocusMin: (m: number) => void
  setBreakMin: (m: number) => void
}

const Ctx = createContext<FocusCtx | null>(null)

const LS = 'doneline.focus'
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS) || '{}')
    return {
      focusMin: clampMin(Number(p.focusMin) || 25),
      breakMin: clampMin(Number(p.breakMin) || 5),
      channelId: CHANNELS.some((c) => c.id === p.channelId) ? p.channelId as string : CHANNELS[0].id,
      mood: MOODS.some((m) => m.id === p.mood) ? p.mood as string : MOODS[0].id,
      volume: typeof p.volume === 'number' && Number.isFinite(p.volume) ? Math.min(1, Math.max(0, p.volume)) : 0.6
    }
  } catch {
    return { focusMin: 25, breakMin: 5, channelId: CHANNELS[0].id, mood: MOODS[0].id, volume: 0.6 }
  }
}

function clampMin(m: number): number {
  if (!Number.isFinite(m)) return 25
  return Math.min(180, Math.max(1, Math.round(m)))
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const { self } = useProfile()
  const [prefs] = useState(loadPrefs)

  const [open, setOpen] = useState(false)
  const [started, setStarted] = useState(false)
  const [round, setRound] = useState(0)
  const [preparing, setPreparing] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [waiting, setWaiting] = useState(false)
  const [phase, setPhase] = useState<Phase>('focus')
  const [focusMin, setFocusMinState] = useState(prefs.focusMin)
  const [breakMin, setBreakMinState] = useState(prefs.breakMin)
  const [secondsLeft, setSecondsLeft] = useState(prefs.focusMin * 60)
  const [isRunning, setIsRunning] = useState(false)
  const clock = useRef(new FocusClock(prefs.focusMin * 60)).current
  const [totalSeconds, setTotalSeconds] = useState(clock.totalSeconds)

  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskTitle, setTaskTitle] = useState<string | null>(null)
  const [mood, setMood] = useState(prefs.mood)

  const [channelId, setChannelId] = useState(prefs.channelId)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolumeState] = useState(prefs.volume)
  const [audioError, setAudioError] = useState(false)
  const [recordError, setRecordError] = useState('')

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rainRef = useRef<RainHandle | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const taskIdRef = useRef(taskId)
  taskIdRef.current = taskId
  const blockOwner = useRef(self)
  const lastIdentity = useRef(self)

  // Log a completed/ended focus block (counts only time actually focused).
  const recordFocusBlock = useCallback(() => {
    if (phaseRef.current !== 'focus') return
    const now = new Date()
    const duration = clock.takeRecordableSeconds(now.getTime())
    if (!duration) return
    api.focus
      .record({
        personId: blockOwner.current || undefined,
        taskId: taskIdRef.current,
        durationSeconds: duration,
        startedAt: new Date(now.getTime() - duration * 1000).toISOString(),
        endedAt: now.toISOString()
      })
      .then(() => window.dispatchEvent(new Event('doneline:stats')))
      .catch(() => setRecordError('Could not save your focus session.'))
  }, [clock])

  // --- persistence ---
  useEffect(() => {
    localStorage.setItem(LS, JSON.stringify({ focusMin, breakMin, channelId, mood, volume }))
  }, [focusMin, breakMin, channelId, mood, volume])

  // --- audio element (single instance, shared across overlay open/close) ---
  useEffect(() => {
    const a = new Audio()
    a.preload = 'none'
    a.onerror = () => {
      setAudioError(true)
      setPlaying(false)
    }
    audioRef.current = a
    return () => {
      a.pause()
      a.src = ''
      audioRef.current = null
      rainRef.current?.stop()
      rainRef.current = null
    }
  }, [])

  useEffect(() => {
    const a = audioRef.current
    if (a) a.volume = volume
    rainRef.current?.setVolume(volume)
  }, [volume])

  // Drive playback: generated rain or a streamed station depending on the channel.
  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    let cancelled = false
    rainRef.current?.stop()
    rainRef.current = null

    if (!playing) {
      a.pause()
      return
    }

    const ch = channelById(channelId)
    if (ch.kind === 'rain') {
      a.pause()
      setAudioError(false)
      rainRef.current = startRain(volume)
    } else {
      setAudioError(false)
      a.src = ch.url ?? ''
      a.volume = volume
      a.play().catch(() => {
        if (cancelled) return
        setAudioError(true)
        setPlaying(false)
      })
    }
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, channelId])

  // Soft ticks for the final 5 seconds of a running phase.
  useEffect(() => {
    if (isRunning && secondsLeft <= 5 && secondsLeft >= 1) playTick()
  }, [secondsLeft, isRunning])

  // Mirror the live timer into the system tray.
  useEffect(() => {
    api.focus.tray(started ? { running: isRunning, phase, secondsLeft } : null)
  }, [started, isRunning, phase, secondsLeft])

  // Broadcast presence to the shared workspace (for co-focus). Emits on state
  // changes + a 20s heartbeat; the friend computes time-left locally from ends_at.
  useEffect(() => {
    const emit = () => {
      const remaining = clock.advance(Date.now())
      const ownsSession = !blockOwner.current || blockOwner.current === self
      const payload = started && isRunning && !preparing && ownsSession
        ? {
            status: 'focusing' as const,
            phase,
            task_title: taskTitle,
            ends_at: new Date(Date.now() + remaining * 1000).toISOString()
          }
        : { status: 'idle' as const }
      api.presence.update(payload).catch(() => {})
    }
    // Heartbeat in every state so a friend sees you as online (not just focusing).
    emit()
    const hb = setInterval(emit, 20_000)
    return () => clearInterval(hb)
  }, [started, isRunning, preparing, phase, taskTitle, self, clock])

  // --- timer tick ---
  useEffect(() => {
    if (!isRunning) return
    const tick = () => setSecondsLeft(clock.advance(Date.now()))
    tick()
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [isRunning, clock])

  // --- phase transition at zero ---
  useEffect(() => {
    if (!isRunning || secondsLeft !== 0) return
    const next: Phase = phase === 'focus' ? 'break' : 'focus'
    if (next === 'break') recordFocusBlock() // a focus block just finished
    playChime(next)
    setPhase(next)
    phaseRef.current = next
    if (next === 'focus') setRound((r) => r + 1) // each focus block is a new session
    const seconds = (next === 'focus' ? focusMin : breakMin) * 60
    clock.reset(seconds, true)
    setSecondsLeft(seconds)
    setTotalSeconds(seconds)
  }, [secondsLeft, isRunning, phase, focusMin, breakMin, clock, recordFocusBlock])

  // --- pre-focus get-ready countdown (10 → 0, then start) ---
  useEffect(() => {
    if (!preparing) return
    if (countdown <= 0) {
      setPreparing(false)
      clock.start(Date.now())
      setIsRunning(true)
      playChime('focus')
      return
    }
    const id = window.setTimeout(() => {
      playTick()
      setCountdown((c) => c - 1)
    }, 1000)
    return () => window.clearTimeout(id)
  }, [preparing, countdown, clock])

  const start = useCallback(() => {
    if (!started) {
      blockOwner.current = self
      // Fresh session: run a 10s get-ready countdown before the focus timer.
      setStarted(true)
      setRound(1)
      setSecondsLeft((s) => (s <= 0 ? totalSeconds : s))
      setPreparing(true)
      setCountdown(10)
    } else {
      if (preparing) return
      clock.start(Date.now())
      setIsRunning(true) // resume after a pause
    }
  }, [started, totalSeconds, preparing, clock, self])

  const pause = useCallback(() => {
    setPreparing(false)
    setCountdown(0)
    setSecondsLeft(clock.pause(Date.now()))
    setIsRunning(false)
  }, [clock])

  // Start (or join) a session anchored to a shared timestamp so both friends are
  // in sync regardless of who detects it first. Skips the get-ready countdown.
  const startAnchored = useCallback((startedAtISO: string, fMin: number, bMin: number) => {
    const f = clampMin(fMin)
    const b = clampMin(bMin)
    const raw = Math.floor((Date.now() - new Date(startedAtISO).getTime()) / 1000)
    // Guard against clock skew / stale anchors: if elapsed is negative or beyond
    // the focus length, just start a full focus block.
    const elapsed = !Number.isFinite(raw) || raw < 0 || raw >= f * 60 ? 0 : raw
    blockOwner.current = self
    setFocusMinState(f)
    setBreakMinState(b)
    setPhase('focus')
    setRound(1)
    phaseRef.current = 'focus'
    clock.reset(Math.max(1, f * 60 - elapsed), true)
    setSecondsLeft(clock.secondsLeft)
    setTotalSeconds(f * 60)
    setPreparing(false)
    setCountdown(0)
    setWaiting(false)
    setStarted(true)
    setOpen(true)
    setIsRunning(true)
  }, [clock, self])

  const reset = useCallback(() => {
    blockOwner.current = self
    setRecordError('')
    setIsRunning(false)
    setStarted(false)
    setPreparing(false)
    setCountdown(0)
    setWaiting(false)
    setRound(0)
    setPhase('focus')
    phaseRef.current = 'focus'
    clock.reset(focusMin * 60)
    setSecondsLeft(focusMin * 60)
    setTotalSeconds(focusMin * 60)
    setPlaying(false) // stop the music when the session ends
  }, [focusMin, clock, self])

  useEffect(() => {
    const previous = lastIdentity.current
    lastIdentity.current = self
    if (!previous) {
      if (!blockOwner.current) blockOwner.current = self
      return
    }
    if (previous !== self && started) {
      // Record the old owner's work before resetting. Presence already suppresses
      // this block for the newly selected identity.
      recordFocusBlock()
      reset()
    }
  }, [self, started, recordFocusBlock, reset])

  const stopMusic = useCallback(() => setPlaying(false), [])

  const skip = useCallback(() => {
    if (preparing) return
    const next: Phase = phaseRef.current === 'focus' ? 'break' : 'focus'
    if (next === 'break') recordFocusBlock()
    setPhase(next)
    phaseRef.current = next
    if (next === 'focus') setRound((r) => r + 1)
    const seconds = (next === 'focus' ? focusMin : breakMin) * 60
    clock.reset(seconds, isRunning)
    setSecondsLeft(seconds)
    setTotalSeconds(seconds)
  }, [focusMin, breakMin, preparing, isRunning, recordFocusBlock, clock])

  const addMinutes = useCallback((m: number) => {
    if (!Number.isFinite(m)) return
    setSecondsLeft(clock.extend(m * 60, Date.now()))
    setTotalSeconds(clock.totalSeconds)
  }, [clock])

  const setFocusMin = useCallback(
    (m: number) => {
      const v = clampMin(m)
      setFocusMinState(v)
      if (!started && phase === 'focus') {
        clock.reset(v * 60)
        setSecondsLeft(v * 60)
        setTotalSeconds(v * 60)
      }
    },
    [started, phase, clock]
  )

  const setBreakMin = useCallback(
    (m: number) => {
      const v = clampMin(m)
      setBreakMinState(v)
      if (!started && phase === 'break') {
        clock.reset(v * 60)
        setSecondsLeft(v * 60)
        setTotalSeconds(v * 60)
      }
    },
    [started, phase, clock]
  )

  const setChannel = useCallback((id: string) => setChannelId(id), [])
  const togglePlay = useCallback(() => setPlaying((p) => !p), [])
  const setVolume = useCallback((v: number) => {
    if (Number.isFinite(v)) setVolumeState(Math.min(1, Math.max(0, v)))
  }, [])

  return (
    <Ctx.Provider
      value={{
        open,
        setOpen,
        started,
        round,
        preparing,
        countdown,
        waiting,
        setWaiting,
        startAnchored,
        phase,
        secondsLeft,
        totalSeconds,
        isRunning,
        focusMin,
        breakMin,
        taskId,
        setTaskId,
        taskTitle,
        setTaskTitle,
        mood,
        setMood,
        channelId,
        setChannel,
        playing,
        togglePlay,
        stopMusic,
        volume,
        setVolume,
        audioError,
        recordError,
        start,
        pause,
        reset,
        skip,
        recordFocusBlock,
        addMinutes,
        setFocusMin,
        setBreakMin
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useFocus(): FocusCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useFocus must be used inside FocusProvider')
  return ctx
}

export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
