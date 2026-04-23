import { ipcMain, BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import { AgentsRepo } from '../db/agents.repo'
import { ProjectsRepo } from '../db/projects.repo'
import { AgentManager } from '../agents/agent-manager'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import { getDeviceInfo, getDeviceId } from '../device/device-id'

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

  // v0.8.3: every renderer needs to know its own device id so it can decide
  // "this foreign-local agent belongs to someone else, show the read-only
  // placeholder instead of the terminal". Renderer caches this at boot in
  // auth-store so it's available synchronously during every sidebar render.
  ipcMain.handle('device:info', () => getDeviceInfo())

  /**
   * v0.8.3: guard rail for any IPC that would mutate / interact with an
   * agent's runtime (kill, delete, write-stdin, resize, ensure-attached,
   * chat-send/restart/delete). A `local` agent's PTY only exists on the
   * originating Mac — if a DIFFERENT Mac tries to kill/write it, we have
   * to refuse, otherwise the cloud row flips to "completed" but the PTY
   * keeps running on the owner box, leaving everything out of sync.
   *
   * Legacy agents without `device_id` (rows created before 0.8.3) pass
   * through unguarded so the upgrade doesn't brick in-flight sessions.
   * Remote-env agents also pass through — their PTY lives in an SSH+tmux
   * session that any authorised device can reach, so cross-device kill
   * is a legitimate operation there.
   *
   * Returns a friendly error message on refusal; callers throw the
   * string as an Error so the renderer can toast it.
   */
  const refuseIfForeignLocal = (agentId: string): string | null => {
    const row = repo.get(agentId)
    if (!row) return null
    if (row.execution_mode !== 'local') return null
    if (!row.device_id) return null // legacy, unguarded
    const mine = getDeviceId()
    if (row.device_id === mine) return null
    const owner = row.device_name || 'another device'
    return `This session is running locally on "${owner}". Open Alby on that Mac to interact with it — remote control isn't available for local PTYs.`
  }

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
    // Merge cloud + local. The cloud is authoritative for cross-device
    // (remote) sessions, but local-only sessions never get pushed up there
    // (agents:spawn skips the cloud write when the env is local) so a pure
    // cloud-returning behaviour would hide the tabs of any local session
    // the user just opened. We therefore:
    //   1. Fetch cloud agents (if authenticated) and upsert them locally.
    //   2. Return `repo.list(taskId)` — this is now the union of cloud-
    //      originated rows (just mirrored) and locally-spawned rows that
    //      never left this device.
    // Offline / unauthenticated users skip step 1 and just get local.
    if (await loadToken()) {
      try {
        const cloudAgents = await cloudClient.listAgents(taskId)
        cloudAgents.forEach((a) => { try { repo.upsertFromCloud(a) } catch { /* ignore */ } })
        // Lazy reattach: if a cloud-side running agent has no live runner on
        // this device (fresh install, long idle, cross-device session), spin
        // up a RemoteAgent + SSH+tmux attach in the background so the tab
        // isn't empty when the user clicks it.
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win) {
          for (const a of cloudAgents) {
            if (a.status === 'running') {
              agentManager.ensureAttached(a.id, win).catch(() => { /* ignore */ })
            }
          }
        }
      } catch (err) {
        console.warn('[agents:list] cloud fetch failed, serving local-only:', (err as Error).message)
      }
    }
    return repo.list(taskId)
  })

  ipcMain.handle('agents:list-all', async () => {
    // Pull the set of RUNNING agents from the cloud and mirror them into
    // local SQLite. This is what makes a session started on one device
    // show up on another: without this, the sidebar's `useAllAgents` was
    // happy to serve a stale local list forever because the per-task
    // `agents:list` only runs when the user opens that task.
    //
    // We intentionally don't try to sync every completed/errored agent
    // ever recorded — that would grow unboundedly. Terminal states are
    // delivered via `entity.changed` broadcasts (agent/updated with
    // status=completed|error) and the per-task `agents:list` handler
    // on actual navigation.
    if (await loadToken()) {
      try {
        const running = await cloudClient.listAllRunningAgents()
        for (const a of running) {
          try { repo.upsertFromCloud(a) } catch { /* ignore */ }
        }
      } catch (err) {
        console.warn('[agents:list-all] cloud sync failed, serving local:', (err as Error).message)
      }
    }
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

  ipcMain.handle('agents:spawn', async (event, taskId: string, agentType?: string, autoInstall?: boolean, initialPrompt?: string, kind?: 'auto-fix') => {
    console.log('[agents:spawn] taskId:', taskId, 'agentType:', agentType || 'claude', 'autoInstall:', !!autoInstall, 'kind:', kind || 'default', 'initialPrompt:', initialPrompt ? `${initialPrompt.slice(0, 60)}…` : 'none')
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) throw new Error('No window found')
      const agent = await agentManager.spawn(taskId, win, agentType || 'claude', !!autoInstall, initialPrompt, kind)
      console.log('[agents:spawn] success, agentId:', agent.id)
      // v0.8.3: ALWAYS mirror to cloud, tagged with this device's id.
      //
      // Pre-0.8.3 we skipped the cloud write for local envs on the theory
      // that "local agents can't be attached from another Mac, so hiding
      // them is cleaner". In practice teammates were blind to what each
      // other was running on their own machines, which broke the
      // coordination story — two people on the same team could spawn
      // overlapping work and not realise it. So now local agents ARE
      // synced, with `execution_mode: 'local'` + our `device_id` so the
      // peer client knows to render the row read-only and block
      // attach/kill/delete (enforced here AND in the UI).
      //
      // Note this runs even for chat agents — ChatAgent already has its
      // own cloud-sync path for transcripts, but the agent ROW itself
      // still wants the device-ownership fields, so routing through the
      // same createAgent keeps the shape uniform.
      const taskData = projectsRepo.getTaskWithEnvironment(taskId)
      const executionMode: 'local' | 'remote' =
        taskData?.environment.execution_mode === 'remote' ? 'remote' : 'local'
      const deviceInfo = getDeviceInfo()
      await cloudWrite(cloudClient.createAgent(taskId, {
        id: agent.id,
        tab_name: agent.tab_name ?? undefined,
        agent_type: agentType || 'claude',
        prompt: agent.prompt ?? undefined,
        status: agent.status,
        device_id: deviceInfo.device_id,
        device_name: deviceInfo.device_name,
        execution_mode: executionMode,
      }))
      return agent
    } catch (err) {
      console.error('[agents:spawn] error:', err)
      throw err
    }
  })

  ipcMain.handle('agents:kill', async (_, agentId: string) => {
    // v0.8.3: refuse kill on a foreign-local agent. If the row's PTY is on
    // a different Mac, deleting the cloud row here would leave that Mac's
    // AgentManager with a dangling runtime pointing at a tombstone. The
    // owner device must be the one to kill it.
    const refusal = refuseIfForeignLocal(agentId)
    if (refusal) throw new Error(refusal)
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
    // Same reasoning as kill: refusing here stops the "trash a local session
    // from another Mac" footgun that would orphan the owner's PTY.
    const refusal = refuseIfForeignLocal(agentId)
    if (refusal) throw new Error(refusal)
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
    // Foreign-local agents CAN'T be reattached from here — their PTY is on
    // another Mac. Return cleanly with ok:false instead of throwing, so the
    // renderer's terminal-panel-reattach effect just skips the attach and
    // falls back to the "running on <device>" placeholder.
    const refusal = refuseIfForeignLocal(agentId)
    if (refusal) return { ok: false, message: refusal, foreignLocal: true }
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
    // Swallow stdin from non-owner devices instead of throwing — UI blocks
    // input already, this is a defensive belt just in case a keystroke
    // sneaks through before the render switches to the placeholder.
    if (refuseIfForeignLocal(agentId)) return
    agentManager.writeStdin(agentId, data)
  })

  ipcMain.handle('agents:chat-send', (_, agentId: string, text: string) => {
    if (refuseIfForeignLocal(agentId)) return { ok: false, message: 'Foreign-local chat' }
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
    const refusal = refuseIfForeignLocal(agentId)
    if (refusal) return { ok: false, message: refusal }
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
    const refusal = refuseIfForeignLocal(agentId)
    if (refusal) throw new Error(refusal)
    agentManager.deleteChat(agentId)
    await cloudWrite(cloudClient.deleteAgent(agentId))
  })

  ipcMain.handle('agents:resize', (_, agentId: string, cols: number, rows: number) => {
    if (refuseIfForeignLocal(agentId)) return
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
    async (event, agentId: string, data: { tab_name?: string }) => {
      const trimmed = data.tab_name?.trim()
      if (trimmed && trimmed.length > 0) {
        repo.updateTabName(agentId, trimmed)
      }
      await cloudWrite(
        cloudClient.updateAgent(agentId, { tab_name: trimmed || undefined }),
      )
      // The rename to a `▶ ` prefix is the LaunchPlayButton's signal that
      // this terminal is the env's launch runner. Kick off port-forwarding
      // *before* the renderer's setTimeout fires writeStdin(launch_command)
      // so the PortForwarder sees the very first stdout chunks.
      if (trimmed && trimmed.startsWith('▶ ')) {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (win) agentManager.markAsLaunchAgent(agentId, win)
      }
      return repo.get(agentId) ?? null
    },
  )
}
