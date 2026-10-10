import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { UpdateStatus } from '../shared/api.js'

const RELEASES_URL = 'https://github.com/KingOfeurST/Doneline/releases/latest'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const execute = promisify(execFile)

/** An ad-hoc or unsigned bundle cannot establish the identity Squirrel needs. */
export function hasDeveloperIdSignature(output: string): boolean {
  return /^Authority=Developer ID Application:.+$/m.test(output) &&
    /^TeamIdentifier=(?!not set\s*$)[A-Z0-9]{10}\s*$/m.test(output)
}

export async function detectMacAutoInstall(execPath: string): Promise<boolean> {
  const bundle = resolve(dirname(execPath), '..', '..')
  try {
    const options = { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true }
    const { stderr } = await execute('/usr/bin/codesign', ['-d', '--verbose=4', bundle], options)
    if (!hasDeveloperIdSignature(stderr)) return false
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], options)
    return true
  } catch { return false }
}

interface UpdaterPort {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<{
    isUpdateAvailable?: boolean
    updateInfo?: { version: string }
    downloadPromise?: Promise<unknown> | null
  } | null>
  quitAndInstall(): void
}

interface UpdateDependencies {
  updater: UpdaterPort
  isPackaged: boolean
  platform: NodeJS.Platform
  detectMacAutoInstall?: () => Promise<boolean>
  openExternal: (url: string) => Promise<unknown>
  emit: (status: UpdateStatus) => void
  setQuitting?: (quitting: boolean) => void
  prepareForInstall?: () => Promise<void>
  schedule?: (callback: () => void, milliseconds: number) => () => void
}

/** Owns update state independently of whether the Settings view is mounted. */
export class UpdateController {
  private current: UpdateStatus = { state: 'idle', canAutoInstall: false }
  private initialized: Promise<void> | null = null
  private checking: Promise<UpdateStatus> | null = null
  private stopTimer: (() => void) | null = null
  private disposed = false
  private readyToInstall = false
  private installRequested = false
  private listeners: Array<[string, (...args: any[]) => void]> = []

  constructor(private readonly dependencies: UpdateDependencies) {
    const listen = (event: string, listener: (...args: any[]) => void) => {
      dependencies.updater.on(event, listener)
      this.listeners.push([event, listener])
    }
    listen('checking-for-update', () => this.publish('checking'))
    listen('update-available', (info: { version: string }) => this.publish('available', { version: info.version }))
    listen('update-not-available', () => this.publish('not-available'))
    listen('download-progress', (progress: { percent: number }) => {
      this.publish('downloading', { version: this.current.version, percent: Math.round(progress.percent) })
    })
    listen('update-downloaded', (info: { version: string }) => {
      this.readyToInstall = this.current.canAutoInstall
      this.publish('downloaded', { version: info.version })
    })
    listen('error', (error: unknown) => this.fail(error))
  }

  private initialize(): Promise<void> {
    if (!this.initialized) {
      this.initialized = (async () => {
        const { platform, isPackaged, updater, detectMacAutoInstall } = this.dependencies
        let canAutoInstall = isPackaged && platform === 'win32'
        if (isPackaged && platform === 'darwin') {
          try { canAutoInstall = await detectMacAutoInstall?.() ?? false } catch { canAutoInstall = false }
        }
        updater.autoDownload = canAutoInstall
        updater.autoInstallOnAppQuit = canAutoInstall
        this.current = { state: isPackaged ? 'idle' : 'dev', canAutoInstall }
      })()
    }
    return this.initialized
  }

  async status(): Promise<UpdateStatus> {
    await this.initialize()
    return { ...this.current }
  }

  async start(): Promise<void> {
    await this.initialize()
    if (this.disposed || !this.dependencies.isPackaged || this.stopTimer) return
    const schedule = this.dependencies.schedule ?? ((callback, milliseconds) => {
      const timer = setInterval(callback, milliseconds)
      timer.unref()
      return () => clearInterval(timer)
    })
    this.stopTimer = schedule(() => { void this.check() }, CHECK_INTERVAL)
    await this.check()
  }

  async check(): Promise<UpdateStatus> {
    await this.initialize()
    if (this.disposed || !this.dependencies.isPackaged) return { ...this.current }
    if (this.checking) return this.checking
    if (['downloading', 'downloaded', 'installing'].includes(this.current.state)) return { ...this.current }
    const operation = this.runCheck()
    this.checking = operation
    try { return await operation } finally { if (this.checking === operation) this.checking = null }
  }

  private async runCheck(): Promise<UpdateStatus> {
    this.publish('checking')
    try {
      const result = await this.dependencies.updater.checkForUpdates()
      // checkForUpdates resolves before download finishes. Consume that rejection too.
      if (result?.downloadPromise) void result.downloadPromise.catch((error) => this.fail(error))
      if (!result) this.fail(new Error('Updates are unavailable in this build.'))
      else if (this.current.state === 'checking') {
        this.publish(result.isUpdateAvailable ? 'available' : 'not-available',
          result.isUpdateAvailable ? { version: result.updateInfo?.version } : {})
      }
    } catch (error) { this.fail(error) }
    return { ...this.current }
  }

  async install(): Promise<void> {
    await this.initialize()
    if (this.disposed || !this.dependencies.isPackaged) throw new Error('Updates only work in the installed app.')
    if (!this.current.canAutoInstall) {
      try { await this.dependencies.openExternal(RELEASES_URL) }
      catch (error) { this.fail(error); throw error }
      return
    }
    if (this.installRequested) return
    if (!this.readyToInstall || this.current.state !== 'downloaded') throw new Error('Download an update before installing it.')
    this.installRequested = true
    try {
      // quitAndInstall closes windows before Electron emits before-quit.
      // Flush editors while their renderer and database are still available.
      await this.dependencies.prepareForInstall?.()
      if (this.disposed) return
      if (!this.installRequested || !this.readyToInstall || this.current.state !== 'downloaded') {
        throw new Error(this.current.message || 'The update is no longer ready to install.')
      }
      this.publish('installing', { version: this.current.version })
      this.dependencies.setQuitting?.(true)
      this.dependencies.updater.quitAndInstall()
    }
    catch (error) { this.fail(error); throw error }
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.readyToInstall = false
    if (this.installRequested) this.dependencies.setQuitting?.(false)
    this.installRequested = false
    const message = error instanceof Error ? error.message : String(error)
    this.publish('error', { message })
  }

  private publish(state: UpdateStatus['state'], extra: Partial<UpdateStatus> = {}): void {
    if (this.disposed) return
    this.current = { state, canAutoInstall: this.current.canAutoInstall, ...extra }
    this.dependencies.emit({ ...this.current })
  }

  dispose(): void {
    this.disposed = true
    this.stopTimer?.()
    this.stopTimer = null
    for (const [event, listener] of this.listeners) this.dependencies.updater.removeListener(event, listener)
    this.listeners = []
  }
}
