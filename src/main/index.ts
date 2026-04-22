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

// In dev, point userData at a sibling directory so the packaged Alby and the
// dev instance don't share the same SQLite file, Reverb handshake state, or
// preferences. Sharing had two failure modes: (1) WAL-lock contention when
// both processes ran the agents table migration, and (2) settings written
// by one overriding the other at write time. Must run before app.whenReady.
if (process.defaultApp) {
  const { join } = require('path') as typeof import('path')
  app.setPath('userData', join(app.getPath('appData'), 'Alby Dev'))
}

// Deep-link queue — filled before the renderer (or the window itself) exists,
// drained as soon as the renderer signals it's ready via `deep-link:ready`.
// Covers three cold-start paths: macOS `open-url`, Windows/Linux argv on first
// launch, and Windows/Linux argv via `second-instance` for subsequent clicks.
const pendingDeepLinks: string[] = []

/**
 * Parse an `alby://issues/<uuid>` URL into an `{ issueId }` payload.
 * Returns null for anything that isn't on our scheme or doesn't match a
 * supported path. We stay strict on the path so unknown alby:// URLs don't
 * silently no-op — future deep-link kinds should extend this switch.
 */
function parseDeepLink(url: string): { kind: 'issue'; issueId: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'alby:') return null
    // `new URL('alby://issues/abc')` splits into host='issues', pathname='/abc'.
    // Tolerate either layout so the upstream landing page isn't locked into one.
    const host = parsed.host
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const parts = host ? [host, ...pathParts] : pathParts
    if (parts[0] === 'issues' && parts[1]) {
      return { kind: 'issue', issueId: decodeURIComponent(parts[1]) }
    }
    return null
  } catch {
    return null
  }
}

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  app.focus({ steal: true })
}

/**
 * Route an incoming deep-link URL. If the renderer isn't ready yet we queue
 * and let the `deep-link:ready` handshake drain the queue; otherwise we send
 * straight to the window and surface it.
 */
function handleDeepLinkUrl(url: string): void {
  const parsed = parseDeepLink(url)
  if (!parsed) return
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('deep-link:issue-open', { issueId: parsed.issueId })
    focusMainWindow()
  } else {
    pendingDeepLinks.push(url)
    if (mainWindow) focusMainWindow()
  }
}

/** Extract the first `alby://…` token from a process argv slice. */
function findDeepLinkInArgv(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith('alby://')) ?? null
}

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
      .catch((err) => console.error('[main] loadURL failed:', err))
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
      .catch((err) => console.error('[main] loadFile failed:', err))
  }

  // Surface load failures loudly — with vibrancy: 'under-window' a window
  // that hasn't painted content yet is effectively transparent, so a silent
  // dev-server miss looks like "Electron opens but the window is invisible".
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[main] did-fail-load code=${code} desc="${desc}" url=${url}`)
  })

  // Center + clamp the window into the currently-focused display on show.
  // Without this, macOS may restore bounds from a previous session on a
  // monitor that's no longer connected, leaving Electron alive with an
  // invisible window.
  const centerIfOffscreen = (): void => {
    if (!mainWindow) return
    // Lazy-require `screen` — the module needs app.whenReady().
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { screen } = require('electron') as typeof import('electron')
    const bounds = mainWindow.getBounds()
    const activeDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const work = activeDisplay.workArea
    const isOnScreen =
      bounds.x + bounds.width > work.x &&
      bounds.x < work.x + work.width &&
      bounds.y + bounds.height > work.y &&
      bounds.y < work.y + work.height
    if (!isOnScreen) mainWindow.center()
    console.log('[main] window shown; on-screen=', isOnScreen, 'bounds=', mainWindow.getBounds())
  }

  mainWindow.once('ready-to-show', () => {
    centerIfOffscreen()
    mainWindow?.show()
    mainWindow?.focus()
  })

  // Fallback: if ready-to-show never fires within 3 s (vite dev server slow
  // to respond, network stall, etc.), force the window visible so the user
  // at least sees a blank vibrancy pane + can inspect the console.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.warn('[main] ready-to-show never fired in 3s — forcing show')
      centerIfOffscreen()
      mainWindow.show()
      mainWindow.focus()
    }
  }, 3000)
}

// Single-instance lock — required for deep links on Windows/Linux, where a
// second `alby://` launch spawns a new process and we need to redirect the
// URL into the already-running one. On macOS the OS delivers URLs via the
// `open-url` event without a second process, but the lock is still safe
// (harmless no-op).
//
// Skip in dev so `npm run dev` can start with a packaged Alby already
// running from /Applications — otherwise the lock that the packaged app
// holds makes dev exit silently at launch with no visible error.
const gotSingleInstanceLock = process.defaultApp ? true : app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    focusMainWindow()
    const url = findDeepLinkInArgv(argv)
    if (url) handleDeepLinkUrl(url)
  })
}

