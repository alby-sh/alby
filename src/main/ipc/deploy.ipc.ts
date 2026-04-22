import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { ProjectsRepo } from '../db/projects.repo'
import type { ConnectionPool } from '../ssh/connection-pool'
import { runPreflight } from '../ssh/preflight'
import { createDeployExecutor, type DeployExecutor, type DeployStep } from '../deploy/deploy-executor'
import { cloudClient } from '../cloud/cloud-client'

interface ActiveRun {
  runId: string
  envId: string
  executor: DeployExecutor
}

export function registerDeployIPC(
  db: Database.Database,
  connectionPool: ConnectionPool,
  getWindow: () => BrowserWindow | null
): void {
  const repo = new ProjectsRepo(db)
  const active = new Map<string, ActiveRun>()

  const send = (channel: string, payload: unknown): void => {
    try {
      getWindow()?.webContents.send(channel, payload)
    } catch { /* window may have closed */ }
  }

  // Preflight a deploy target — same structured result as ssh:test-connection
  // but limited to remote + deploy role sanity.
  ipcMain.handle('deploy:test', async (_, envId: string) => {
    const env = repo.getEnvironment(envId)
    if (!env) return { ok: false, code: 'NOT_FOUND', message: 'Environment not found' }
    if (env.role !== 'deploy') return { ok: false, code: 'WRONG_ROLE', message: 'This environment is not a deploy target.' }
    if (env.execution_mode !== 'remote') return { ok: false, code: 'NOT_REMOTE', message: 'Deploy targets must be remote.' }
    return runPreflight({
      role: env.role,
      platform: env.platform ?? 'linux',
      ssh_host: env.ssh_host,
      ssh_user: env.ssh_user ?? undefined,
      ssh_port: env.ssh_port,
      ssh_key_path: env.ssh_key_path ?? undefined,
      ssh_auth_method: env.ssh_auth_method ?? 'key',
      ssh_password: env.ssh_password ?? undefined,
      remote_path: env.remote_path,
    })
  })

  async function startRun(envId: string, dryRun: boolean): Promise<{ runId: string }> {
    const env = repo.getEnvironment(envId)
    if (!env) throw new Error('Environment not found')
    if (env.role !== 'deploy') throw new Error('This environment is not a deploy target.')
    if (env.execution_mode !== 'remote') throw new Error('Deploy targets must be remote.')

    const client = connectionPool.get(envId) ?? (await connectionPool.connect(env))
    const executor = createDeployExecutor(client, env, { dryRun })
    const runId = randomUUID()
    active.set(runId, { runId, envId, executor })

    executor.on('info', (line) => send('deploy:info', { runId, envId, line }))
    executor.on('step', (step: DeployStep) => send('deploy:step', { runId, envId, step }))
    executor.on('data', (payload) => send('deploy:data', { runId, envId, ...payload }))
    executor.on('stepDone', (payload) => send('deploy:step-done', { runId, envId, ...payload }))
    executor.on('done', (summary) => {
      send('deploy:done', { runId, envId, dryRun, ...summary })
      active.delete(runId)
      if (!dryRun) {
        // Fire-and-forget audit entry so the activity view reflects deploys.
        cloudClient
          .recordAudit({
            project_id: env.project_id,
            entity_type: 'environment',
            entity_id: envId,
            action: summary.ok ? 'deploy.success' : 'deploy.failed',
            summary: summary.ok
              ? `Deploy to ${env.name} succeeded`
              : `Deploy to ${env.name} failed at ${summary.failedAt?.kind ?? 'unknown'} step (exit ${summary.exitCode ?? -1})`,
            diff: summary,
          })
          .catch((err) => console.warn('[deploy audit]', (err as Error).message))
      }
    })

    // Kick off; the promise from run() resolves when done but we return runId
    // right away so the renderer can subscribe to streaming events.
    executor.run().catch((err) => {
      send('deploy:done', { runId, envId, dryRun, ok: false, error: (err as Error).message })
      active.delete(runId)
    })

    return { runId }
  }

  ipcMain.handle('deploy:run', (_, envId: string) => startRun(envId, false))
  ipcMain.handle('deploy:dry-run', (_, envId: string) => startRun(envId, true))

  ipcMain.handle('deploy:cancel', (_, runId: string) => {
    const entry = active.get(runId)
    if (!entry) return { ok: false, error: 'Run not found' }
    entry.executor.cancel()
    return { ok: true }
  })
}
