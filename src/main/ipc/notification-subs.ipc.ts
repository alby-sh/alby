import { ipcMain } from 'electron'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import type {
  NotificationSubscription,
  UpsertNotificationSubDTO,
  UserSlackWebhook,
} from '../../shared/types'

export function registerNotificationSubsIPC(): void {
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!(await loadToken())) return fallback
    try {
      return await fn()
    } catch (err) {
      console.error('[cloud]', (err as Error).message)
      return fallback
    }
  }

  ipcMain.handle('notification-subs:list', async (_, appId: string) =>
    safe(() => cloudClient.listNotifSubs(appId), [] as NotificationSubscription[])
  )

  ipcMain.handle('notification-subs:upsert', async (_, appId: string, data: UpsertNotificationSubDTO) =>
    cloudClient.upsertNotifSub(appId, data)
  )

  ipcMain.handle('notification-subs:delete', async (_, appId: string, userId: number) => {
    await cloudClient.deleteNotifSub(appId, userId)
  })

  // Per-user Slack incoming-webhook. Writes are self-only server-side; the
  // read helpers are used by the Alerts panel to show a presence dot next to
  // teammates who have a webhook configured.
  ipcMain.handle('slack-webhook:get', async () =>
    safe(() => cloudClient.getSlackWebhook(), null as UserSlackWebhook | null),
  )
  ipcMain.handle('slack-webhook:set', async (_, webhookUrl: string) =>
    cloudClient.setSlackWebhook(webhookUrl),
  )
  ipcMain.handle('slack-webhook:delete', async () => {
    await cloudClient.deleteSlackWebhook()
  })
  ipcMain.handle('slack-webhook:presence', async (_, userIds: number[]) =>
    safe(() => cloudClient.slackWebhookPresence(userIds), {} as Record<number, true>),
  )
}
