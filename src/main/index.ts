import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'

// The app and the MCP server share one DB. Both default to ~/.doneline (see
// core/paths.ts). Override with the DONELINE_DIR env var if you want it elsewhere
// — just set the same value for both processes.

import { registerIpc } from './ipc.js'
import { startNotifications, stopNotifications } from './notifications.js'
import {
  initDb,
  closeDb,
  cloudSync,
  isCloud,
  syncCalendar,
  getCalDavConfig,
  listPeople
} from '../../core/index.js'

let mainWindow: BrowserWindow | null = null
let syncTimer: NodeJS.Timeout | null = null

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
      if (synced) mainWindow?.webContents.send('workspace:changed')
    } catch (err) {
      console.error('[doneline] background sync failed:', err)
    }
  }, 8000)
}

app.whenReady().then(async () => {
  await initDb() // open + (cloud) pull + migrate
  registerIpc(() => startCloudSyncLoop())
  createWindow()
  startCloudSyncLoop()
  startNotifications(() => mainWindow)

  // Sync each person's Apple Calendar on launch (best effort).
  for (const person of listPeople()) {
    if (getCalDavConfig(person.id)) {
      syncCalendar(person.id).catch((err) =>
        console.error(`[doneline] startup calendar sync failed for ${person.name}:`, err)
      )
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (syncTimer) clearInterval(syncTimer)
    stopNotifications()
    closeDb()
    app.quit()
  }
})

app.on('before-quit', () => {
  if (syncTimer) clearInterval(syncTimer)
  stopNotifications()
  closeDb()
})
