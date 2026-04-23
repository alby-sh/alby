import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import type Database from 'better-sqlite3'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import { IssuesRepo } from '../db/issues.repo'
import { ProjectsRepo } from '../db/projects.repo'
import type { ConnectionPool } from '../ssh/connection-pool'
import type { Issue, IssueEvent, IssueListFilters, UpdateIssueDTO, CreateIssueDTO, Environment } from '../../shared/types'

/** Escape a single argument for POSIX single-quoting: '…' with `'\''` for any
 *  embedded quote. Mirrors the helper used in ChatAgent. */
function sqEscape(s: string): string {
  return s.replace(/'/g, `'\\''`)
}

/** Pick the user's interactive shell. Falls back to /bin/zsh (macOS default
 *  since Catalina). Respecting $SHELL means the user's dotfiles — and in
 *  particular their PATH customisations (nvm, asdf, brew, ~/.local/bin) —
 *  are sourced, so `claude` / `gemini` / `codex` resolve the same way they
 *  do in Terminal.app. */
function pickShell(): string {
  const s = process.env.SHELL
  if (s && existsSync(s)) return s
  return '/bin/zsh'
}

interface RunResult { stdout: string; stderr: string; code: number }

/** Run `claude -p "<prompt>"` locally through a login+interactive shell.
 *  Used when no target env is configured or the target env is local —
 *  matches how ChatAgent spawns the same CLI so the user's full PATH is
 *  visible. */
function runClaudeLocal(prompt: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const shell = pickShell()
    const inner = `claude -p '${sqEscape(prompt)}' --dangerously-skip-permissions`
    const child = spawn(shell, ['-l', '-i', '-c', inner], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      reject(new Error('claude CLI timed out after 180s'))
    }, 180_000)
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8') })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ stdout, stderr, code: code ?? 0 })
    })
  })
}

/** Run `claude -p "<prompt>"` over SSH in the target env, sourcing the remote
 *  user's login shell so their PATH (nvm / asdf / brew / npm-global) is live.
 *  Used when the stack has an operational env configured — the user's issue
 *  detector is on that box, and so is their authenticated `claude` install. */
function runClaudeRemote(
  connectionPool: ConnectionPool,
  env: Environment,
  prompt: string
): Promise<RunResult> {
  return new Promise(async (resolve, reject) => {
    let client
    try {
      client = connectionPool.get(env.id) ?? (await connectionPool.getOrCreate(env))
    } catch (err) {
      reject(new Error(`SSH connect to ${env.name} failed: ${(err as Error).message}`))
      return
    }
    const cwd = env.remote_path || '~'
    const innerCmd =
      `cd '${sqEscape(cwd)}' && claude -p '${sqEscape(prompt)}' --dangerously-skip-permissions`
    const outer = `bash -l -c '${sqEscape(innerCmd)}'`
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`claude CLI on ${env.name} timed out after 180s`))
    }, 180_000)
    client.exec(outer, (err, channel) => {
      if (err) {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error(`ssh exec failed: ${err.message}`))
        return
      }
      channel.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      channel.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      channel.on('close', (code: number | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve({ stdout, stderr, code: code ?? 0 })
      })
    })
  })
}

/** Map `claude` exit-code 127 (the shell's "command not found") to a friendly
 *  error, same as the old ENOENT case — but scoped so the "install it" hint
 *  tells the user *where* the binary is missing (local Mac vs. their remote
 *  issue env). */
function notFoundMessage(location: string): string {
  return (
    `The \`claude\` CLI isn't installed or isn't on the PATH ${location}. ` +
    `Install it from https://docs.anthropic.com/claude-code and make sure ` +
    `\`claude --version\` works in an interactive shell ${location}.`
  )
}

export function registerIssuesIPC(db: Database.Database, connectionPool: ConnectionPool): void {
  const repo = new IssuesRepo(db)
  const projectsRepo = new ProjectsRepo(db)

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
   * Generate (or refine) the AI analysis for an issue by invoking the user's
   * `claude` CLI with a carefully-framed prompt. The caller can supply
   * `extraInstruction` to iterate — e.g. the user typed "focus on the date
   * parser" and wants the analysis redone with that lens. The resulting
   * markdown is PATCHed back to the cloud and cached locally so every
   * device sees it.
   *
   * Where claude runs:
   *   - If `envId` is provided and refers to a remote env, we run claude
   *     OVER SSH inside that env's `remote_path`, through `bash -l -c '…'`.
   *     This matches where `Fix with agent` would actually work, and it's
   *     the only place `claude` is reliably installed for users who don't
   *     have it on their local Mac.
   *   - If the env is local OR no env is passed, we spawn claude via the
   *     user's login+interactive shell (`$SHELL -l -i -c 'claude …'`) so
   *     nvm / brew / ~/.local/bin are on PATH — the raw `process.env.PATH`
   *     that a packaged Electron app inherits from launchd is
   *     `/usr/bin:/bin:/usr/sbin:/sbin`, which never contains `claude`.
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
    async (_, id: string, extraInstruction?: string, envId?: string): Promise<Issue> => {
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

      // Pick where to run: remote env (when its SSH host has the user's
      // authenticated `claude`), otherwise local. Deploy envs aren't
      // operational boxes, so skip them — fall back to local.
      const env = envId ? projectsRepo.getEnvironment(envId) : null
      const useRemote = !!env && env.execution_mode === 'remote' && env.role !== 'deploy'
      const location = useRemote ? `on ${env!.name}` : 'on this Mac'

      let result: RunResult
      try {
        result = useRemote
          ? await runClaudeRemote(connectionPool, env!, prompt)
          : await runClaudeLocal(prompt)
      } catch (err) {
        throw new Error(`claude CLI failed ${location}: ${(err as Error).message}`)
      }

      // Shells report 127 when the command isn't on PATH. Surface the same
      // "install it" guidance the old ENOENT branch used to, but pointing at
      // the right box.
      if (result.code === 127) {
        throw new Error(notFoundMessage(location))
      }
      if (result.code !== 0) {
        const tail = result.stderr.trim() || result.stdout.trim()
        throw new Error(
          `claude CLI failed ${location} (exit ${result.code})${tail ? `:\n${tail}` : ''}`
        )
      }

      const analysis = result.stdout.trim()
      if (!analysis) {
        const tail = result.stderr.trim()
        throw new Error(
          `claude CLI returned no output ${location}.` +
            (tail ? `\nstderr:\n${tail}` : '')
        )
      }

      const updated = await cloudClient.updateIssue(id, { analysis })
      mirror(() => repo.upsertFromCloud(updated))
      return updated
    }
  )
}