// Register as the default handler for `alby://`. On dev, the executable is
// `electron` itself and we need to hand it the project path as an arg so the
// OS re-invokes us with the right script when a link is clicked.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('alby', process.execPath, [process.argv[1]])
  }
} else {
  app.setAsDefaultProtocolClient('alby')
}

// macOS delivers deep links through this event, not argv. It can fire before
// `whenReady`, so we register it at module load and route through the same
// queue as the other platforms.
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLinkUrl(url)
})

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

app.whenReady().then(() => {
  // Lock outbound TLS to our allowlisted hosts before anything else kicks
  // off a network request. Must run after `whenReady` because the default
  // session only exists then.
  installCertPinning()

  // Wrap DB init in a try/catch so a native-module arch mismatch (happens
  // when `npm run package` for x64 rebuilds better-sqlite3 as x86_64 and
  // overwrites the arm64 build used by dev) surfaces in the terminal
  // instead of silently leaving Electron alive with no window.
  let db: ReturnType<typeof initDatabase>
  try {
    db = initDatabase()
    new ProjectsRepo(db).ensureGeneralTaskForAllEnvironments()
  } catch (err) {
    console.error('[main] DB init failed:', (err as Error).stack ?? (err as Error).message)
    console.error('[main] Likely an arch-mismatched native module. Run `npx electron-rebuild`.')
    throw err
  }
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
    focusMainWindow()
  })

  // Broadcast auth proxy. In packaged builds the renderer can POST to
  // https://alby.sh/broadcasting/auth directly because the origin is
  // `file://` / `alby://` (no CORS check). In dev the origin is
  // http://localhost:5173 and Laravel's CORS config doesn't allow it, so
  // the fetch fails with "No Access-Control-Allow-Origin header". Routing
  // through the main process sidesteps the browser's CORS check entirely —
  // main-process fetch is a Node HTTP client, not a Chromium fetch.
  ipcMain.handle(
    'broadcast:authorize',
    async (_e, { token, socketId, channelName }: { token: string; socketId: string; channelName: string }) => {
      const { BROADCASTING_AUTH_URL } = await import('../shared/cloud-constants')
      const res = await fetch(BROADCASTING_AUTH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Bearer ${token}`,
        },
        body: new URLSearchParams({ socket_id: socketId, channel_name: channelName }).toString(),
      })
      if (!res.ok) throw new Error(`auth ${res.status}`)
      return (await res.json()) as Record<string, unknown>
    },
  )

  // Renderer handshake: once the app-level listener is mounted it calls this
  // to drain any URLs that arrived before it was listening (cold start on
  // Windows/Linux where the URL sits in argv, or a macOS open-url fired
  // before the window's did-finish-load).
  ipcMain.handle('deep-link:consume-pending', () => {
    const payloads = pendingDeepLinks
      .map((url) => parseDeepLink(url))
      .filter((p): p is { kind: 'issue'; issueId: string } => p !== null)
      .map((p) => ({ issueId: p.issueId }))
    pendingDeepLinks.length = 0
    return payloads
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
    (_e, payload: { title: string; body: string; tag?: string; issueId?: string }) => {
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
        // Reuse the existing deep-link channel so the renderer gets exactly
        // the same payload shape as an `alby://issues/<id>` click: both paths
        // land in `openIssueById` which selects the project + expands the
        // sidebar + opens the issue detail. No new renderer code needed.
        if (payload.issueId && !mainWindow.webContents.isLoading()) {
          mainWindow.webContents.send('deep-link:issue-open', { issueId: payload.issueId })
        } else if (payload.issueId) {
          pendingDeepLinks.push(`alby://issues/${payload.issueId}`)
        }
      })
      n.show()
    },
  )

  /**
   * Desktop notification for an agent transition (idle / completed). Clicking
   * it focuses Alby, navigates to the owning project's sidebar, and selects
   * the specific session so the user lands right on the output instead of
   * having to hunt for which env / task the agent belongs to.
   */
  ipcMain.handle(
    'notifications:agent',
    (_e, payload: { title: string; body: string; tag?: string; agentId: string; projectId: string }) => {
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
        mainWindow.webContents.send('notification:agent-click', {
          agentId: payload.agentId,
          projectId: payload.projectId,
        })
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

  // Cold-start deep-link on Windows/Linux: the URL arrives in our own argv
  // (on macOS the same click fires `open-url` instead, which we handle
  // above). Queue it so the renderer can drain it during its handshake.
  const coldStartUrl = findDeepLinkInArgv(process.argv)
  if (coldStartUrl) pendingDeepLinks.push(coldStartUrl)

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
