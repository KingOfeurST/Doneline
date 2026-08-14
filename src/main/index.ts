import { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain } from 'electron'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
import { CH, EVT } from '../shared/channels.js'

const { autoUpdater } = electronUpdater

type UpdateState = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
function sendUpdateStatus(state: UpdateState, extra: Record<string, unknown> = {}): void {
  mainWindow?.webContents.send(EVT.updateStatus, { state, ...extra })
}

function setupAutoUpdate(): void {
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
  autoUpdater.on('update-available', (i) => sendUpdateStatus('available', { version: i.version }))
  autoUpdater.on('update-not-available', () => sendUpdateStatus('not-available'))
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (i) => sendUpdateStatus('downloaded', { version: i.version }))
  autoUpdater.on('error', (e) => sendUpdateStatus('error', { message: String(e?.message ?? e) }))
}

// The app and the MCP server share one DB. Both default to ~/.doneline (see
// core/paths.ts). Override with the DONELINE_DIR env var if you want it elsewhere
// — just set the same value for both processes.

import { registerIpc } from './ipc.js'
import { startNotifications, stopNotifications, notifyIncomingNudges, notifyIncomingInvites, notifyNewReactions } from './notifications.js'
import {
  initDb,
  closeDb,
  cloudSync,
  isCloud,
  syncCalendar,
  getCalDavConfig,
  listPeople,
  runMaintenance
} from '../../core/index.js'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let syncTimer: NodeJS.Timeout | null = null
let maintenanceTimer: NodeJS.Timeout | null = null

function showWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  return `${m}:${String(seconds % 60).padStart(2, '0')}`
}

function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
}

function createTray(): void {
  try {
    let img = nativeImage.createFromPath(trayIconPath())
    if (img.isEmpty()) return // no icon available — skip the tray rather than crash
    img = img.resize({ width: 18, height: 18 })
    tray = new Tray(img)
    tray.setToolTip('Doneline')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Doneline', click: showWindow },
        {
          label: 'New todo',
          click: () => {
            showWindow()
            mainWindow?.webContents.send('tray:new-todo')
          }
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            isQuitting = true
            app.quit()
          }
        }
      ])
    )
    tray.on('click', showWindow)
  } catch (err) {
    console.error('[doneline] tray init failed:', err)
  }
}

/**
 * MSN-style buzz: shake the window with a decaying oscillation, flash the
 * taskbar entry, and bring it to the front. Restores the original position when
 * done, and refuses to overlap with a shake already in flight.
 */
