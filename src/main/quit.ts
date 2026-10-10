import { randomUUID } from 'node:crypto'
import { EVT } from '../shared/channels.js'

export interface QuitWindow {
  isDestroyed(): boolean
  webContents: {
    id: number
    isDestroyed(): boolean
    send(channel: string, requestId: string): void
    session: { flushStorageData(): void }
  }
}

interface PendingQuit {
  senderId: number
  finish(error?: Error): void
}

/** A renderer must acknowledge its local writes before its window is destroyed. */
export class QuitCoordinator {
  private pending = new Map<string, PendingQuit>()
  private active: Promise<void> | null = null

  constructor(private timeoutMs = 5000) {}

  prepare(windows: QuitWindow[]): Promise<void> {
    if (this.active) return this.active
    const current = Promise.all(windows.filter(window => !window.isDestroyed())
      .map(window => this.prepareWindow(window))).then(() => {})
    this.active = current
    const clear = () => { if (this.active === current) this.active = null }
    current.then(clear, clear)
    return current
  }

  acknowledge(senderId: number, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return
    const { requestId, error } = payload as { requestId?: unknown; error?: unknown }
    if (typeof requestId !== 'string') return
    const request = this.pending.get(requestId)
    if (!request || request.senderId !== senderId) return
    request.finish(typeof error === 'string'
      ? new Error(error.slice(0, 1000) || 'A note could not be saved.')
      : undefined)
  }

  private prepareWindow(window: QuitWindow): Promise<void> {
    const contents = window.webContents
    if (contents.isDestroyed()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const requestId = randomUUID()
      const timer = setTimeout(() => finish(new Error('Saving notes took too long. Please try quitting again.')), this.timeoutMs)
      const finish = (error?: Error) => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timer)
        // Persist recovery drafts as well as the acknowledged SQLite write.
        try { contents.session.flushStorageData() } catch { /* A closed session cannot be flushed. */ }
        if (error) reject(error)
        else resolve()
      }
      this.pending.set(requestId, { senderId: contents.id, finish })
      try { contents.send(EVT.prepareQuit, requestId) }
      catch (error) { finish(error instanceof Error ? error : new Error('Could not contact the note editor.')) }
    })
  }
}
