import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { saveToken, loadToken, clearToken } from '../auth/keychain'
import {
  runOAuthLoopback,
  emailRegister,
  emailLogin,
  verifyOtp,
  fetchMe,
  logout as apiLogout
} from '../auth/oauth-loopback'
import { migrateLocalDataToCloud } from '../cloud/migration'
import { ALBY_BASE_URL } from '../../shared/cloud-constants'

async function runMigration(db: Database.Database, win: BrowserWindow | null): Promise<void> {
  console.log('[auth] kicking off cloud migration')
  try {
    const result = await migrateLocalDataToCloud(db, win?.webContents)
    console.log('[migration] done:', result)
    if (result.migrated) {
      win?.webContents.send('migration:complete', result.counts)
    }
  } catch (err) {
    console.error('[migration] failed:', (err as Error).message, (err as Error).stack)
  }
}

export function registerAuthIPC(db: Database.Database, getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('auth:current', async () => {
    const token = await loadToken()
    if (!token) return null
    try {
      const me = await fetchMe(token)
      // Best-effort: ensure local data is migrated on every authed boot
      // (migrateLocalDataToCloud is a no-op after the first successful run).
      runMigration(db, getMainWindow())
      return { token, ...me }
    } catch {
      // Stale token — wipe it so the user gets the LoginScreen.
      await clearToken()
      return null
    }
  })

  ipcMain.handle('auth:oauth', async (_evt, provider: 'google' | 'microsoft') => {
    const result = await runOAuthLoopback(provider)
    await saveToken(result.token)
    const me = await fetchMe(result.token)
    runMigration(db, getMainWindow())
    return { token: result.token, ...me }
  })

  ipcMain.handle('auth:register', async (_evt, payload: { email: string; password: string; name: string }) => {
    await emailRegister(payload.email, payload.password, payload.name)
    return { ok: true }
  })

  ipcMain.handle('auth:verify-otp', async (_evt, payload: { email: string; code: string }) => {
    const result = await verifyOtp(payload.email, payload.code)
    await saveToken(result.token)
    const me = await fetchMe(result.token)
    runMigration(db, getMainWindow())
    return { token: result.token, ...me }
  })

  ipcMain.handle('auth:login-email', async (_evt, payload: { email: string; password: string }) => {
    const result = await emailLogin(payload.email, payload.password)
    await saveToken(result.token)
    const me = await fetchMe(result.token)
    runMigration(db, getMainWindow())
    return { token: result.token, ...me }
  })

  ipcMain.handle('auth:logout', async () => {
    const token = await loadToken()
    if (token) await apiLogout(token)
    await clearToken()
    return { ok: true }
  })

  ipcMain.handle('auth:set-current-team', async (_evt, teamId: string | null) => {
    const token = await loadToken()
    if (!token) return { ok: false }
    await fetch(`${ALBY_BASE_URL}/api/auth/current-team`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ team_id: teamId })
    })
    return { ok: true }
  })
}

// Helper for other main-process modules that need the active token.
export async function currentToken(): Promise<string | null> {
  return loadToken()
}

// Helper to forward auth events to renderer if needed (future).
export function notifyAuthChange(win: BrowserWindow | null, change: 'logged-in' | 'logged-out'): void {
  win?.webContents.send('auth:changed', { change })
}
