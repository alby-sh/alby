import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { getAllHosts } from '../ssh/config-parser'
import { ConnectionPool } from '../ssh/connection-pool'
import { runPreflight } from '../ssh/preflight'
import { ProjectsRepo } from '../db/projects.repo'
import { cloudClient } from '../cloud/cloud-client'
import { getGitStatus, gitDiffSummary, gitCommitAndPush, gitPush, gitPull, gitFetch, gitDiscardChanges, gitRemoteUrl, checkGitHubAuth, installGhCli, startGitHubDeviceAuth, gitLog, gitChangedFiles, ghPullRequests, ghWorkflowRuns } from '../git/git-status'
import {
  getGitStatusLocal,
  gitLogLocal,
  gitChangedFilesLocal,
  gitRemoteUrlLocal,
  gitCommitPushLocal,
  gitPushLocal,
  gitFetchLocal,
  gitPullLocal,
  gitDiscardChangesLocal,
  gitDiffSummaryLocal,
  checkGitHubAuthLocal,
  ghPullRequestsLocal,
  ghWorkflowRunsLocal,
} from '../git/git-local'
import type { SSHPreflightParams } from '../../shared/types'
import type { BrowserWindow } from 'electron'

export function registerSSHIPC(db: Database.Database, connectionPool: ConnectionPool): void {
  const repo = new ProjectsRepo(db)

  // Fire-and-forget audit log entry for git operations. The activity report
  // surfaces these so reviewers can see who pushed/pulled/discarded what.
  const logGit = (envId: string, action: string, summary: string, diff?: unknown): void => {
    const env = repo.getEnvironment(envId)
    if (!env) return
    cloudClient
      .recordAudit({
        project_id: env.project_id,
        entity_type: 'environment',
        entity_id: envId,
        action: `git.${action}`,
        summary,
        diff,
      })
      .catch((err) => console.warn('[git audit]', (err as Error).message))
  }

  ipcMain.handle('ssh:list-hosts', () => getAllHosts(db))

  // Force reconnect all disconnected SSH connections (called when network comes back)
  ipcMain.handle('ssh:reconnect-all', () => {
    connectionPool.reconnectAll()
    return { ok: true }
  })

  // Full preflight for an existing environment — returns a structured result
  // with stage/code/hint so the UI can explain auth vs. firewall vs. DNS vs.
  // missing git failures in terms the user can act on.
  ipcMain.handle('ssh:test-connection', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return { ok: false, code: 'NOT_FOUND', message: 'Environment not found' }
    if (env.execution_mode !== 'remote') return { ok: true, message: 'Local environment — no connection needed.' }
    try {
      const result = await runPreflight({
        role: env.role ?? 'operational',
        platform: env.platform ?? 'linux',
        ssh_host: env.ssh_host,
        ssh_user: env.ssh_user ?? undefined,
        ssh_port: env.ssh_port,
        ssh_key_path: env.ssh_key_path ?? undefined,
        ssh_auth_method: env.ssh_auth_method ?? 'key',
        ssh_password: env.ssh_password ?? undefined,
        remote_path: env.remote_path,
      })
      // Warm the connection pool on success so subsequent agent launches don't
      // pay the TLS/handshake cost again.
      if (result.ok) {
        connectionPool.connect(env).catch(() => { /* non-fatal */ })
      }
      return result
    } catch (err) {
      return { ok: false, code: 'PREFLIGHT_EXCEPTION', message: (err as Error).message }
    }
  })

  // Stateless preflight for the "add environment" flow — no env record exists
  // yet, the renderer passes the raw params it's about to save.
  ipcMain.handle('ssh:test-preflight', async (_, params: SSHPreflightParams) => {
    try {
      return await runPreflight(params)
    } catch (err) {
      return { ok: false, code: 'PREFLIGHT_EXCEPTION', message: (err as Error).message }
    }
  })

  // Connect all (remote) environments of a project in parallel, return status map.
  // Local environments are skipped — there's nothing to connect.
  ipcMain.handle('ssh:connect-project', async (_, projectId: string) => {
    const allEnvs = repo.listEnvironments(projectId)
    const envs = allEnvs.filter((e) => e.execution_mode === 'remote')
    console.log(`[ssh:connect-project] Connecting ${envs.length} remote environments for project ${projectId}`)
    const results: Record<string, { ok: boolean; error?: string }> = {}

    // Local envs report ok immediately so the UI doesn't show them as "disconnected".
    for (const env of allEnvs) {
      if (env.execution_mode !== 'remote') results[env.id] = { ok: true }
    }

    await Promise.allSettled(
      envs.map(async (env) => {
        try {
          await connectionPool.connect(env)
          results[env.id] = { ok: true }
          console.log(`[ssh:connect-project] ${env.name} (${env.ssh_host}): connected`)
        } catch (err) {
          const msg = (err as Error).message
          results[env.id] = { ok: false, error: msg }
          console.error(`[ssh:connect-project] ${env.name} (${env.ssh_host}): failed -`, msg)
        }
      })
    )

    // Auto-fetch on all successfully connected environments (best-effort, in background)
    setTimeout(() => {
      for (const env of envs) {
        if (results[env.id]?.ok && env.remote_path) {
          const client = connectionPool.get(env.id)
          if (client) {
            gitFetch(client, env.remote_path).catch(() => {})
          }
        }
      }
    }, 2000)

    return results
  })

  // Check connection status without connecting
  ipcMain.handle('ssh:connection-status', (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (env && env.execution_mode !== 'remote') return { connected: true }
    return { connected: connectionPool.isConnected(envId) }
  })

  ipcMain.handle('git:status', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return { modified: 0, staged: 0, ahead: 0, behind: 0, hasRepo: false }

    try {
      if (env.execution_mode !== 'remote') {
        return await getGitStatusLocal(env.remote_path)
      }
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return await getGitStatus(client, env.remote_path)
    } catch {
      return { modified: 0, staged: 0, ahead: 0, behind: 0, hasRepo: false }
    }
  })

  // Helper: fetch all sibling environments of the same project (excluding the given envId)
  const fetchSiblings = async (envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return
    // Find the project this environment belongs to
    const allEnvs = repo.listEnvironments(env.project_id || '')
    if (!env.project_id) {
      // Fallback: search all projects for this environment
      return
    }
    const siblings = allEnvs.filter((e) => e.id !== envId)
    // Fetch on each sibling in parallel (best-effort, don't fail if one errors)
    await Promise.allSettled(
      siblings.map(async (sib) => {
        try {
          const client = connectionPool.get(sib.id)
          if (client && sib.remote_path) {
            await gitFetch(client, sib.remote_path)
          }
        } catch { /* ignore */ }
      })
    )
  }

  ipcMain.handle('git:diff-summary', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return ''
    try {
      if (env.execution_mode !== 'remote') return await gitDiffSummaryLocal(env.remote_path)
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return await gitDiffSummary(client, env.remote_path)
    } catch { return '' }
  })

  ipcMain.handle('git:commit-push', async (_, envId: string, message: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    const result = env.execution_mode !== 'remote'
      ? await gitCommitPushLocal(env.remote_path, message)
      : await gitCommitAndPush(
          connectionPool.get(envId) || await connectionPool.connect(env),
          env.remote_path,
          message,
        )
    logGit(envId, 'commit_push', `Committed & pushed: ${message}`, { message })
    setTimeout(() => fetchSiblings(envId), 1000)
    return result
  })

  ipcMain.handle('git:push', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    const result = env.execution_mode !== 'remote'
      ? await gitPushLocal(env.remote_path)
      : await gitPush(connectionPool.get(envId) || await connectionPool.connect(env), env.remote_path)
    logGit(envId, 'push', 'Pushed local commits to remote')
    setTimeout(() => fetchSiblings(envId), 1000)
    return result
  })

  ipcMain.handle('git:fetch', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    const result = env.execution_mode !== 'remote'
      ? await gitFetchLocal(env.remote_path)
      : await gitFetch(connectionPool.get(envId) || await connectionPool.connect(env), env.remote_path)
    logGit(envId, 'fetch', 'Fetched from remote')
    return result
  })

  ipcMain.handle('git:pull', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    const result = env.execution_mode !== 'remote'
      ? await gitPullLocal(env.remote_path)
      : await gitPull(connectionPool.get(envId) || await connectionPool.connect(env), env.remote_path)
    logGit(envId, 'pull', 'Pulled from remote')
    setTimeout(() => fetchSiblings(envId), 1000)
    return result
  })

  ipcMain.handle('git:discard', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    const result = env.execution_mode !== 'remote'
      ? await gitDiscardChangesLocal(env.remote_path)
      : await gitDiscardChanges(connectionPool.get(envId) || await connectionPool.connect(env), env.remote_path)
    logGit(envId, 'discard', 'Discarded local changes')
    return result
  })

  // Check if a command exists — on the remote server (SSH) or on this Mac (local env).
  ipcMain.handle('ssh:check-command', async (_, envId: string, command: string) => {
    const env = repo.getEnvironment(envId)
    console.log(`[ssh:check-command] envId=${envId} command=${command} env.execution_mode=${env?.execution_mode} ssh_host="${env?.ssh_host}"`)
    if (!env) return { exists: false }
    if (env.execution_mode !== 'remote') {
      // Local env: skip the pre-flight check entirely. Many shell setups
      // (oh-my-zsh, nvm, asdf) don't populate PATH in non-tty subshells, so
      // an execSync probe is unreliable — Electron has reported "claude not
      // installed" for users who clearly had it. The real node-pty spawn
      // gets a TTY and will surface a `command not found` error in the
      // terminal pane if the binary really isn't there.
      return { exists: true }
    }
    try {
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return new Promise<{ exists: boolean }>((resolve) => {
        client.exec(`bash -l -c 'command -v ${command} 2>/dev/null'`, (err, channel) => {
          if (err) { resolve({ exists: false }); return }
          let out = ''
          channel.on('data', (d: Buffer) => { out += d.toString() })
          channel.on('close', (code: number) => { resolve({ exists: code === 0 && out.trim().length > 0 }) })
        })
      })
    } catch {
      return { exists: false }
    }
  })

  // GitHub auth: check status
  ipcMain.handle('git:check-github-auth', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return { authenticated: false, ghInstalled: false }
    try {
      if (env.execution_mode !== 'remote') return await checkGitHubAuthLocal()
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return await checkGitHubAuth(client)
    } catch {
      return { authenticated: false, ghInstalled: false }
    }
  })

  // GitHub auth: install gh CLI
  ipcMain.handle('git:install-gh', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    const client = connectionPool.get(envId) || await connectionPool.connect(env)
    await installGhCli(client)
    return { ok: true }
  })

  // GitHub auth: start device flow
  ipcMain.handle('git:github-auth-start', async (event, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    const client = connectionPool.get(envId) || await connectionPool.connect(env)

    const result = await startGitHubDeviceAuth(client)

    // Wait for completion in background, then notify renderer
    result.waitForCompletion().then((completion) => {
      try {
        event.sender.send('git:github-auth-complete', { envId, ...completion })
      } catch { /* window may have closed */ }
    })

    return { userCode: result.userCode, verificationUrl: result.verificationUrl }
  })

  ipcMain.handle('git:remote-url', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return null
    // Return cached URL if available
    if (env.git_remote_url) return env.git_remote_url
    try {
      const url = env.execution_mode !== 'remote'
        ? await gitRemoteUrlLocal(env.remote_path)
        : await gitRemoteUrl(connectionPool.get(envId) || await connectionPool.connect(env), env.remote_path)
      if (url) {
        repo.updateEnvironment(envId, { git_remote_url: url })
      }
      return url
    } catch {
      return null
    }
  })

  ipcMain.handle('git:log', async (_, envId: string, limit?: number) => {
    const env = repo.getEnvironment(envId)
    if (!env) return []
    try {
      if (env.execution_mode !== 'remote') return await gitLogLocal(env.remote_path, limit ?? 20)
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return await gitLog(client, env.remote_path, limit ?? 20)
    } catch {
      return []
    }
  })

  ipcMain.handle('git:changed-files', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return []
    try {
      if (env.execution_mode !== 'remote') return await gitChangedFilesLocal(env.remote_path)
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return await gitChangedFiles(client, env.remote_path)
    } catch {
      return []
    }
  })

  ipcMain.handle('gh:pr-list', async (_, envId: string, limit?: number) => {
    const env = repo.getEnvironment(envId)
    if (!env) return []
    try {
      if (env.execution_mode !== 'remote') return await ghPullRequestsLocal(env.remote_path, limit ?? 20)
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return await ghPullRequests(client, env.remote_path, limit ?? 20)
    } catch {
      return []
    }
  })

  ipcMain.handle('gh:run-list', async (_, envId: string, limit?: number) => {
    const env = repo.getEnvironment(envId)
    if (!env) return []
    try {
      if (env.execution_mode !== 'remote') return await ghWorkflowRunsLocal(env.remote_path, limit ?? 20)
      const client = connectionPool.get(envId) || await connectionPool.connect(env)
      return await ghWorkflowRuns(client, env.remote_path, limit ?? 20)
    } catch {
      return []
    }
  })
}
