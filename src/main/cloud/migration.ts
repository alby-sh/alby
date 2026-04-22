// One-shot upload of pre-existing local SQLite data to the cloud, run after the
// first successful login on a fresh device. Preserves the existing UUIDs so any
// in-flight tmux sessions on remote servers remain associated correctly.

import type Database from 'better-sqlite3'
import { cloudClient } from './cloud-client'
import type { Project, Environment, Task, Agent, Routine } from '../../shared/types'

const FLAG = 'cloud_migrated_at'

let inFlight: Promise<{ migrated: boolean; counts: Record<string, number> }> | null = null

const isDuplicate = (msg: string): boolean =>
  msg.includes('Duplicate') || msg.includes('duplicate') || msg.includes('1062')

export async function migrateLocalDataToCloud(db: Database.Database, win?: { send: (channel: string, payload: unknown) => void }): Promise<{ migrated: boolean; counts: Record<string, number> }> {
  // Mutex: in dev React StrictMode auth:current can fire twice on mount —
  // we don't want to upload everything twice in parallel.
  if (inFlight) return inFlight
  inFlight = doMigration(db, win)
  try {
    return await inFlight
  } finally {
    inFlight = null
  }
}

async function doMigration(db: Database.Database, win?: { send: (channel: string, payload: unknown) => void }): Promise<{ migrated: boolean; counts: Record<string, number> }> {
  console.log('[migration] starting…')
  const existing = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(FLAG) as { value: string } | undefined
  if (existing) {
    console.log('[migration] already done at', existing.value)
    return { migrated: false, counts: {} }
  }

  const projects = db.prepare('SELECT * FROM projects ORDER BY sort_order').all() as Project[]
  console.log(`[migration] found ${projects.length} local project(s) to upload`)
  if (projects.length === 0) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FLAG, new Date().toISOString())
    return { migrated: false, counts: {} }
  }

  // Resolve our user id from /api/me so we can stamp owner_id on projects.
  const me = await cloudClient.me()
  const ownerId = String(me.user.id)

  const counts = { projects: 0, environments: 0, tasks: 0, agents: 0, routines: 0 }
  const status = (msg: string): void => { win?.send('migration:progress', { message: msg }) }

  status(`Uploading ${projects.length} project(s) to your cloud account…`)

  for (const project of projects) {
    try {
      await cloudClient.createProject({
        id: project.id,
        owner_type: 'user',
        owner_id: ownerId,
        name: project.name,
        favicon_url: project.favicon_url ?? undefined,
        url: (project as Project & { url?: string | null }).url ?? undefined,
      })
      counts.projects++
    } catch (err) {
      const msg = (err as Error).message
      if (!isDuplicate(msg)) {
        console.warn(`[migration] project ${project.id} skipped:`, msg)
      } else {
        counts.projects++
      }
    }

    const envs = db
      .prepare('SELECT * FROM environments WHERE project_id = ? ORDER BY sort_order')
      .all(project.id) as (Environment & { agent_settings: unknown })[]

    for (const env of envs) {
      // SQLite stores agent_settings as JSON string — backend wants an object.
      let agentSettings: Record<string, unknown> | undefined
      if (env.agent_settings) {
        try {
          agentSettings = typeof env.agent_settings === 'string'
            ? JSON.parse(env.agent_settings)
            : (env.agent_settings as Record<string, unknown>)
        } catch { agentSettings = undefined }
      }

      try {
        await cloudClient.createEnvironment(project.id, {
          id: env.id,
          name: env.name,
          label: env.label ?? undefined,
          execution_mode: env.execution_mode,
          ssh_host: env.ssh_host || undefined,
          ssh_user: env.ssh_user ?? undefined,
          ssh_port: env.ssh_port,
          remote_path: env.remote_path,
          agent_settings: agentSettings,
          git_remote_url: env.git_remote_url ?? undefined,
        })
        counts.environments++
      } catch (err) {
        const msg = (err as Error).message
        if (!isDuplicate(msg)) {
          console.warn(`[migration] env ${env.id} skipped:`, msg)
        } else {
          counts.environments++
        }
      }

      const tasks = db
        .prepare('SELECT * FROM tasks WHERE environment_id = ? ORDER BY sort_order')
        .all(env.id) as Task[]
      for (const task of tasks) {
        try {
          await cloudClient.createTask(env.id, {
            id: task.id,
            title: task.title,
            description: task.description ?? undefined,
            context_notes: task.context_notes ?? undefined,
          })
          counts.tasks++
        } catch (err) {
          const msg = (err as Error).message
          if (!isDuplicate(msg)) {
            console.warn(`[migration] task ${task.id} skipped:`, msg)
          } else {
            counts.tasks++
          }
        }

        // Agents: just metadata; tmux sessions on the remote stay live and we'll
        // re-attach via the existing agent.id.
        const agents = db
          .prepare('SELECT * FROM agents WHERE task_id = ?')
          .all(task.id) as Agent[]
        for (const agent of agents) {
          try {
            await cloudClient.createAgent(task.id, {
              id: agent.id,
              tab_name: agent.tab_name ?? undefined,
              agent_type: agent.tab_name?.split(' ')[0]?.toLowerCase() || 'claude',
              prompt: agent.prompt ?? undefined,
              status: agent.status,
            })
            counts.agents++
          } catch (err) {
            const msg = (err as Error).message
            if (!isDuplicate(msg)) {
              console.warn(`[migration] agent ${agent.id} skipped:`, msg)
            } else {
              counts.agents++
            }
          }
        }
      }

      const routines = db
        .prepare('SELECT * FROM routines WHERE environment_id = ? ORDER BY sort_order')
        .all(env.id) as Routine[]
      for (const routine of routines) {
        try {
          await cloudClient.createRoutine(env.id, {
            id: routine.id,
            name: routine.name,
            cron_expression: routine.cron_expression,
            interval_seconds: routine.interval_seconds,
            agent_type: routine.agent_type,
            prompt: routine.prompt,
            enabled: !!routine.enabled,
          })
          counts.routines++
        } catch (err) {
          const msg = (err as Error).message
          if (!isDuplicate(msg)) {
            console.warn(`[migration] routine ${routine.id} skipped:`, msg)
          } else {
            counts.routines++
          }
        }
      }
    }
  }

  // Mark as done so we don't re-upload on next login on this device.
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(FLAG, new Date().toISOString())
  status(`Migration complete: ${counts.projects} projects, ${counts.environments} envs, ${counts.tasks} tasks.`)

  return { migrated: true, counts }
}
