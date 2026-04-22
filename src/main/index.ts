import { app, BrowserWindow, dialog, ipcMain, Notification as ElectronNotification, shell, powerMonitor } from 'electron'
import { join } from 'path'
import { initDatabase } from './db'
import { registerProjectsIPC } from './ipc/projects.ipc'
import { registerSSHIPC } from './ipc/ssh.ipc'
import { registerAgentsIPC } from './ipc/agents.ipc'
import { registerRoutinesIPC } from './ipc/routines.ipc'
import { registerSettingsIPC } from './ipc/settings.ipc'
import { registerAuthIPC } from './ipc/auth.ipc'
import { registerTeamsIPC } from './ipc/teams.ipc'
import { registerDeployIPC } from './ipc/deploy.ipc'
import { registerAppsIPC } from './ipc/apps.ipc'
import { registerIssuesIPC } from './ipc/issues.ipc'
import { registerReleasesIPC } from './ipc/releases.ipc'
import { registerWebhooksIPC } from './ipc/webhooks.ipc'
import { registerNotificationSubsIPC } from './ipc/notification-subs.ipc'
import { AgentManager } from './agents/agent-manager'
import { RoutineManager } from './agents/routine-manager'
import { ConnectionPool } from './ssh/connection-pool'
import { ProjectsRepo } from './db/projects.repo'
import { initAutoUpdater } from './updater'
import { initErrorReporting } from './error-reporting'
import { installCertPinning } from './security/cert-pinning'
import { Alby } from '@alby-sh/report'
import type { Environment } from '../shared/types'

let mainWindow: BrowserWindow | null = null
let agentManager: AgentManager
let routineManager: RoutineManager
let connectionPool: ConnectionPool

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Alby',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#0f0f0f',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    hasShadow: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Sandbox the renderer process via Chromium's standard sandbox. Our
      // preload uses only contextBridge + ipcRenderer, both sandbox-safe;
      // every privileged operation goes through main via IPC.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Prevent background throttling so terminals stay responsive
  mainWindow.webContents.backgroundThrottling = false

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

// Alby issue detector — initialized as early as possible so uncaught
// exceptions and unhandled rejections from startup code are captured. The
// SDK auto-registers handlers for process-level events in the main process;
// renderer errors are forwarded over IPC by initErrorReporting() below.
// The `environment` tag comes from ALBY_ENVIRONMENT so dev / staging /
// prod each land under their own bucket in the Alby dashboard. See the
// "Monitoring" section in README.md for the contract.
Alby.init({
  dsn: 'https://SJfWXxRA26eVC61FtzscYgQMpEmC9IDWpXrWCB48@alby.sh/ingest/v1/a196e207-a35e-414b-8858-a31b07eec06c',
  environment: process.env.ALBY_ENVIRONMENT ?? 'development',
  release: app.getVersion(),
})

// Register the renderer → main error pipe. Alby.init() above already covers
// the main process; this adds coverage for anything thrown in the renderer.
initErrorReporting()

// One-shot end-to-end delivery check so the Alby app can confirm the
// detector is wired correctly. Safe to leave in — Alby's dashboard will
// show it as a single "message" event tagged with the current release.
Alby.captureMessage('Alby detector test event', 'info')

app.whenReady().then(() => {
  // Lock outbound TLS to our allowlisted hosts before anything else kicks
  // off a network request. Must run after `whenReady` because the default
  // session only exists then.
  installCertPinning()

  const db = initDatabase()
  // Backfill the protected "general" task for environments created before this
  // concept existed — so every env now has a safe default launch target.
  new ProjectsRepo(db).ensureGeneralTaskForAllEnvironments()
  connectionPool = new ConnectionPool()
  agentManager = new AgentManager(db, connectionPool)
  routineManager = new RoutineManager(db, connectionPool)

  registerProjectsIPC(db)
  registerSSHIPC(db, connectionPool)
  registerAgentsIPC(db, agentManager)
  registerRoutinesIPC(db, routineManager)
  registerSettingsIPC(db)
  registerAuthIPC(db, () => mainWindow)
  registerTeamsIPC()
  registerDeployIPC(db, connectionPool, () => mainWindow)
  registerAppsIPC(db)
  registerIssuesIPC(db)
  registerReleasesIPC()
  registerWebhooksIPC()
  registerNotificationSubsIPC()
  initAutoUpdater(() => mainWindow)

  // Bring the window to the foreground when the renderer asks (e.g. user
  // clicks a native issue notification while Alby is in the background).
  ipcMain.handle('app:focus', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    app.focus({ steal: true })
  })

  // Issue / regression notifications fired from the renderer's Reverb handler.
  // We do them here (main process) rather than via the DOM Notification API
  // because the DOM version (a) depends on a permission dance that swallows
  // the first event, (b) silently no-ops when devtools aren't open in some
  // Electron versions, and (c) requires focus-gating to avoid spam which in
  // turn hides the very alert the user is trying to test. The Electron
  // Notification class runs against the system Notification Center directly
  // and needs no user permission for signed/notarized apps.
  ipcMain.handle(
    'notifications:issue',
    (_e, payload: { title: string; body: string; tag?: string }) => {
      if (!ElectronNotification.isSupported()) return
      const n = new ElectronNotification({
        title: payload.title,
        body: payload.body,
        silent: false,
      })
      n.on('click', () => {
        if (!mainWindow) return
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
        app.focus({ steal: true })
      })
      n.show()
    },
  )

  // Folder picker for the "Local environment" path field.
  ipcMain.handle('dialog:pick-folder', async (_e, title?: string) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Select project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // Forward connection status events to renderer
  connectionPool.on('disconnected', (envId: string) => {
    mainWindow?.webContents.send('ssh:connection-status-changed', { envId, connected: false })
  })
  connectionPool.on('reconnected', (envId: string) => {
    mainWindow?.webContents.send('ssh:connection-status-changed', { envId, connected: true })
  })

  createWindow()

  // Reconnect agents that were running when the app last closed
  if (mainWindow) {
    mainWindow.webContents.on('did-finish-load', () => {
      agentManager.reconnectRunningAgents(mainWindow!).catch((err) => {
        console.error('[main] Failed to reconnect agents:', err)
      })
      routineManager.reconnectAll(mainWindow!).catch((err) => {
        console.error('[main] Failed to reconnect routines:', err)
      })
    })
  }

  // Pre-warm SSH pool: open a connection to every remote environment in the background
  // so the first terminal/Claude launch doesn't pay the SSH handshake (1-3s).
  try {
    const envs = db
      .prepare(
        `SELECT * FROM environments WHERE execution_mode = 'remote'`
      )
      .all() as Environment[]
    for (const env of envs) {
      connectionPool.connect(env).catch((err) => {
        console.warn(`[main] Pre-warm SSH failed for ${env.ssh_host}:`, (err as Error).message)
      })
    }
  } catch (err) {
    console.warn('[main] SSH pre-warm skipped:', (err as Error).message)
  }

  // Reconnect all SSH when system wakes from sleep
  powerMonitor.on('resume', () => {
    console.log('[main] System resumed from sleep — reconnecting SSH')
    connectionPool.forceReconnectAll()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  // Detach from tmux sessions — they keep running on the remote servers
  agentManager?.detachAll()
  routineManager?.detachAll()
  connectionPool?.closeAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
