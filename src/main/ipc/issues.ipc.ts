import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import type Database from 'better-sqlite3'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import { IssuesRepo } from '../db/issues.repo'
import type { Issue, IssueEvent, IssueListFilters, UpdateIssueDTO, CreateIssueDTO } from '../../shared/types'

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

  ipcMain.handle('issues:create', async (_, appId: string, data: CreateIssueDTO) => {
    // Intentionally NO `safe` wrapper: the caller needs to see the server
    // error if the submit fails (validation, auth, 404 on old backend) so
    // the dialog can surface a useful message. Mirror the new row into
    // local cache so the issuer sees it instantly in "My reports".
    const i = await cloudClient.createIssue(appId, data)
    mirror(() => repo.upsertFromCloud(i))
    return i
  })

  ipcMain.handle('issues:list-mine', async (_, page = 1, perPage = 50) => {
    return safe(
      () => cloudClient.listMyIssues(page, perPage),
      { data: [], current_page: 1, last_page: 1, total: 0 }
    )
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

  /**
   * Generate (or refine) the AI analysis for an issue by spawning a local
   * `claude` CLI run with a carefully-framed prompt. The caller can supply
   * `extraInstruction` to iterate — e.g. the user typed "focus on the date
   * parser" and wants the analysis redone with that lens. The resulting
   * markdown is PATCHed back to the cloud and cached locally so every
   * device sees it.
   *
   * We use the CLI rather than the Anthropic SDK because:
   *   (a) The user's `claude` binary is already authenticated on the box,
   *       so there's no new API-key plumbing to build.
   *   (b) The same binary is what every `Fix with agent` run uses, so the
   *       personality of the analysis and the fix line up.
   * Errors bubble to the renderer so the UI can show "claude not found" /
   * "auth expired" guidance.
   */
  ipcMain.handle(
    'issues:generate-analysis',
    async (_, id: string, extraInstruction?: string): Promise<Issue> => {
      // Hydrate the issue from cloud so our prompt uses the most recent fields
      // (the user may have just edited description / kind in another tab).
      const detail = await cloudClient.getIssue(id)
      const i = detail.issue
      const kindLabel = i.kind === 'feature' ? 'FEATURE REQUEST' : 'BUG REPORT'
      const priorAnalysis = i.analysis?.trim()
      const latestEventSnippet = detail.latest_event
        ? `Latest event: ${JSON.stringify(detail.latest_event).slice(0, 4000)}`
        : ''

      const prompt = [
        `You are analyzing an Alby issue. Produce a concise, structured markdown breakdown.`,
        `Type: ${kindLabel}`,
        `Title: ${i.title}`,
        i.culprit ? `Culprit: ${i.culprit}` : '',
        i.description ? `User description: ${i.description}` : '',
        latestEventSnippet,
        priorAnalysis ? `\nPrior analysis draft (refine this, don't start over):\n${priorAnalysis}` : '',
        extraInstruction ? `\nThe user asked for this refinement: ${extraInstruction}` : '',
        '',
        i.kind === 'feature'
          ? 'Your output sections: ## Goal · ## Acceptance criteria · ## Suggested implementation plan · ## Files likely involved · ## Risks / open questions.'
          : 'Your output sections: ## Summary · ## Likely root cause · ## Reproduction steps · ## Fix plan · ## Files likely involved · ## Risks / open questions.',
        'Reply with ONLY the markdown analysis — no preamble, no code fences wrapping the whole thing.',
      ].filter(Boolean).join('\n')

      const analysis = await new Promise<string>((resolve, reject) => {
        execFile(
          'claude',
          ['-p', prompt, '--dangerously-skip-permissions'],
          { maxBuffer: 4 * 1024 * 1024, timeout: 180_000 },
          (err, stdout, stderr) => {
            if (err) {
              const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
                ? "The `claude` CLI isn't installed or isn't on this app's PATH. Install it from https://docs.anthropic.com/claude-code and make sure `claude --version` works in a terminal."
                : `claude CLI failed: ${(err as Error).message}${stderr ? `\n${stderr.trim()}` : ''}`
              reject(new Error(msg))
              return
            }
            resolve(stdout.trim())
          }
        )
      })

      const updated = await cloudClient.updateIssue(id, { analysis })
      mirror(() => repo.upsertFromCloud(updated))
      return updated
    }
  )
}
