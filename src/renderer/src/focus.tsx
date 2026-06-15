import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { CHANNELS, channelById, playChime } from './lib/sound'
import { MOODS } from './lib/moods'

type Phase = 'focus' | 'break'

interface FocusCtx {
  open: boolean
  setOpen: (v: boolean) => void

  /** True once a session has been started (controls setup vs ambient view). */
  started: boolean

  phase: Phase
  secondsLeft: number
  totalSeconds: number
  isRunning: boolean
  focusMin: number
  breakMin: number

  taskId: string | null
  setTaskId: (id: string | null) => void

  mood: string
  setMood: (id: string) => void

  channelId: string
  setChannel: (id: string) => void
  playing: boolean
  togglePlay: () => void
  volume: number
  setVolume: (v: number) => void
  audioError: boolean

  start: () => void
  pause: () => void
  reset: () => void
  skip: () => void
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
  const [phase, setPhase] = useState<Phase>('focus')
  const [focusMin, setFocusMinState] = useState(prefs.focusMin)
  const [breakMin, setBreakMinState] = useState(prefs.breakMin)
  const [secondsLeft, setSecondsLeft] = useState(prefs.focusMin * 60)
  const [isRunning, setIsRunning] = useState(false)

  const [taskId, setTaskId] = useState<string | null>(null)
  const [mood, setMood] = useState(prefs.mood)

  const [channelId, setChannelId] = useState(prefs.channelId)
  const [playing, setPlaying] = useState(false)
  const [volume, setVolumeState] = useState(prefs.volume)
  const [audioError, setAudioError] = useState(false)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const totalSeconds = (phase === 'focus' ? focusMin : breakMin) * 60

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
    }
  }, [])

  useEffect(() => {
    const a = audioRef.current
    if (a) a.volume = volume
  }, [volume])

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    if (playing) {
      setAudioError(false)
      a.src = channelById(channelId).url
      a.volume = volume
      a.play().catch(() => {
        setAudioError(true)
        setPlaying(false)
      })
    } else {
      a.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, channelId])

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
    playChime(next)
    setPhase(next)
    setSecondsLeft((next === 'focus' ? focusMin : breakMin) * 60)
  }, [secondsLeft, isRunning, phase, focusMin, breakMin])

  const start = useCallback(() => {
    setStarted(true)
    setSecondsLeft((s) => (s <= 0 ? totalSeconds : s))
    setIsRunning(true)
  }, [totalSeconds])

  const pause = useCallback(() => setIsRunning(false), [])

  const reset = useCallback(() => {
    setIsRunning(false)
    setStarted(false)
    setPhase('focus')
    setSecondsLeft(focusMin * 60)
  }, [focusMin])

  const skip = useCallback(() => {
    const next: Phase = phase === 'focus' ? 'break' : 'focus'
    setPhase(next)
    setSecondsLeft((next === 'focus' ? focusMin : breakMin) * 60)
  }, [phase, focusMin, breakMin])

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
        phase,
        secondsLeft,
        totalSeconds,
        isRunning,
        focusMin,
        breakMin,
        taskId,
        setTaskId,
        mood,
        setMood,
        channelId,
        setChannel,
        playing,
        togglePlay,
        volume,
        setVolume,
        audioError,
        start,
        pause,
        reset,
        skip,
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
