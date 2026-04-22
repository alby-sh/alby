import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { AlbyClient } from '@alby-sh/report'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import { AppsRepo } from '../db/apps.repo'
import type { CreateAppDTO, ReportingApp, UpdateAppDTO } from '../../shared/types'

export function registerAppsIPC(db: Database.Database): void {
  const repo = new AppsRepo(db)

  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!(await loadToken())) return fallback
    try {
      return await fn()
    } catch (err) {
      console.error('[cloud]', (err as Error).message)
      return fallback
    }
  }
  const mirror = (fn: () => void): void => {
    try { fn() } catch (err) { console.warn('[cache mirror]', (err as Error).message) }
  }

  ipcMain.handle('apps:list', async (_, projectId: string) => {
    const list = await safe(() => cloudClient.listApps(projectId), [] as ReportingApp[])
    mirror(() => repo.replaceAllForProject(projectId, list))
    return list
  })

  ipcMain.handle('apps:get', async (_, id: string) => {
    const a = await safe(() => cloudClient.getApp(id), null as ReportingApp | null)
    if (a) mirror(() => repo.upsertFromCloud(a))
    return a
  })

  ipcMain.handle('apps:create', async (_, projectId: string, data: CreateAppDTO) => {
    const a = await cloudClient.createApp(projectId, data)
    mirror(() => repo.upsertFromCloud(a))
    return a
  })

  ipcMain.handle('apps:update', async (_, id: string, data: UpdateAppDTO) => {
    const a = await cloudClient.updateApp(id, data)
    mirror(() => repo.upsertFromCloud(a))
    return a
  })

  ipcMain.handle('apps:delete', async (_, id: string) => {
    await cloudClient.deleteApp(id)
    mirror(() => repo.delete(id))
  })

  ipcMain.handle('apps:rotate-key', async (_, id: string) => {
    const a = await cloudClient.rotateAppKey(id)
    mirror(() => repo.upsertFromCloud(a))
    return a
  })

  // Throws a real synthetic error and runs it through the SDK's
  // captureException — identical code path to a production crash (stack
  // frames, exception type, etc.), so the resulting Issue in Alby looks
  // like the real thing instead of a synthetic message. Uses a fresh
  // AlbyClient so it doesn't collide with the desktop app's own reporting
  // singleton.
  ipcMain.handle(
    'apps:send-test-event',
    async (
      _,
      { dsn, environment }: { dsn: string; environment?: string },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        const client = new AlbyClient({
          dsn,
          environment: environment || 'development',
          release: 'alby-desktop-test',
          autoRegister: false,
        })
        try {
          const stamp = new Date().toISOString()
          // Throw + catch on purpose so V8 fills in a genuine stack trace
          // anchored at this call site. The SDK's exceptionFromError parser
          // turns that into the same wire shape a real crash would produce.
          throw new Error(
            `Alby detector test event — simulated crash from the desktop app at ${stamp}`,
          )
        } catch (simulated) {
          client.captureException(simulated)
        }
        const ok = await client.flush(5000)
        if (!ok) return { ok: false, error: 'Timed out waiting for the event to leave the app.' }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
