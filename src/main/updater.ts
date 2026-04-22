// Auto-update orchestration — polls GitHub Releases for new versions, downloads
// them in the background, and asks the user to restart when ready. Relies on
// electron-builder's `publish: github` config to locate latest-mac.yml.
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import pkg from 'electron-updater'

const { autoUpdater } = pkg

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000 // every 6h

let downloadedVersion: string | null = null
let checking = false

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('updater:get-version', () => app.getVersion())

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      return { status: 'dev', message: 'Updates only run in the packaged app.' }
    }
    if (downloadedVersion) {
      return { status: 'downloaded', version: downloadedVersion }
    }
    if (checking) {
      return { status: 'checking' }
    }
    checking = true
    try {
      const result = await autoUpdater.checkForUpdates()
      const remoteVersion = result?.updateInfo?.version
      if (!remoteVersion || remoteVersion === app.getVersion()) {
        return { status: 'up-to-date', version: app.getVersion() }
      }
      // A newer version exists — autoDownload is on, so it'll arrive via the
      // 'update-downloaded' event. Tell the renderer it's downloading now.
      return { status: 'downloading', version: remoteVersion }
    } catch (err) {
      return { status: 'error', message: (err as Error).message }
    } finally {
      checking = false
    }
  })

  ipcMain.handle('updater:install', () => {
    if (!downloadedVersion) return { ok: false, message: 'No update downloaded yet.' }
    autoUpdater.quitAndInstall()
    return { ok: true }
  })

  // In dev there's no app-update.yml so the updater would throw on first
  // check — skip the auto-poll wiring entirely when running from source.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err?.message || err)
  })

  autoUpdater.on('update-available', (info) => {
    console.log('[updater] update-available:', info.version)
    const win = getWindow()
    win?.webContents.send('updater:update-available', { version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] already on latest version')
  })

  autoUpdater.on('download-progress', (progress) => {
    const win = getWindow()
    win?.webContents.send('updater:download-progress', {
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[updater] update-downloaded:', info.version)
    downloadedVersion = info.version
    const win = getWindow()
    win?.webContents.send('updater:update-downloaded', { version: info.version })
  })

  // Initial check shortly after boot, then on interval.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000)
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS)
}
