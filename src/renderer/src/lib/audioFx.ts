/**
 * Generated UI/focus sound effects via the Web Audio API — no audio files, works
 * offline. All effects honor a global mute (persisted in localStorage). Also
 * provides a generated "rain" source for the offline ambient music channel.
 */

const MUTE_KEY = 'doneline.muted'
let muted = localStorage.getItem(MUTE_KEY) === '1'

export function isMuted(): boolean {
  return muted
}
export function setMuted(v: boolean): void {
  muted = v
  localStorage.setItem(MUTE_KEY, v ? '1' : '0')
}

let _ctx: AudioContext | null = null
function ctx(): AudioContext | null {
  try {
    const Ctor =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    if (!_ctx) _ctx = new Ctor()
    if (_ctx.state === 'suspended') _ctx.resume().catch(() => {})
    return _ctx
  } catch {
    return null
  }
}

function tone(freq: number, start: number, dur: number, peak = 0.2, type: OscillatorType = 'sine'): void {
  const c = _ctx!
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(gain).connect(c.destination)
  osc.start(start)
  osc.stop(start + dur + 0.02)
}

/** Two-note chime — rising for focus, falling for break. */
export function playChime(kind: 'focus' | 'break' = 'focus'): void {
  if (muted) return
  const c = ctx()
  if (!c) return
  const notes = kind === 'focus' ? [523.25, 783.99] : [659.25, 440.0]
  notes.forEach((f, i) => tone(f, c.currentTime + i * 0.22, 0.45, 0.22))
}

/** Soft tick for the final seconds of a focus phase. */
export function playTick(): void {
  if (muted) return
  const c = ctx()
  if (!c) return
  tone(880, c.currentTime, 0.09, 0.12, 'triangle')
}

/** Satisfying upward ding when a todo is completed. */
export function playDing(): void {
  if (muted) return
  const c = ctx()
  if (!c) return
  tone(659.25, c.currentTime, 0.18, 0.18)
  tone(987.77, c.currentTime + 0.08, 0.25, 0.18)
}

/** Soft, low "pock" for button presses — gentle and unobtrusive. */
export function playClick(): void {
  if (muted) return
  const c = ctx()
  if (!c) return
  const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(240, t)
  osc.frequency.exponentialRampToValueAtTime(150, t + 0.09)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.05, t + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
  osc.connect(gain).connect(c.destination)
  osc.start(t)
  osc.stop(t + 0.15)
}

export interface RainHandle {
  setVolume: (v: number) => void
  stop: () => void
}

/** Continuous generated rain/white-noise ambience for the offline channel. */
export function startRain(volume: number): RainHandle | null {
  const c = ctx()
  if (!c) return null
  const bufferSize = 2 * c.sampleRate
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1
  const noise = c.createBufferSource()
  noise.buffer = buffer
  noise.loop = true
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.value = 1400
  const gain = c.createGain()
  gain.gain.value = volume * 0.5
  noise.connect(filter).connect(gain).connect(c.destination)
  noise.start()
  return {
    setVolume: (v) => {
      gain.gain.value = v * 0.5
    },
    stop: () => {
      try {
        noise.stop()
        noise.disconnect()
      } catch {
        /* already stopped */
      }
    }
  }
}
