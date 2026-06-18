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
      channelId: typeof p.channelId === 'string' ? p.channelId : CHANNELS[0].id,
      mood: typeof p.mood === 'string' ? p.mood : MOODS[0].id,
      volume: typeof p.volume === 'number' ? p.volume : 0.6
    }
  } catch {
    return { focusMin: 25, breakMin: 5, channelId: CHANNELS[0].id, mood: MOODS[0].id, volume: 0.6 }
  }
}

function clampMin(m: number): number {
  return Math.min(180, Math.max(1, Math.round(m)))
}

export function FocusProvider({ children }: { children: ReactNode }) {
  const prefs = useRef(loadPrefs()).current

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

  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskTitle, setTaskTitle] = useState<string | null>(null)
  const [mood, setMood] = useState(prefs.mood)

  const [channelId, setChannelId] = useState(prefs.channelId)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolumeState] = useState(prefs.volume)
  const [audioError, setAudioError] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rainRef = useRef<RainHandle | null>(null)
  const secondsLeftRef = useRef(secondsLeft)
  secondsLeftRef.current = secondsLeft
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const focusMinRef = useRef(focusMin)
  focusMinRef.current = focusMin
  const taskIdRef = useRef(taskId)
  taskIdRef.current = taskId
  const totalSeconds = (phase === 'focus' ? focusMin : breakMin) * 60

  // Log a completed/ended focus block (counts only time actually focused).
  const recordFocusBlock = useCallback(() => {
    if (phaseRef.current !== 'focus') return
    const duration = focusMinRef.current * 60 - secondsLeftRef.current
    if (duration < 60) return
    const now = new Date()
    api.focus
      .record({
        taskId: taskIdRef.current,
        durationSeconds: duration,
        startedAt: new Date(now.getTime() - duration * 1000).toISOString(),
        endedAt: now.toISOString()
      })
      .then(() => window.dispatchEvent(new Event('doneline:stats')))
      .catch(() => {})
  }, [])

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
        setAudioError(true)
        setPlaying(false)
      })
    }
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
      const payload = started
        ? {
            status: 'focusing' as const,
            phase,
            task_title: taskTitle,
            ends_at: new Date(Date.now() + secondsLeftRef.current * 1000).toISOString()
          }
        : { status: 'idle' as const }
      api.presence.update(payload).catch(() => {})
    }
    // Heartbeat in every state so a friend sees you as online (not just focusing).
    emit()
    const hb = setInterval(emit, 20_000)
    return () => clearInterval(hb)
  }, [started, isRunning, phase, taskTitle])

  // --- timer tick ---
  useEffect(() => {
    if (!isRunning) return
    const id = window.setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000)
    return () => window.clearInterval(id)
  }, [isRunning])

  // --- phase transition at zero ---
  useEffect(() => {
    if (!isRunning || secondsLeft !== 0) return
    const next: Phase = phase === 'focus' ? 'break' : 'focus'
    if (next === 'break') recordFocusBlock() // a focus block just finished
    playChime(next)
    setPhase(next)
    if (next === 'focus') setRound((r) => r + 1) // each focus block is a new session
    setSecondsLeft((next === 'focus' ? focusMin : breakMin) * 60)
  }, [secondsLeft, isRunning, phase, focusMin, breakMin])

  // --- pre-focus get-ready countdown (10 → 0, then start) ---
  useEffect(() => {
    if (!preparing) return
    if (countdown <= 0) {
      setPreparing(false)
      setIsRunning(true)
      playChime('focus')
      return
    }
    const id = window.setTimeout(() => {
      playTick()
      setCountdown((c) => c - 1)
    }, 1000)
    return () => window.clearTimeout(id)
  }, [preparing, countdown])

  const start = useCallback(() => {
    if (!started) {
      // Fresh session: run a 10s get-ready countdown before the focus timer.
      setStarted(true)
      setRound(1)
      setSecondsLeft((s) => (s <= 0 ? totalSeconds : s))
      setPreparing(true)
      setCountdown(10)
    } else {
      setIsRunning(true) // resume after a pause
    }
  }, [started, totalSeconds])

  const pause = useCallback(() => setIsRunning(false), [])

  // Start (or join) a session anchored to a shared timestamp so both friends are
  // in sync regardless of who detects it first. Skips the get-ready countdown.
  const startAnchored = useCallback((startedAtISO: string, fMin: number, bMin: number) => {
    const raw = Math.floor((Date.now() - new Date(startedAtISO).getTime()) / 1000)
    // Guard against clock skew / stale anchors: if elapsed is negative or beyond
    // the focus length, just start a full focus block.
    const elapsed = raw < 0 || raw > fMin * 60 ? 0 : raw
    setFocusMinState(fMin)
    setBreakMinState(bMin)
    setPhase('focus')
    setRound(1)
    setSecondsLeft(Math.max(1, fMin * 60 - elapsed))
    setPreparing(false)
    setCountdown(0)
    setWaiting(false)
    setStarted(true)
    setOpen(true)
    setIsRunning(true)
  }, [])

  const reset = useCallback(() => {
    setIsRunning(false)
    setStarted(false)
    setPreparing(false)
    setCountdown(0)
    setWaiting(false)
    setRound(0)
    setPhase('focus')
    setSecondsLeft(focusMin * 60)
    setPlaying(false) // stop the music when the session ends
  }, [focusMin])

  const stopMusic = useCallback(() => setPlaying(false), [])

  const skip = useCallback(() => {
    const next: Phase = phase === 'focus' ? 'break' : 'focus'
    if (next === 'break') recordFocusBlock()
    setPhase(next)
    setSecondsLeft((next === 'focus' ? focusMin : breakMin) * 60)
  }, [phase, focusMin, breakMin, recordFocusBlock])

  const addMinutes = useCallback((m: number) => {
    setSecondsLeft((s) => Math.max(0, s + m * 60))
  }, [])

  const setFocusMin = useCallback(
    (m: number) => {
      const v = clampMin(m)
      setFocusMinState(v)
      if (!isRunning && phase === 'focus') setSecondsLeft(v * 60)
    },
    [isRunning, phase]
  )

  const setBreakMin = useCallback(
    (m: number) => {
      const v = clampMin(m)
      setBreakMinState(v)
      if (!isRunning && phase === 'break') setSecondsLeft(v * 60)
    },
    [isRunning, phase]
  )

  const setChannel = useCallback((id: string) => setChannelId(id), [])
  const togglePlay = useCallback(() => setPlaying((p) => !p), [])
  const setVolume = useCallback((v: number) => setVolumeState(v), [])

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