let shaking = false
function buzzWindow(): void {
  const w = mainWindow
  if (!w || w.isDestroyed() || shaking) return
  shaking = true

  if (w.isMinimized()) w.restore()
  w.show()
  w.flashFrame(true)

  const [originX, originY] = w.getPosition()
  const DURATION = 600
  const STEP = 16
  const AMPLITUDE = 14
  const started = Date.now()

  const timer = setInterval(() => {
    const elapsed = Date.now() - started
    if (elapsed >= DURATION || w.isDestroyed()) {
      clearInterval(timer)
      if (!w.isDestroyed()) {
        w.setPosition(originX, originY)
        w.flashFrame(false)
      }
      shaking = false
      return
    }
    // Amplitude decays linearly to zero so the shake settles instead of cutting off.
    const decay = 1 - elapsed / DURATION
    const offset = Math.round(Math.sin(elapsed / 22) * AMPLITUDE * decay)
    w.setPosition(originX + offset, originY)
  }, STEP)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 720,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#d6ecf7',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Closing the window hides it to the tray (so the focus timer keeps running);
  // real quit comes from the tray's Quit item. Only do this when a tray exists,
  // otherwise the window would vanish with no way to reopen it.
  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Periodically pull the shared workspace and tell the renderer to refresh. */
function startCloudSyncLoop(): void {
  if (syncTimer) clearInterval(syncTimer)
  if (!isCloud()) return
  syncTimer = setInterval(async () => {
    try {
      const synced = await cloudSync()
      if (synced) {
        if (notifyIncomingNudges(() => mainWindow)) buzzWindow()
        notifyIncomingInvites(() => mainWindow)
        notifyNewReactions(() => mainWindow)
        mainWindow?.webContents.send('workspace:changed')
      }
    } catch (err) {
      console.error('[doneline] background sync failed:', err)
    }
  }, 8000)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null) // hide the default File/Edit/View/Window/Help bar
  await initDb() // open + (cloud) pull + migrate
  try {
    runMaintenance() // generate recurring instances, archive + purge done todos
  } catch (err) {
    console.error('[doneline] maintenance failed:', err)
  }
  registerIpc(() => startCloudSyncLoop())
  ipcMain.handle(CH.toggleFullscreen, () => {
    if (!mainWindow) return false
    const fs = !mainWindow.isFullScreen()
    mainWindow.setFullScreen(fs)
    return fs
  })
  // Live focus timer in the tray tooltip (and the menu-bar title on macOS).
  ipcMain.on(CH.focusTray, (_e, state: { running: boolean; phase: 'focus' | 'break'; secondsLeft: number } | null) => {
    if (!tray) return
    if (state) {
      const label = `${state.phase === 'focus' ? 'Focus' : 'Break'} ${clock(state.secondsLeft)}`
      tray.setToolTip(`Doneline · ${label}`)
      if (process.platform === 'darwin') tray.setTitle(` ${clock(state.secondsLeft)}`)
    } else {
      tray.setToolTip('Doneline')
      if (process.platform === 'darwin') tray.setTitle('')
    }
  })
  createWindow()
  createTray()
  startCloudSyncLoop()
  startNotifications(() => mainWindow)

  // Re-run maintenance hourly (covers day rollovers while the app stays open).
  maintenanceTimer = setInterval(() => {
    try {
      runMaintenance()
      mainWindow?.webContents.send('workspace:changed')
    } catch (err) {
      console.error('[doneline] maintenance failed:', err)
    }
  }, 3_600_000)

  // Sync each person's Apple Calendar on launch (best effort).
  for (const person of listPeople()) {
    if (getCalDavConfig(person.id)) {
      syncCalendar(person.id).catch((err) =>
        console.error(`[doneline] startup calendar sync failed for ${person.name}:`, err)
      )
    }
  }

  // Auto-update from GitHub Releases (packaged builds only). Notifies and
  // installs on quit when a newer version is published.
  setupAutoUpdate()
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((err) =>
      console.error('[doneline] update check failed:', err)
    )
  }

  ipcMain.handle(CH.appVersion, () => app.getVersion())
  ipcMain.handle(CH.appPlatform, () => process.platform)
  ipcMain.handle(CH.windowBuzz, () => buzzWindow())
  ipcMain.handle(CH.updateCheck, async () => {
    if (!app.isPackaged) return { state: 'dev' as const }
    try {
      await autoUpdater.checkForUpdates()
      return { state: 'checking' as const }
    } catch (err) {
      return { state: 'error' as const, message: String(err) }
    }
  })
  ipcMain.handle(CH.updateInstall, () => {
    if (process.platform === 'darwin') {
      // macOS requires code signing for auto-install — open the releases page instead.
      shell.openExternal('https://github.com/KingOfeurST/Doneline/releases/latest')
      return
    }
    isQuitting = true
    autoUpdater.quitAndInstall()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// With a tray, closing the window is prevented (hidden) so this won't fire until
// a real quit. Without a tray, fall back to normal quit-on-close (non-mac).
app.on('window-all-closed', () => {
  if (isQuitting || process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  if (syncTimer) clearInterval(syncTimer)
  if (maintenanceTimer) clearInterval(maintenanceTimer)
  stopNotifications()
  closeDb()
  tray?.destroy()
})
