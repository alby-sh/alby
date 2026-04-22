import { ipcMain } from 'electron'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import type { CreateReleaseDTO, Release } from '../../shared/types'

export function registerReleasesIPC(): void {
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!(await loadToken())) return fallback
    try {
      return await fn()
    } catch (err) {
      console.error('[cloud]', (err as Error).message)
      return fallback
    }
  }

  ipcMain.handle('releases:list', async (_, appId: string) =>
    safe(() => cloudClient.listReleases(appId), [] as Release[])
  )

  ipcMain.handle('releases:create', async (_, appId: string, data: CreateReleaseDTO) =>
    cloudClient.createRelease(appId, data)
  )
}
