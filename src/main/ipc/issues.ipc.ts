import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import { IssuesRepo } from '../db/issues.repo'
import type { Issue, IssueEvent, IssueListFilters, UpdateIssueDTO } from '../../shared/types'

export function registerIssuesIPC(db: Database.Database): void {
  const repo = new IssuesRepo(db)

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

  ipcMain.handle('issues:list', async (_, appId: string, filters?: IssueListFilters) => {
    const page = await safe(
      () => cloudClient.listIssues(appId, filters),
      { data: [], current_page: 1, last_page: 1, total: 0 }
    )
    if (!filters || filters.page === 1 || filters.page === undefined) {
      mirror(() => repo.replaceAllForApp(appId, page.data))
    } else {
      page.data.forEach((i) => mirror(() => repo.upsertFromCloud(i)))
    }
    return page
  })

  ipcMain.handle('issues:get', async (_, id: string) => {
    const detail = await safe(
      () => cloudClient.getIssue(id),
      null as { issue: Issue; app: { id: string; name: string; platform: string }; latest_event: IssueEvent | null } | null
    )
    if (detail) mirror(() => repo.upsertFromCloud(detail.issue))
    return detail
  })

  ipcMain.handle('issue-events:list', async (_, id: string, page = 1, perPage = 25) => {
    return safe(
      () => cloudClient.listIssueEvents(id, page, perPage),
      { data: [], current_page: 1, last_page: 1, total: 0 }
    )
  })

  ipcMain.handle('issues:update', async (_, id: string, data: UpdateIssueDTO) => {
    const i = await cloudClient.updateIssue(id, data)
    mirror(() => repo.upsertFromCloud(i))
    return i
  })

  ipcMain.handle('issues:delete', async (_, id: string) => {
    await cloudClient.deleteIssue(id)
    mirror(() => repo.delete(id))
  })

  ipcMain.handle('issues:mint-resolve-url', async (_, id: string) => {
    return cloudClient.mintIssueResolveUrl(id)
  })

  /** Badge count for sidebar — reads straight from cache, no cloud call. */
  ipcMain.handle('issues:open-counts', async (_, appIds: string[]) => {
    const map = repo.openCountByApp(appIds)
    return Object.fromEntries(map.entries())
  })
}
