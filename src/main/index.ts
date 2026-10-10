import { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import electronUpdater from 'electron-updater'
import { CH, EVT } from '../shared/channels.js'
import { UpdateController, detectMacAutoInstall } from './updates.js'

const { autoUpdater } = electronUpdater

// An explicit override keeps fixture Chromium data separate from an installed profile.
if (process.env.DONELINE_USER_DATA_DIR) {
  const userData = resolve(process.env.DONELINE_USER_DATA_DIR)
  app.setPath('userData', userData)
  app.setPath('sessionData', userData)
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
  runMaintenance,
  localDay,
  queueCalendarSync
} from '../../core/index.js'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let syncTimer: NodeJS.Timeout | null = null
let maintenanceTimer: NodeJS.Timeout | null = null
let updates: UpdateController | null = null

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
      sandbox: true,
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
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'https:' || protocol === 'http:') void shell.openExternal(url).catch((error) => console.error('[doneline] open link failed:', error))
    } catch { /* Invalid URLs are never sent to the operating system. */ }
    return { action: 'deny' }
  })
  // External pages must never receive the privileged preload API.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const trusted = process.env.ELECTRON_RENDERER_URL
    try {
      if (trusted && new URL(url).origin === new URL(trusted).origin) return
    } catch { /* Block malformed navigation. */ }
    event.preventDefault()
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

  // Check day rollovers promptly, including after the computer wakes from sleep.
  let maintainedDay = localDay()
  let lastCalendarPull = Date.now()
  maintenanceTimer = setInterval(() => {
    try {
      const today = localDay()
      if (today !== maintainedDay) {
        runMaintenance()
        maintainedDay = today
        void cloudSync().catch(() => {})
        mainWindow?.webContents.send(EVT.workspaceChanged)
      }
      // Pending calendar changes are durable and get another try after outages.
      queueCalendarSync(undefined, () => {
        void cloudSync().catch(() => {})
        mainWindow?.webContents.send(EVT.workspaceChanged)
      })
      if (Date.now() - lastCalendarPull >= 300_000) {
        lastCalendarPull = Date.now()
        for (const person of listPeople()) {
          if (getCalDavConfig(person.id)) void syncCalendar(person.id)
            .then(() => { void cloudSync().catch(() => {}); mainWindow?.webContents.send(EVT.workspaceChanged) })
            .catch((err) => console.error('[doneline] calendar sync failed:', err))
        }
      }
    } catch (err) {
      console.error('[doneline] maintenance failed:', err)
    }
  }, 30_000)

  // Sync each person's Apple Calendar on launch (best effort).
  for (const person of listPeople()) {
    if (getCalDavConfig(person.id)) {
      syncCalendar(person.id).then(() => {
        void cloudSync().catch(() => {})
        mainWindow?.webContents.send(EVT.workspaceChanged)
      }).catch((err) =>
        console.error(`[doneline] startup calendar sync failed for ${person.name}:`, err)
      )
    }
  }

  updates = new UpdateController({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    platform: process.platform,
    detectMacAutoInstall: () => detectMacAutoInstall(process.execPath),
    openExternal: (url) => shell.openExternal(url),
    emit: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVT.updateStatus, status)
    },
    setQuitting: (quitting) => { isQuitting = quitting }
  })

  ipcMain.handle(CH.appVersion, () => app.getVersion())
  ipcMain.handle(CH.appPlatform, () => process.platform)
  ipcMain.handle(CH.updateStatus, () => updates!.status())
  ipcMain.handle(CH.updateCheck, () => updates!.check())
  ipcMain.handle(CH.updateInstall, () => updates!.install())
  void updates.start().catch((error) => console.error('[doneline] updater setup failed:', error))

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
  updates?.dispose()
  stopNotifications()
  closeDb()
  tray?.destroy()
})
