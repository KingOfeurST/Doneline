/** Wall-clock timer: delayed ticks and extra minutes never change time credited. */
export class FocusClock {
  private remainingMs: number
  private totalMs: number
  private elapsedMs = 0
  private recordedMs = 0
  private lastTick: number | null = null

  constructor(seconds: number) {
    this.remainingMs = this.totalMs = Math.max(0, seconds) * 1000
  }

  get running(): boolean { return this.lastTick !== null }
  get secondsLeft(): number { return Math.ceil(this.remainingMs / 1000) }
  get totalSeconds(): number { return Math.ceil(this.totalMs / 1000) }

  advance(now: number): number {
    if (this.lastTick !== null) {
      const elapsed = Math.min(this.remainingMs, Math.max(0, now - this.lastTick))
      this.remainingMs -= elapsed
      this.elapsedMs += elapsed
      this.lastTick = now
    }
    return this.secondsLeft
  }

  start(now: number): void {
    if (this.lastTick === null) this.lastTick = now
  }

  pause(now: number): number {
    this.advance(now)
    this.lastTick = null
    return this.secondsLeft
  }

  reset(seconds: number, running = false, now = Date.now()): void {
    this.remainingMs = this.totalMs = Math.max(0, seconds) * 1000
    this.elapsedMs = this.recordedMs = 0
    this.lastTick = running ? now : null
  }

  extend(seconds: number, now: number): number {
    this.advance(now)
    const next = Math.max(0, this.remainingMs + seconds * 1000)
    this.totalMs += next - this.remainingMs
    this.remainingMs = next
    return this.secondsLeft
  }

  /** Returning the same block twice must not create duplicate focus sessions. */
  takeRecordableSeconds(now: number): number {
    this.advance(now)
    const seconds = Math.floor((this.elapsedMs - this.recordedMs) / 1000)
    if (seconds < 60) return 0
    this.recordedMs += seconds * 1000
    return seconds
  }
}
