import { ipcMain } from 'electron'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import type { CreateWebhookDTO, UpdateWebhookDTO, WebhookConfig } from '../../shared/types'

export function registerWebhooksIPC(): void {
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!(await loadToken())) return fallback
    try {
      return await fn()
    } catch (err) {
      console.error('[cloud]', (err as Error).message)
      return fallback
    }
  }

  ipcMain.handle('webhooks:list', async (_, appId: string) =>
    safe(() => cloudClient.listWebhooks(appId), [] as WebhookConfig[])
  )

  ipcMain.handle('webhooks:create', async (_, appId: string, data: CreateWebhookDTO) =>
    cloudClient.createWebhook(appId, data)
  )

  ipcMain.handle('webhooks:update', async (_, id: string, data: UpdateWebhookDTO) =>
    cloudClient.updateWebhook(id, data)
  )

  ipcMain.handle('webhooks:delete', async (_, id: string) => {
    await cloudClient.deleteWebhook(id)
  })

  ipcMain.handle('webhooks:rotate-secret', async (_, id: string) =>
    cloudClient.rotateWebhookSecret(id)
  )
}
