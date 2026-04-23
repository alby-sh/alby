import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { RoutinesRepo } from '../db/routines.repo'
import { RoutineManager } from '../agents/routine-manager'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import type { CreateRoutineDTO, Routine, UpdateRoutineDTO } from '../../shared/types'

/**
 * Routine IPC handlers.
 *
 * Data ops (list, create, update, delete) go through the cloud API so edits
 * from any device are reflected on alby.sh. Every fetch is mirrored into the
 * local SQLite cache because RoutineManager (which drives the tmux loop) still
 * reads local state as its source of truth during a run.
 *
 * Runtime ops (start, stop, write-stdin, resize) stay local — they attach to
 * tmux sessions on the user's remote servers.
 */
export function registerRoutinesIPC(db: Database.Database, routineManager: RoutineManager): void {
  const repo = new RoutinesRepo(db)

  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!(await loadToken())) return fallback
    try {
      return await fn()
    } catch (err) {
      console.error('[routines cloud]', (err as Error).message)
      return fallback
    }
  }

  const cache = (routine: Routine | null | undefined): void => {
    if (!routine) return
    try { repo.upsertFromCloud(routine) } catch (err) { console.error('[routines cache]', (err as Error).message) }
  }

  ipcMain.handle('routines:list', async () => {
    if (!(await loadToken())) return []
    try {
      const projects = await cloudClient.listProjects()
      const envs = (await Promise.all(projects.map((p) => cloudClient.listEnvironments(p.id)))).flat()
      const routines = (await Promise.all(envs.map((e) => cloudClient.listRoutines(e.id)))).flat()
      routines.forEach(cache)
      return routines
    } catch (err) {
      console.error('[routines list]', (err as Error).message)
      return []
    }
  })

  ipcMain.handle('routines:list-by-env', async (_, envId: string) => {
    const routines = await safe(() => cloudClient.listRoutines(envId), [] as Routine[])
    routines.forEach(cache)
    return routines
  })

  ipcMain.handle('routines:get', (_, id: string) => repo.get(id))

  ipcMain.handle('routines:create', async (_, data: CreateRoutineDTO) => {
    const routine = await cloudClient.createRoutine(data.environment_id, {
      name: data.name,
      cron_expression: data.cron_expression,
      interval_seconds: data.interval_seconds,
      agent_type: data.agent_type,
      prompt: data.prompt,
      enabled: true,
      allowed_user_ids: data.allowed_user_ids ?? null,
    })
    cache(routine)
    return routine
  })

  ipcMain.handle('routines:update', async (_, id: string, data: UpdateRoutineDTO) => {
    const routine = await cloudClient.updateRoutine(id, data)
    cache(routine)
    return routine
  })

  ipcMain.handle('routines:delete', async (_, id: string) => {
    await routineManager.delete(id)
    await safe(() => cloudClient.deleteRoutine(id), undefined)
  })

  // Persist locally then push to cloud. Unlike agents, routine sort_order IS
  // stored server-side (shared across a team is acceptable — routines are
  // already shared config), so a fresh device that misses the broadcast still
  // gets the right order from the next list() call.
  ipcMain.handle('routines:reorder', async (_, environmentId: string, orderedIds: string[]) => {
    repo.reorderRoutines(environmentId, orderedIds)
    try { await cloudClient.reorderRoutines(environmentId, orderedIds) } catch (err) {
      console.warn('[routines:reorder cloud]', (err as Error).message)
    }
    return { ok: true }
  })

  // --- Runtime (local only; tmux on remote server) ---

  ipcMain.handle('routines:start', async (event, id: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('No window found')
    try {
      return await routineManager.start(id, win)
    } catch (err) {
      console.error(`[routines:start] failed for ${id}:`, err)
      throw err
    }
  })

  ipcMain.handle('routines:stop', async (_, id: string) => { await routineManager.stop(id) })

  ipcMain.handle('routines:write-stdin', (_, id: string, data: string) => {
    routineManager.writeStdin(id, data)
  })

  ipcMain.handle('routines:resize', (_, id: string, cols: number, rows: number) => {
    routineManager.resize(id, cols, rows)
  })
}
