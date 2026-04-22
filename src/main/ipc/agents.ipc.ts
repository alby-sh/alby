import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { AgentsRepo } from '../db/agents.repo'
import { ProjectsRepo } from '../db/projects.repo'
import { AgentManager } from '../agents/agent-manager'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'

/**
 * Agent IPC handlers.
 *
 * Agents have two layers:
 *  - Runtime state (tmux session attachment, stdout stream, kill signals) —
 *    always local to the machine that owns the SSH connection.
 *  - Persistent record (id, tab_name, status, prompt, exit_code, task_id) —
 *    stored in the cloud so other devices see the same agents.
 *
 * Reads go through local SQLite (populated by the migration + mirrored on every
 * cloud-list roundtrip) for speed. Writes fire-and-forget to the cloud so
 * cross-device listings eventually converge.
 */
export function registerAgentsIPC(db: Database.Database, agentManager: AgentManager): void {
  const repo = new AgentsRepo(db)
  const projectsRepo = new ProjectsRepo(db)

  // Helper to mirror writes to the cloud — awaited so the next list refetch
  // sees consistent state. Previously these were fire-and-forget which raced
  // with the renderer's invalidate→refetch cycle: spawn returned, cloud write
  // started, renderer refetched the list before the write committed, and the
  // new agent was missing (or the killed one was still there).
  const cloudWrite = async (promise: Promise<unknown>): Promise<void> => {
    try { await promise } catch (err) {
      console.warn('[agents cloud]', (err as Error).message)
    }
  }

  ipcMain.handle('agents:list', async (event, taskId: string) => {
    // Try cloud first so cross-device agents show up; fall back to local if offline.
    if (await loadToken()) {
      try {
        const agents = await cloudClient.listAgents(taskId)
        // Best-effort mirror — ensures the next local read is coherent.
        agents.forEach((a) => { try { repo.upsertFromCloud(a) } catch { /* ignore */ } })
        // Lazy reattach: if a cloud-side running agent has no live runner on
        // this device (fresh install, long idle, cross-device session), spin
        // up a RemoteAgent + SSH+tmux attach in the background so the tab
        // isn't empty when the user clicks it.
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win) {
          for (const a of agents) {
            if (a.status === 'running') {
              agentManager.ensureAttached(a.id, win).catch(() => { /* ignore */ })
            }
          }
        }
        return agents
      } catch (err) {
        console.warn('[agents:list] cloud failed, falling back to local:', (err as Error).message)
      }
    }
    return repo.list(taskId)
  })

  ipcMain.handle('agents:list-all', () => {
    // Polled every 15s by the renderer — keep it local for speed. The renderer
    // will see cross-device agents after any per-task listing refresh.
    return repo.listAll()
  })

  ipcMain.handle('agents:get-context', (_, agentId: string) => {
    const agent = repo.get(agentId)
    if (!agent) return null
    const taskData = projectsRepo.getTaskWithEnvironment(agent.task_id)
    if (!taskData) return null
    return {
      agentName: agent.tab_name || 'Agent',
      taskId: agent.task_id,
      environmentId: taskData.environment.id,
      environmentName: taskData.environment.name,
      projectId: taskData.project.id,
      projectName: taskData.project.name,
    }
  })

  ipcMain.handle('agents:spawn', async (event, taskId: string, agentType?: string, autoInstall?: boolean, initialPrompt?: string) => {
    console.log('[agents:spawn] taskId:', taskId, 'agentType:', agentType || 'claude', 'autoInstall:', !!autoInstall, 'initialPrompt:', initialPrompt ? `${initialPrompt.slice(0, 60)}…` : 'none')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window found')
      const agent = await agentManager.spawn(taskId, win, agentType || 'claude', !!autoInstall, initialPrompt)
      console.log('[agents:spawn] success, agentId:', agent.id)
      // Mirror to cloud with the same id so other devices see this agent.
      // Awaited so the list refetch immediately after spawn sees the new agent.
      await cloudWrite(cloudClient.createAgent(taskId, {
        id: agent.id,
        tab_name: agent.tab_name ?? undefined,
        agent_type: agentType || 'claude',
        prompt: agent.prompt ?? undefined,
        status: agent.status,
      }))
      return agent
    } catch (err) {
      console.error('[agents:spawn] error:', err)
      throw err
    }
  })

  ipcMain.handle('agents:kill', async (_, agentId: string) => {
    // Snapshot the tab_name BEFORE kill runs — agentManager.kill for
    // non-chat agents deletes the row, and we'd lose the ability to tell
    // chat from anything else afterwards.
    const existing = repo.get(agentId)
    const isChat = !!existing?.tab_name?.toLowerCase().startsWith('chat')
    await agentManager.kill(agentId)
    if (isChat) {
      // Chat tabs keep their cloud record so the transcript + session_id
      // survive across devices. Just flip status to "completed" there.
      try {
        await cloudClient.updateAgent(agentId, {
          status: 'completed', exit_code: 0, finished_at: new Date().toISOString(),
        })
      } catch (err) { console.warn('[agents kill cloud]', (err as Error).message) }
      return
    }
    // Awaited so the next agents:list (triggered by the renderer's invalidate)
    // sees the killed agent as already-deleted on the cloud — otherwise the
    // X button "doesn't work" because the refetch resurrects the agent.
    await cloudWrite(cloudClient.deleteAgent(agentId))
  })

  ipcMain.handle('agents:delete', async (_, agentId: string) => {
    repo.delete(agentId)
    await cloudWrite(cloudClient.deleteAgent(agentId))
  })

  // Two-step reorder: first persist locally (so the UI is fast), then fire a
  // broadcast-only cloud call so other devices on the same project channel
  // receive `entity.changed` / action=reordered and catch up. The cloud
  // endpoint doesn't store agent sort_order (it would collide across
  // collaborators with different preferences), so without the broadcast
  // other devices stay at their own ordering — acceptable as each user
  // controls their own view.
  ipcMain.handle('agents:reorder', async (_, orderedIds: string[]) => {
    repo.reorderAgents(orderedIds)
    if (orderedIds.length > 0) {
      const firstAgent = repo.get(orderedIds[0])
      if (firstAgent) {
        const taskData = projectsRepo.getTaskWithEnvironment(firstAgent.task_id)
        if (taskData) {
          await cloudWrite(cloudClient.reorderAgents(taskData.environment.project_id, orderedIds))
        }
      }
    }
    return { ok: true }
  })

  ipcMain.handle('agents:heartbeat', async (_, agentId: string, deltas: { working_delta?: number; viewed_delta?: number }) => {
    if (!(deltas.working_delta || deltas.viewed_delta)) return
    try { await cloudClient.heartbeatAgent(agentId, deltas) } catch (err) {
      console.warn('[agents:heartbeat]', (err as Error).message)
    }
  })

  ipcMain.handle('agents:ensure-attached', async (event, agentId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, message: 'No window' }
    try {
      await agentManager.ensureAttached(agentId, win)
      return { ok: agentManager.isRunning(agentId) }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  ipcMain.handle('agents:write-stdin', (_, agentId: string, data: string) => {
    agentManager.writeStdin(agentId, data)
  })

  ipcMain.handle('agents:chat-send', (_, agentId: string, text: string) => {
    const ok = agentManager.sendChatMessage(agentId, text)
    return { ok }
  })

  /**
   * Return the persisted transcript of a chat agent, so the ChatPanel can
   * replay the whole conversation on mount / app restart.
   *
   * - Remote envs → cloud-first with local fallback + mirror of missing seqs.
   * - Local envs → local SQLite only, never hits the cloud. Local chats are
   *   intentionally device-private (matching the rest of the app: local
   *   agents don't sync across devices).
   */
  ipcMain.handle('agents:chat-history', async (_, agentId: string) => {
    const local = agentManager.getChatTranscript(agentId)
    const agent = repo.get(agentId)
    const taskData = agent ? projectsRepo.getTaskWithEnvironment(agent.task_id) : undefined
    const isRemote = taskData?.environment.execution_mode === 'remote'
    if (!isRemote) return local
    if (!(await loadToken())) return local
    try {
      const rows = await cloudClient.listChatEvents(agentId, -1, 10000)
      if (!Array.isArray(rows)) return local
      if (rows.length === 0) return local
      // Mirror missing events into the local transcript so offline reads
      // after first sync are instantaneous.
      try { agentManager.mirrorChatTranscript(agentId, rows) } catch (err) {
        console.warn('[agents:chat-history] mirror failed:', (err as Error).message)
      }
      return rows.map((r) => {
        try { return JSON.parse(r.event_json) as Record<string, unknown> } catch { return { type: 'stderr', data: r.event_json } }
      })
    } catch (err) {
      console.warn('[agents:chat-history] cloud fetch failed, using local:', (err as Error).message)
      return local
    }
  })

  /**
   * Respawn a chat agent using --resume + its saved session_id. Used when
   * the user reopens a chat whose process died (tab close, app restart).
   */
  ipcMain.handle('agents:chat-restart', async (event, agentId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return { ok: false, message: 'No window' }
    try {
      const ok = await agentManager.restartChat(agentId, win)
      if (ok) {
        // Sync status to cloud so other devices don't see the agent stuck
        // in completed/error state.
        try { await cloudClient.updateAgent(agentId, { status: 'running', exit_code: null, finished_at: null }) } catch { /* best effort */ }
      }
      return { ok }
    } catch (err) {
      return { ok: false, message: (err as Error).message }
    }
  })

  /**
   * Permanently delete a chat agent (process + record + transcript).
   * This is the real "trash" action, distinct from tab close which keeps
   * the transcript around for resume.
   */
  ipcMain.handle('agents:chat-delete', async (_, agentId: string) => {
    agentManager.deleteChat(agentId)
    await cloudWrite(cloudClient.deleteAgent(agentId))
  })

  ipcMain.handle('agents:resize', (_, agentId: string, cols: number, rows: number) => {
    agentManager.resize(agentId, cols, rows)
  })

  ipcMain.handle(
    'agents:update-summary',
    (_, agentId: string, taskId: string, summary: string) => {
      agentManager.updateAgentSummary(agentId, taskId, summary)
    }
  )

  // Patch user-editable agent fields (currently just tab_name — the rename
  // action in the UI). Local DB + cloud are kept in sync so the rename
  // sticks across devices / restarts.
  ipcMain.handle(
    'agents:update',
    async (_, agentId: string, data: { tab_name?: string }) => {
      const trimmed = data.tab_name?.trim()
      if (trimmed && trimmed.length > 0) {
        repo.updateTabName(agentId, trimmed)
      }
      await cloudWrite(
        cloudClient.updateAgent(agentId, { tab_name: trimmed || undefined }),
      )
      return repo.get(agentId) ?? null
    },
  )
}
