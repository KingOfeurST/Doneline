/** Focus-mode audio: streamed lo-fi/ambient channels + a generated phase chime. */

export interface Channel {
  id: string
  name: string
  desc: string
  url: string
}

/**
 * Curated SomaFM channels (listener-supported netradio with stable public stream
 * URLs). Shown with a "Powered by SomaFM" credit in the UI.
 */
export const CHANNELS: Channel[] = [
  { id: 'groovesalad', name: 'Groove Salad', desc: 'chilled ambient / downtempo', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { id: 'dronezone', name: 'Drone Zone', desc: 'deep ambient space', url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { id: 'fluid', name: 'Fluid', desc: 'instrumental hip-hop / lo-fi', url: 'https://ice1.somafm.com/fluid-128-mp3' },
  { id: 'lush', name: 'Lush', desc: 'mellow vocals, calm', url: 'https://ice1.somafm.com/lush-128-mp3' },
  { id: 'thetrip', name: 'The Trip', desc: 'mellow electronica', url: 'https://ice1.somafm.com/thetrip-128-mp3' }
]

export function channelById(id: string): Channel {
  return CHANNELS.find((c) => c.id === id) ?? CHANNELS[0]
}

/**
 * Play a soft two-note chime via the Web Audio API (no audio files needed, works
 * offline). Best-effort: silently does nothing if Web Audio is unavailable.
 */
export function playChime(kind: 'focus' | 'break' = 'focus'): void {
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    // Rising for focus (back to work), falling for break (relax).
    const notes = kind === 'focus' ? [523.25, 783.99] : [659.25, 440.0]
    const now = ctx.currentTime
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const start = now + i * 0.22
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.04)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + 0.5)
    })
    // Let the notes finish, then release the context.
    window.setTimeout(() => ctx.close().catch(() => {}), 1200)
  } catch {
    /* no audio available — ignore */
  }
}
