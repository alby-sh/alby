import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import type { Client } from 'ssh2'
import { ProjectsRepo } from '../db/projects.repo'
import { AgentsRepo } from '../db/agents.repo'
import { ConnectionPool } from '../ssh/connection-pool'
import { RemoteAgent } from './remote-agent'
import { LocalAgent } from './local-agent'
import { ChatAgent } from './chat-agent'
import { PortForwarder } from '../ssh/port-forwarder'
import { detectPortsInChunk } from '../ssh/port-detector'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import { getDeviceInfo } from '../device/device-id'
import { isLaunchTabName } from '../../shared/launch-agent'
import type { Agent, Task, Environment, Project, ForwardedPort } from '../../shared/types'

interface RunningAgent {
  agent: Agent
  runner: RemoteAgent | LocalAgent | ChatAgent
}

function getInstallCommand(agentType: string): string | null {
  switch (agentType) {
    case 'claude':
    case 'chat':
      return 'npm install -g @anthropic-ai/claude-code'
    case 'gemini':
      return 'npm install -g @google/gemini-cli'
    case 'codex':
      return 'npm install -g @openai/codex'
    default:
      return null
  }
}

function shellEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`')
}

interface ChatCloudBuffer {
  events: Array<{ seq: number; event_json: string }>
  flushTimer: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  retryDelay: number
}

export class AgentManager {
  private running: Map<string, RunningAgent> = new Map()
  private projectsRepo: ProjectsRepo
  private agentsRepo: AgentsRepo
  /**
   * Per-agent buffer of chat transcript events waiting to be pushed to the
   * cloud. Events are always written to SQLite first (source of truth on
   * this device) and mirrored to the backend with:
   *   - 500 ms debounce (smooth out streaming bursts)
   *   - hard flush at 50 queued events
   *   - exponential retry on network errors (1s → 2s → 4s → … cap 60s)
   */
  private chatCloudBuffers: Map<string, ChatCloudBuffer> = new Map()
  /**
   * Active SSH local-port-forwards, keyed by agentId. Only populated for
   * launch agents (terminals running an env's `launch_command`, recognised
   * by a `▶ ` tab_name prefix — see shared/launch-agent.ts).
   *
   * Lifecycle:
   *  - Created lazily by `attachPortForwarder` when we see a launch agent
   *    spawn or reattach. The forwarder subscribes to the runner's
   *    `stdout-chunk` event and binds a local port whenever the launch
   *    process prints an `http://localhost:N` URL.
   *  - Disposed by `disposePortForwarder` on the agent's exit/kill — closes
   *    every local server, so http://localhost:N goes back to refusing
   *    connections (matching the user's expectation that "stop" tears
   *    down the whole experience, not just the remote process).
   */
  private portForwarders: Map<string, PortForwarder> = new Map()

  constructor(
    private db: Database.Database,
    private connectionPool: ConnectionPool
  ) {
    this.projectsRepo = new ProjectsRepo(db)
    this.agentsRepo = new AgentsRepo(db)

    // When an SSH connection is restored, reattach all agents for that environment
    this.connectionPool.on('reconnected', (envId: string, newClient: Client) => {
      this.reconnectAgentsForEnvironment(envId, newClient)
    })
  }

  /**
   * When SSH reconnects for an environment, reattach all running agents that use it.
   */
  private reconnectAgentsForEnvironment(envId: string, newClient: Client): void {
    for (const [agentId, entry] of this.running) {
      if (!(entry.runner instanceof RemoteAgent)) continue
      if (entry.runner.getEnvironmentId() !== envId) continue

      if (entry.runner.isWaitingForReconnect() || !entry.runner.isRunning()) {
        console.log(`[AgentManager] Reconnecting agent ${agentId} (${entry.agent.tab_name}) to ${envId}`)
        entry.runner.reconnect(newClient)
      }
    }
  }

  /* =================== Port forwarding (launch agents) =================== */

  /** Wire a fresh PortForwarder onto a launch agent's stdout stream. The
   *  forwarder owns the per-port net.Server instances; this method just
   *  bridges three things together:
   *    1. RemoteAgent's `stdout-chunk` event → port-detector regex.
   *    2. Detected ports → forwarder.ensurePort (creates SSH tunnel).
   *    3. Forwarder's `change` / `port-opened` events → renderer IPC.
   *
   *  Idempotent: a second call for an agent that already has a forwarder
   *  is a no-op. The renderer's `agents:update` handler invokes this
   *  whenever the user renames a tab to start with `▶ ` so the timing
   *  matches the LaunchPlayButton flow (spawn → rename → writeStdin). */
  private attachPortForwarder(
    agent: Agent,
    runner: RemoteAgent,
    env: Environment,
    win: BrowserWindow,
  ): void {
    if (this.portForwarders.has(agent.id)) return

    const forwarder = new PortForwarder(
      agent.id,
      env.id,
      // Closure over the connection pool — when SSH reconnects after a
      // network drop, the pool hands out a new ssh2 Client and we want
      // every subsequent forwardOut to use the fresh one. Storing the
      // current client by reference would silently break tunnels after
      // any reconnect.
      () => this.connectionPool.get(env.id),
      (port: ForwardedPort) => {
        // Renderer pushes a toast and the local URL is auto-opened by
        // the forwarder itself via shell.openExternal.
        try { win.webContents.send('ports:port-opened', port) } catch { /* ignore */ }
      },
    )
    forwarder.on('change', (ports: ForwardedPort[]) => {
      try {
        win.webContents.send('ports:change', {
          agentId: agent.id,
          environmentId: env.id,
          ports,
        })
      } catch { /* ignore */ }
    })

    runner.on('stdout-chunk', (text: string) => {
      if (forwarder.isDisposed()) return
      const ports = detectPortsInChunk(text)
      if (ports.length === 0) return
      for (const p of ports) {
        forwarder.ensurePort(p).catch((err) => {
          console.warn(`[AgentManager] ensurePort(${p}) failed:`, (err as Error).message)
        })
      }
    })

    this.portForwarders.set(agent.id, forwarder)
    console.log(`[AgentManager] PortForwarder armed for launch agent ${agent.id} (${agent.tab_name})`)
  }

  private disposePortForwarder(agentId: string, win?: BrowserWindow): void {
    const forwarder = this.portForwarders.get(agentId)
    if (!forwarder) return
    forwarder.dispose()
    this.portForwarders.delete(agentId)
    // Best-effort renderer notification so the UI clears any "X ports
    // forwarded" indicator even before the agent's own status-change
    // event arrives. envId would be nice but the forwarder's already
    // gone; the renderer can drop the entry by agentId alone.
    if (win) {
      try { win.webContents.send('ports:change', { agentId, environmentId: null, ports: [] }) } catch { /* ignore */ }
    }
  }

  /** Public: called from `agents:update` IPC right after the renderer
   *  renames a freshly-spawned terminal to `▶ <command>`. The rename is
   *  the LaunchPlayButton's signal that this terminal is the env's
   *  launch runner — port forwarding kicks in here.
   *
   *  Local agents are skipped: the launch_command runs on the user's own
   *  machine, so its localhost is already the user's localhost. No tunnel
   *  needed. */
  markAsLaunchAgent(agentId: string, win: BrowserWindow): void {
    const entry = this.running.get(agentId)
    if (!entry) return
    if (!(entry.runner instanceof RemoteAgent)) return
    const env = this.projectsRepo.getTaskWithEnvironment(entry.agent.task_id)?.environment
    if (!env || env.execution_mode !== 'remote') return
    this.attachPortForwarder(entry.agent, entry.runner, env, win)
  }

  /** All forwarded ports an agent is currently exposing. Empty array for
   *  non-launch agents and agents without an active tunnel. */
  listForwardedPorts(agentId: string): ForwardedPort[] {
    return this.portForwarders.get(agentId)?.list() ?? []
  }

  /** Every forwarded port across every launch agent in a given env.
   *  Used by the env-level UI badge ("3 ports forwarded"). */
  listForwardedPortsForEnv(envId: string): ForwardedPort[] {
    const out: ForwardedPort[] = []
    for (const [, f] of this.portForwarders) {
      out.push(...f.list().filter((p) => p.environment_id === envId))
    }
    return out
  }

  /**
   * Walk task → env → project on the cloud and write each layer back into
   * SQLite so downstream local lookups succeed. Used as a safety net when the
   * mirror-on-read in projects.ipc.ts hasn't fired yet (e.g. cross-device
   * activity immediately after login).
   */
  private async hydrateTaskFromCloud(
    taskId: string
  ): Promise<(Task & { environment: Environment; project: Project }) | undefined> {
    if (!(await loadToken())) return undefined
    try {
      // Cloud doesn't expose a single "get task" endpoint — list through the
      // env once we know which env it belongs to. We need to find the env via
      // the listed task's own environment_id, which isn't knowable without
      // fetching the task. Walk projects → envs → tasks until we find it.
      const projects = await cloudClient.listProjects()
      for (const p of projects) {
        this.projectsRepo.upsertProject(p)
        const envs = await cloudClient.listEnvironments(p.id)
        for (const e of envs) this.projectsRepo.upsertEnvironment(e)
        for (const e of envs) {
          const tasks = await cloudClient.listTasks(e.id)
          for (const t of tasks) this.projectsRepo.upsertTask(t)
          if (tasks.some((t) => t.id === taskId)) {
            return this.projectsRepo.getTaskWithEnvironment(taskId)
          }
        }
      }
    } catch (err) {
      console.warn('[AgentManager] hydrateTaskFromCloud failed:', (err as Error).message)
    }
    return undefined
  }

  /**
   * On app startup — and whenever the renderer lists agents for a task —
   * reattach to every remote tmux session the user has running. Pulls the
   * list from the cloud (not local SQLite): a fresh install has an empty
   * local cache but the cloud still knows about sessions created from other
   * devices, and we need them to appear as live tabs, not empty placeholders.
   */
  async reconnectRunningAgents(win: BrowserWindow): Promise<void> {
    if (!(await loadToken())) {
      console.log('[AgentManager] Skip reconnect — not authenticated')
      return
    }
    let cloudAgents: Array<Agent & { task?: { id: string; environment_id: string; environment?: Environment } }> = []
    try {
      cloudAgents = (await cloudClient.listAllRunningAgents()) as typeof cloudAgents
    } catch (err) {
      console.error('[AgentManager] Failed to fetch running agents from cloud:', (err as Error).message)
      return
    }
    if (cloudAgents.length === 0) return

    console.log(`[AgentManager] Reattaching ${cloudAgents.length} cloud-side running agents`)

    for (const cloud of cloudAgents) {
      if (this.running.has(cloud.id)) continue
      const env = cloud.task?.environment
      if (!env) continue

      // Mirror into local cache so subsequent local reads find the agent
      // (agents:list, task lookups, etc.).
      try { this.agentsRepo.upsertFromCloud(cloud as Agent) } catch { /* ignore */ }
      try {
        this.projectsRepo.upsertEnvironment(env as Environment)
        if (cloud.task) {
          this.projectsRepo.upsertTask({
            id: cloud.task.id,
            environment_id: cloud.task.environment_id,
            title: (cloud.task as { title?: string }).title ?? '',
            description: null,
            context_notes: null,
            status: 'open',
            is_default: 0,
            created_at: '',
            sort_order: 0,
          } as Task)
        }
      } catch { /* ignore */ }

      // Local agents don't survive a different device, let alone an app
      // restart. Mark the record as closed and move on.
      if (env.execution_mode !== 'remote') {
        try { await cloudClient.updateAgent(cloud.id, { status: 'completed', finished_at: new Date().toISOString() }) } catch { /* ignore */ }
        continue
      }

      // Deploy envs never host agents; if one snuck into the cloud list, mark
      // it completed and skip the reattach.
      if ((env as { role?: string }).role === 'deploy') {
        try { await cloudClient.updateAgent(cloud.id, { status: 'completed', finished_at: new Date().toISOString() }) } catch { /* ignore */ }
        continue
      }

      // Chat agents don't use tmux — they're a `claude -p` child that dies
      // when SSH drops. We mark them completed so the user sees a "paused"
      // tab they can resume (restartChat spawns a fresh process with
      // --resume <session_id>). attachRemote below is tmux-only.
      if (cloud.tab_name?.toLowerCase().startsWith('chat')) {
        try { await cloudClient.updateAgent(cloud.id, { status: 'completed', finished_at: new Date().toISOString() }) } catch { /* ignore */ }
        continue
      }

      await this.attachRemote(cloud as Agent, env as Environment, win)
    }
  }

  /**
   * Idempotent: if we already have a live runner for the agent, do nothing;
   * otherwise spawn a RemoteAgent and reattach via tmux. Called lazily by
   * agents:list so that clicking a tab whose underlying SSH was never
   * reattached — e.g. after days of idleness — produces a live pane on
   * next poll instead of staying blank.
   */
  async ensureAttached(agentId: string, win: BrowserWindow): Promise<void> {
    const existing = this.running.get(agentId)
    if (existing) {
      // Chat agents own their connection lifecycle (respawn via restartChat
      // with --resume). They never go through this tmux-attach path.
      if (existing.runner instanceof ChatAgent) return
      // Local agents have no "attachment" concept — the pty is owned by this
      // process and either alive or dead. Never kill a live local runner just
      // because this code was written with remote agents in mind; doing so
      // removes it from `running`, which silently drops all subsequent
      // writeStdin IPCs (output still flows because onData writes directly
      // to webContents, which made the bug look like "terminal is alive but
      // input is broken").
      if (existing.runner instanceof LocalAgent) return
      const runner = existing.runner as RemoteAgent
      if (typeof runner.isSSHAlive === 'function' && runner.isSSHAlive()) return
      // Stale entry — drop it so attachRemote can create a fresh runner.
      console.log(`[AgentManager] Dropping zombie runner for ${agentId} (dead SSH)`)
      try { existing.runner.kill() } catch { /* ignore */ }
      this.running.delete(agentId)
    }
    const agent = this.agentsRepo.get(agentId)
    if (!agent || agent.status !== 'running') return
    // Chat tabs never auto-reattach on list. The user will see the transcript
    // replayed from DB and — when they type — restartChat kicks in on demand.
    if (agent.tab_name?.toLowerCase().startsWith('chat')) return
    const taskData = this.projectsRepo.getTaskWithEnvironment(agent.task_id)
    if (!taskData) return
    if (taskData.environment.execution_mode !== 'remote') return
    await this.attachRemote(agent, taskData.environment, win)
  }

  private async attachRemote(agent: Agent, env: Environment, win: BrowserWindow): Promise<void> {
    try {
      // Tell the renderer we're reconnecting so the empty pane can show a
      // spinner instead of pretending nothing is happening.
      try { win.webContents.send('agent:reattach', { agentId: agent.id, state: 'connecting' }) } catch { /* ignore */ }
      // Force a fresh handshake when *recovering* an agent — pool entries can
      // be silently dead after a long sleep (TCP RST that never reached us).
      // The 1-2 s extra cost is much better than "click tab, blank screen".
      const sshClient = await this.connectionPool.forceReconnect(env)
      const agentType = agent.tab_name?.split(' ')[0]?.toLowerCase() || 'claude'
      const runner = new RemoteAgent(agent.id, sshClient, '', win, agentType)
      runner.setEnvironmentId(env.id)
      runner.on('exit', (code: number) => {
        if (!this.running.has(agent.id)) return
        const status = code === 0 ? 'completed' : 'error'
        runner.kill()
        this.running.delete(agent.id)
        this.agentsRepo.updateStatus(agent.id, status, code)
        // Reflect the terminal status on the cloud so the UI sees it too.
        cloudClient
          .updateAgent(agent.id, {
            status,
            exit_code: code,
            finished_at: new Date().toISOString(),
          })
          .catch(() => { /* best effort */ })
        win.webContents.send('agent:status-change', { agentId: agent.id, status, exitCode: code })
      })
      runner.on('exit', () => this.disposePortForwarder(agent.id, win))
      runner.attach()
      this.running.set(agent.id, { agent, runner })
      // If this remote agent is the env's launch runner, re-arm its port
      // forwarder. Note: any URL the remote process printed BEFORE the
      // re-attach is gone (we only see future stdout chunks), so a launch
      // process that already printed its banner won't get auto-forwarded
      // until it re-prints — the user can stop+play to refresh. Acceptable
      // trade-off vs. running an `ss` probe on every reattach.
      if (isLaunchTabName(agent.tab_name)) {
        this.attachPortForwarder(agent, runner, env, win)
      }
      try { win.webContents.send('agent:reattach', { agentId: agent.id, state: 'connected' }) } catch { /* ignore */ }
      console.log(`[AgentManager] Reattached ${agent.tab_name} (${agent.id})`)
    } catch (err) {
      const msg = (err as Error).message
      console.error(`[AgentManager] Failed to reattach ${agent.id}:`, msg)
      try { win.webContents.send('agent:reattach', { agentId: agent.id, state: 'failed', message: msg }) } catch { /* ignore */ }
    }
  }

  async spawn(
    taskId: string,
    win: BrowserWindow,
    agentType: string = 'claude',
    autoInstall: boolean = false,
    initialPrompt?: string,
    kind?: 'auto-fix',
  ): Promise<Agent> {
    let taskData = this.projectsRepo.getTaskWithEnvironment(taskId)
    if (!taskData) {
      // Cache miss — fresh installs or newly-created-cross-device tasks may not
      // be mirrored yet. Fetch from cloud and repopulate the cache.
      taskData = await this.hydrateTaskFromCloud(taskId)
      if (!taskData) throw new Error(`Task not found: ${taskId}`)
    }

    const { environment: env } = taskData

    // Deploy envs are read-only by design — they accept a `git pull + run
    // predefined commands` deploy pipeline and shouldn't host long-lived AI
    // agents. We DO allow plain terminals though, because the deploy view's
    // "Authenticate to GitHub" flow needs an interactive shell to run
    // `gh auth login` on the remote box. AI agents stay blocked.
    if (env.role === 'deploy' && agentType !== 'terminal') {
      throw new Error(
        `Environment "${env.name}" is a deploy target — AI agents are disabled here. Use "Deploy now", or open a plain terminal for ad-hoc commands.`
      )
    }

    let sshClient = this.connectionPool.get(env.id) || null
    if (!sshClient && env.execution_mode === 'remote') {
      sshClient = await this.connectionPool.connect(env)
    }

    // Create agent record. Default tab name is just the agent type for the
    // first of its kind in a task ("Claude", "Terminal") and only appends a
    // counter for the 2nd+ ("Claude 2") so sessions don't look noisy when
    // you only have one of each. The user can always rename via the tab.
    const tabNum = this.agentsRepo.countByTask(taskId) + 1
    const pretty = agentType.charAt(0).toUpperCase() + agentType.slice(1)
    const tabName = tabNum <= 1 ? pretty : `${pretty} ${tabNum}`
    // v0.8.3: stamp device ownership on every new agent row. On remote envs
    // the PTY actually lives on the SSH host and can be re-attached from
    // any device, but we still record the Mac that kicked it off so the
    // sidebar can attribute the spawn to a teammate avatar. On local envs
    // this is the only field that tells other clients "this PTY is pinned
    // to that Mac, don't try to attach it here".
    const deviceInfo = getDeviceInfo()
    const agent = this.agentsRepo.create({
      task_id: taskId,
      tab_name: tabName,
      status: 'running',
      prompt: '',
      started_at: new Date().toISOString(),
      device_id: deviceInfo.device_id,
      device_name: deviceInfo.device_name,
      execution_mode: env.execution_mode === 'remote' ? 'remote' : 'local',
    })

    // Chat: headless claude via stream-json. No pty, no tmux — structured
    // events flow through ChatAgent to the renderer's ChatPanel.
    //   local env  → child_process; transcript stays on this device only.
    //   remote env → ssh exec; transcript synced to cloud so any device with
    //                access can replay it. (`--resume` still only works on
    //                the server that owns the claude session dir, which *is*
    //                the remote host — so continuing the conversation from
    //                another Mac works here too, unlike local chats.)
    if (agentType === 'chat') {
      this.startChatRunner(agent, taskData, env, win, sshClient)

      // Seed the very first user message if one was provided at launch — the
      // UX mirrors how passing a prompt to `claude <prompt>` auto-submits.
      if (initialPrompt?.trim()) {
        const entry = this.running.get(agent.id)
        if (entry && entry.runner instanceof ChatAgent) {
          entry.runner.sendUserMessage(initialPrompt.trim())
        }
      }

      return agent
    }

    const cdPart = `cd "${shellEscape(env.remote_path)}"`
    let remoteCmd: string
    let localCmd: string
    // Long / newline-heavy prompt strings are passed via env vars and
    // referenced as "$ALBY_…" in the shell command. Keeps the command line
    // short + unaffected by shell-escape edge cases (the old shellEscape
    // didn't handle newlines and broke zsh -c for any Claude call with a
    // real system prompt).
    const localExtraEnv: Record<string, string> = {}

    if (agentType === 'terminal') {
      // Plain terminal - just cd into the project
      remoteCmd = `bash -l -c "${shellEscape(cdPart)} && exec bash -l"`
      localCmd = 'bash -l'
    } else {
      // AI agent (claude, gemini, codex, etc.)
      const systemPrompt = this.buildSystemPrompt(taskData, agent.id, kind)
      const agentConfig = env.agent_settings?.[agentType as keyof typeof env.agent_settings] ?? { enabled: true, skip_permissions: true, use_chrome: true }
      // Remote path: the legacy shell-quoted form. Works over SSH because the
      // prompt goes through an extra layer of bash-escaping inside remoteCmd.
      const remoteCmdParts = [agentType]
      if (agentConfig.skip_permissions) remoteCmdParts.push('--dangerously-skip-permissions')
      if (agentConfig.use_chrome) remoteCmdParts.push('--chrome')
      if (systemPrompt && agentType === 'claude') {
        remoteCmdParts.push('--system-prompt', `"${shellEscape(systemPrompt)}"`)
      }
      if (initialPrompt) {
        remoteCmdParts.push(`"${shellEscape(initialPrompt)}"`)
      }
      const remoteAgentCmd = remoteCmdParts.join(' ')

      // Local path: the agent command references env vars instead of quoting
      // the prompt strings into the command line. `"$VAR"` in zsh/bash expands
      // to the variable's value as a SINGLE argument, preserving newlines and
      // all special chars verbatim. No escaping needed, no quoting bugs.
      const localCmdParts = [agentType]
      if (agentConfig.skip_permissions) localCmdParts.push('--dangerously-skip-permissions')
      if (agentConfig.use_chrome) localCmdParts.push('--chrome')
      if (systemPrompt && agentType === 'claude') {
        localExtraEnv.ALBY_SYSTEM_PROMPT = systemPrompt
        localCmdParts.push('--system-prompt', '"$ALBY_SYSTEM_PROMPT"')
      }
      if (initialPrompt) {
        localExtraEnv.ALBY_INITIAL_PROMPT = initialPrompt
        localCmdParts.push('"$ALBY_INITIAL_PROMPT"')
      }
      const localAgentCmd = localCmdParts.join(' ')

      if (autoInstall) {
        const installCmd = getInstallCommand(agentType)
        const fullScript = installCmd
          ? `${cdPart} && echo "Installing ${agentType}..." && ${installCmd} && ${remoteAgentCmd}`
          : `${cdPart} && ${remoteAgentCmd}`
        remoteCmd = `bash -l -c "${shellEscape(fullScript)}"`
        localCmd = installCmd
          ? `echo "Installing ${agentType}..." && ${installCmd} && ${localAgentCmd}`
          : localAgentCmd
      } else {
        remoteCmd = `bash -l -c "${shellEscape(`${cdPart} && ${remoteAgentCmd}`)}"`
        localCmd = localAgentCmd
      }
    }

    let runner: RemoteAgent | LocalAgent
    if (env.execution_mode === 'remote') {
      console.log(`[AgentManager] remote command (${agentType}):`, remoteCmd)
      if (!sshClient) throw new Error('SSH connection not available')
      runner = new RemoteAgent(agent.id, sshClient, remoteCmd, win, agentType)
      runner.setEnvironmentId(env.id)
    } else {
      console.log(`[AgentManager] local command (${agentType}) cwd=${env.remote_path}:`, localCmd)
      // Local: spawn directly in the user-picked folder via node-pty. Long
      // prompt strings are passed via env vars, referenced from localCmd.
      runner = new LocalAgent(agent.id, localCmd, env.remote_path, win, agentType, localExtraEnv)
    }

    runner.on('exit', (code: number) => {
      if (!this.running.has(agent.id)) return
      const status = code === 0 ? 'completed' : 'error'
      if (runner instanceof RemoteAgent) runner.kill()
      this.running.delete(agent.id)
      // Update status but keep the record so the tab stays open (user can see output/errors)
      this.agentsRepo.updateStatus(agent.id, status, code)
      // Tear down any localhost-tunnels this agent's launch_command had
      // opened. No-op for non-launch agents (the map miss is silent).
      this.disposePortForwarder(agent.id, win)
      win.webContents.send('agent:status-change', {
        agentId: agent.id, status, exitCode: code
      })
    })

    runner.start()
    this.running.set(agent.id, { agent, runner })

    return agent
  }

  writeStdin(agentId: string, data: string): void {
    const entry = this.running.get(agentId)
    entry?.runner.writeStdin(data)
  }

  /**
   * Send a user message to a chat-type agent. No-op (with a warning) if the
   * target agent is a pty-backed terminal / claude / gemini / codex — those
   * go through `writeStdin` with raw keystrokes instead.
   */
  sendChatMessage(agentId: string, text: string): boolean {
    const entry = this.running.get(agentId)
    if (!entry) return false
    if (!(entry.runner instanceof ChatAgent)) {
      console.warn(`[AgentManager] sendChatMessage on non-chat agent ${agentId} — ignored`)
      return false
    }
    entry.runner.sendUserMessage(text)
    return true
  }

  resize(agentId: string, cols: number, rows: number): void {
    const entry = this.running.get(agentId)
    entry?.runner.resize(cols, rows)
  }

  /**
   * Wire up a ChatAgent runner: session-id persistence, transcript logging,
   * activity propagation, and exit handling. Shared between initial spawn
   * (agentType === 'chat' in `spawn`) and resume (`restartChat`).
   */
  private startChatRunner(
    agent: Agent,
    taskData: Task & { environment: Environment; project: Project },
    env: Environment,
    win: BrowserWindow,
    sshClient: Client | null = null,
  ): void {
    const systemPrompt = this.buildSystemPrompt(taskData, agent.id)
    const savedSessionId = this.agentsRepo.getChatSessionId(agent.id)
    // Cross-device sync is only meaningful when the underlying claude
    // session lives on a server everyone can reach. Local chats stay on
    // the device that spawned them — no cloud writes.
    const syncToCloud = env.execution_mode === 'remote'
    const runner = new ChatAgent(agent.id, env.remote_path, win, systemPrompt, savedSessionId, sshClient)

    runner.on('session-id', (sid: string) => {
      try { this.agentsRepo.setChatSessionId(agent.id, sid) } catch (err) {
        console.warn('[ChatAgent] failed to save session_id:', (err as Error).message)
      }
      if (syncToCloud) {
        // Mirror to cloud so any other device can fetch the transcript + know
        // the session id. Fire-and-forget.
        cloudClient.updateAgent(agent.id, { chat_session_id: sid }).catch((err) => {
          console.warn('[ChatAgent] cloud updateAgent(session_id) failed:', (err as Error).message)
        })
      }
    })

    runner.on('event', (event: Record<string, unknown>) => {
      try {
        const seq = this.agentsRepo.nextTranscriptSeq(agent.id)
        this.agentsRepo.appendTranscript(agent.id, seq, JSON.stringify(event))
        if (syncToCloud) this.scheduleChatCloudFlush(agent.id, seq, event)
      } catch (err) {
        console.warn('[ChatAgent] failed to append transcript:', (err as Error).message)
      }
    })

    runner.on('exit', (code: number) => {
      if (!this.running.has(agent.id)) return
      const status = code === 0 ? 'completed' : 'error'
      this.running.delete(agent.id)
      // Chat agents keep their record + transcript around even after the
      // process dies so the tab can show the history and offer to resume.
      this.agentsRepo.updateStatus(agent.id, status, code)
      win.webContents.send('agent:status-change', {
        agentId: agent.id, status, exitCode: code,
      })
      if (syncToCloud) {
        // Flip cloud status so other devices see the session as paused.
        cloudClient.updateAgent(agent.id, {
          status, exit_code: code, finished_at: new Date().toISOString(),
        }).catch(() => { /* best effort */ })
      }
    })

    runner.start()
    this.running.set(agent.id, { agent, runner })
  }

  /**
   * Respawn a chat agent whose process previously exited. Uses the saved
   * session_id (via ChatAgent's --resume) so the new run continues the same
   * conversation. Returns true if a new runner was started.
   */
  async restartChat(agentId: string, win: BrowserWindow): Promise<boolean> {
    // If a runner already exists, nothing to do.
    if (this.running.has(agentId)) return true
    const agent = this.agentsRepo.get(agentId)
    if (!agent) return false
    const taskData = this.projectsRepo.getTaskWithEnvironment(agent.task_id)
    if (!taskData) return false
    const { environment: env } = taskData

    // Remote: make sure we have an SSH connection to the env before we try
    // to exec the remote claude process.
    let sshClient: Client | null = null
    if (env.execution_mode === 'remote') {
      sshClient = this.connectionPool.get(env.id) || null
      if (!sshClient) {
        try {
          sshClient = await this.connectionPool.connect(env)
        } catch (err) {
          console.warn('[restartChat] ssh connect failed:', (err as Error).message)
          return false
        }
      }
    }

    this.startChatRunner(agent, taskData, env, win, sshClient)
    // Refresh persisted status to running.
    try { this.agentsRepo.updateStatus(agentId, 'running') } catch { /* ignore */ }
    return true
  }

  /** True iff the given agent id corresponds to a chat-style agent. */
  private isChatAgent(agentId: string): boolean {
    const entry = this.running.get(agentId)
    if (entry && entry.runner instanceof ChatAgent) return true
    const record = this.agentsRepo.get(agentId)
    if (!record) return false
    return !!record.tab_name && record.tab_name.toLowerCase().startsWith('chat')
  }

  async kill(agentId: string): Promise<void> {
    const entry = this.running.get(agentId)
    if (entry) {
      await entry.runner.kill()
      this.running.delete(agentId)
    }
    // Chat agents keep their record + transcript + session_id so the user
    // can resume. For everyone else, `kill` is still terminal — the tab's
    // close button deletes the row.
    if (this.isChatAgent(agentId)) {
      this.agentsRepo.updateStatus(agentId, 'completed', 0)
      return
    }
    this.agentsRepo.delete(agentId)
  }

  /** Permanently delete a chat agent (transcript + session). Used when the
   *  user explicitly wants it gone, not just stopped. */
  deleteChat(agentId: string): void {
    const entry = this.running.get(agentId)
    if (entry) {
      try { entry.runner.kill() } catch { /* ignore */ }
      this.running.delete(agentId)
    }
    this.chatCloudBuffers.delete(agentId)
    this.agentsRepo.delete(agentId)
  }

  /**
   * Queue a single chat event for cloud sync. Batches bursts (claude streams
   * dozens of deltas per turn) and falls back to exponential retry if the
   * backend is momentarily unreachable. Local SQLite is the source of
   * truth — if the cloud write never succeeds, the event is still durable
   * on this device.
   */
  private scheduleChatCloudFlush(
    agentId: string,
    seq: number,
    event: Record<string, unknown>,
  ): void {
    let buf = this.chatCloudBuffers.get(agentId)
    if (!buf) {
      buf = { events: [], flushTimer: null, retryTimer: null, retryDelay: 1000 }
      this.chatCloudBuffers.set(agentId, buf)
    }
    buf.events.push({ seq, event_json: JSON.stringify(event) })

    if (buf.events.length >= 50) {
      if (buf.flushTimer) { clearTimeout(buf.flushTimer); buf.flushTimer = null }
      void this.flushChatCloudBuffer(agentId)
      return
    }
    if (buf.flushTimer) return
    buf.flushTimer = setTimeout(() => {
      const b = this.chatCloudBuffers.get(agentId)
      if (b) b.flushTimer = null
      void this.flushChatCloudBuffer(agentId)
    }, 500)
  }

  private async flushChatCloudBuffer(agentId: string): Promise<void> {
    const buf = this.chatCloudBuffers.get(agentId)
    if (!buf || buf.events.length === 0) return
    const batch = buf.events.splice(0)
    try {
      await cloudClient.appendChatEvents(agentId, batch)
      buf.retryDelay = 1000
      if (buf.retryTimer) { clearTimeout(buf.retryTimer); buf.retryTimer = null }
    } catch (err) {
      // Re-queue (at the front) and schedule a retry with backoff. Since
      // the backend key is idempotent on (agent_id, seq), a successful retry
      // that overlaps already-written seqs is harmless.
      buf.events.unshift(...batch)
      console.warn(`[ChatCloud] flush failed for ${agentId} (${buf.events.length} queued), retrying in ${buf.retryDelay}ms:`, (err as Error).message)
      if (buf.retryTimer) clearTimeout(buf.retryTimer)
      buf.retryTimer = setTimeout(() => {
        const b = this.chatCloudBuffers.get(agentId)
        if (b) b.retryTimer = null
        void this.flushChatCloudBuffer(agentId)
      }, buf.retryDelay)
      buf.retryDelay = Math.min(buf.retryDelay * 2, 60_000)
    }
  }

  getChatTranscript(agentId: string): Record<string, unknown>[] {
    return this.agentsRepo.listTranscript(agentId)
  }

  /**
   * Mirror cloud-side chat events into the local SQLite transcript. Safe
   * to call redundantly — the (agent_id, seq) PRIMARY KEY formed by
   * `${agentId}:${seq}` in AgentsRepo.appendTranscript makes overlap a
   * no-op at the SQL layer. We filter locally-known seqs first to avoid
   * the INSERT-then-fail cost.
   */
  mirrorChatTranscript(
    agentId: string,
    rows: Array<{ seq: number; event_json: string }>,
  ): void {
    if (rows.length === 0) return
    // Cheap gate: look up the current max seq once, skip anything <= it.
    let maxSeq = -1
    try {
      const row = (this.db as unknown as Database.Database)
        .prepare('SELECT COALESCE(MAX(seq), -1) AS max_seq FROM chat_transcripts WHERE agent_id = ?')
        .get(agentId) as { max_seq: number }
      maxSeq = row?.max_seq ?? -1
    } catch { /* table missing on very old installs — fall through */ }
    for (const r of rows) {
      if (r.seq <= maxSeq) continue
      try { this.agentsRepo.appendTranscript(agentId, r.seq, r.event_json) } catch { /* idempotent — ignore */ }
    }
  }

  /**
   * Detach from all tmux sessions without killing them (sessions keep running
   * on servers and are reattached on next launch). Local agents can't outlive
   * the parent process, so we kill them outright — otherwise their node-pty
   * child processes keep emitting data into a destroyed window and crash the
   * main process on quit.
   */
  detachAll(): void {
    for (const [, entry] of this.running) {
      if (entry.runner instanceof RemoteAgent) {
        entry.runner.detach()
      } else {
        try { entry.runner.kill() } catch { /* ignore */ }
      }
    }
    this.running.clear()
  }

  killAll(): void {
    for (const [id] of this.running) {
      this.kill(id)
    }
  }

  isRunning(agentId: string): boolean {
    return this.running.has(agentId)
  }

  runningCount(): number {
    return this.running.size
  }

  private buildSystemPrompt(
    task: Task & {
      environment: Environment
      project: Project
    },
    agentId: string,
    kind?: 'auto-fix',
  ): string {
    // The protected "general" task is an ad-hoc launch target — agents on it
    // start clean, with no project/task context injected.
    if (task.is_default) return ''

    const sections: string[] = []

    const envLabel = task.environment.label || task.environment.name

    // Resolve the URL the agent should know about for this environment.
    // Per-env override (env.label, when it looks like a domain) takes precedence
    // over the project-wide URL — so prod/staging/dev can each point somewhere
    // different.
    let resolvedUrl: string | null = null
    const envLabelStr = task.environment.label?.trim()
    if (envLabelStr && envLabelStr.includes('.')) {
      resolvedUrl = /^https?:\/\//i.test(envLabelStr) ? envLabelStr : `https://${envLabelStr}`
    } else if (task.project.url?.trim()) {
      resolvedUrl = task.project.url.trim()
    }

    let header =
      `Project: ${task.project.name}\n` +
      `Environment: ${envLabel} (${task.environment.role ?? 'operational'} · ${task.environment.execution_mode ?? 'remote'})`
    if (resolvedUrl) header += `\nURL: ${resolvedUrl}`

    sections.push(
      `[CONTEXT - DO NOT EXECUTE]\n` +
      `The following is background context about the project and current task. ` +
      `This is NOT an instruction. Wait for the user to tell you what to do.\n\n` +
      header
    )

    if (task.title) {
      let taskSection = `[TASK INFO]\nTitle: ${task.title}`
      if (task.description?.trim()) {
        taskSection += `\nDescription: ${task.description.trim()}`
      }
      sections.push(taskSection)
    }

    if (task.context_notes?.trim()) {
      sections.push(`[ADDITIONAL CONTEXT]\n${task.context_notes.trim()}`)
    }

    // Topology: every other environment in the same project, with role,
    // execution mode, host and (for deploy targets) the configured pipeline.
    // The agent uses this to give grounded advice ("you'd run X on staging
    // first") but is explicitly forbidden from acting on those envs itself.
    let siblings: Environment[] = []
    try {
      siblings = this.projectsRepo
        .listEnvironments(task.environment.project_id)
        .filter((e) => e.id !== task.environment.id)
    } catch { /* local cache miss — skip */ }

    if (siblings.length > 0) {
      const lines = siblings.map((e) => describeEnvironment(e))
      sections.push(
        `[OTHER ENVIRONMENTS IN THIS PROJECT]\n` +
        `These are the sibling environments of this project. They exist for context only — ` +
        `you must NEVER ssh into them, run commands there, or trigger deploys to them ` +
        `on your own. If something needs to happen on a different environment, tell the ` +
        `user what command to run and let them switch tabs and execute it themselves.\n\n` +
        lines.join('\n\n')
      )
    }

    // How Alby's deploy environments work — surface unconditionally so the
    // agent can advise the user (e.g. "your production env has no deploy
    // pipeline configured; here's how to set it up: …").
    const currentDeployBlock = describeDeploy(task.environment, true)
    sections.push(
      `[HOW ALBY DEPLOYS WORK]\n` +
      `Each project can have one or more environments with role = "deploy". A deploy ` +
      `target has no interactive shell — instead it runs a fixed pipeline configured in ` +
      `Project Settings → Environment:\n` +
      `  1. PRE-COMMANDS — anything that must happen before the code update\n` +
      `     (e.g. \`php artisan down\`, \`git stash\`, backups).\n` +
      `  2. GIT PULL on the chosen branch.\n` +
      `  3. POST-COMMANDS — migrations, cache clear, asset build, service restart.\n` +
      `The first non-zero exit aborts the rest of the pipeline. Pre/post commands can be ` +
      `Linux shell or Windows PowerShell depending on the platform set on the env.\n\n` +
      `If the user asks about deploying or any environment lacks a deploy pipeline you'd ` +
      `expect (no role=deploy env, or one with empty pre/post commands), recommend they ` +
      `add or fix it via Sidebar → right-click the environment → Environment Settings → ` +
      `set Role to "Deploy target", pick the branch, then list the pre/post commands. ` +
      `Suggest concrete commands tailored to the framework you can detect in the repo ` +
      `(Laravel, Next.js, Rails, etc.).\n\n` +
      currentDeployBlock
    )

    if (kind === 'auto-fix') {
      // Auto-fix agents are spawned from the Issue detail view's "Fix with
      // agent" button. The user has explicitly opted in to a hands-off flow:
      // we WANT the agent to commit, push and mark the issue resolved on its
      // own — stopping to ask "please click the commit button" defeats the
      // whole point of the feature. Trade-off: the auto-fix commit won't
      // carry an Activity-Report "git.commit_push" badge, since it bypasses
      // Alby's IPC. Accepted because (a) the commit message includes the
      // `alby-issue <id>` trailer, so it's still traceable, and (b) the
      // subsequent resolve POST is logged server-side with the issue id.
      sections.push(
        `[AUTO-FIX MODE — YOU ARE AUTHORISED TO COMMIT, PUSH AND RESOLVE]\n` +
        `This agent was launched from Alby's "Fix with agent" button on an ` +
        `issue. The user wants a fully automated round-trip: edit code, ` +
        `commit, push, and mark the issue resolved — no human hand-off.\n\n` +
        `Workflow for this session ONLY:\n` +
        `  1. Investigate and apply a minimal, correct fix.\n` +
        `  2. Run the repo's type-check / lint / test commands if they're ` +
        `     fast (< 60 s). Skip heavy e2e suites.\n` +
        `  3. Stage and commit yourself with \`git add <files>\` and ` +
        `     \`git commit -m '<msg>'\`. Include the trailer ` +
        `     \`alby-issue <issue-id>\` in the commit body for traceability.\n` +
        `  4. Push with \`git push\` (or \`git push -u origin <branch>\` if ` +
        `     the branch is new).\n` +
        `  5. Once the push succeeds, run the signed curl command provided ` +
        `     in the task prompt to mark the issue resolved in Alby.\n\n` +
        `Constraints (still apply):\n` +
        `  - Do NOT \`git push --force\` unless explicitly asked.\n` +
        `  - Do NOT act on sibling environments — work only on this one.\n` +
        `  - Do NOT trigger a deploy. The user runs deploys from Alby's UI.\n` +
        `  - If you cannot determine a safe fix, stop WITHOUT committing and ` +
        `    explain exactly what decision you need.\n\n` +
        `The "delegate git to Alby's UI" rule that applies to normal agents ` +
        `is suspended here: this is the one mode where direct git from the ` +
        `pty is the intended path.`
      )
    } else {
      // Tell the agent to delegate git operations and deploys to Alby's UI so
      // they're attributed to the human in the project Activity Report. Raw
      // CLI git from inside the pty bypasses the audit hook and is invisible
      // to reviewers.
      sections.push(
        `[USE ALBY'S BUILT-IN GIT & DEPLOY ACTIONS]\n` +
        `Alby tracks every commit / push / pull / fetch / discard that goes ` +
        `through its UI in the project Activity Report (cyan "git ..." badges, ` +
        `attributed to the user who clicked the button). When you run ` +
        `\`git push\`, \`git commit\`, etc. from this terminal those operations ` +
        `do NOT show up in the report — they just happen on the remote box and ` +
        `nobody on the team sees them.\n\n` +
        `Default workflow:\n` +
        `  1. Make your code changes here. Do NOT run \`git add\` / \`git commit\` ` +
        `     / \`git push\` / \`git pull\` / \`git fetch\` directly.\n` +
        `  2. When the change is ready, tell the user: "I've finished the edits ` +
        `     — please use Alby's commit button (top of the right sidebar) to ` +
        `     review the diff and push." Suggest a clear, conventional commit ` +
        `     message they can paste in.\n` +
        `  3. To pull / fetch / discard, ask them to use the same right-sidebar ` +
        `     buttons. Reason: those actions need to land in the Activity Report ` +
        `     for review, billing and team auditing.\n` +
        `  4. To deploy to a deploy-role environment, tell them to switch to ` +
        `     that env's tab and press the green "Run deploy" button — the ` +
        `     pre-commands → git pull → post-commands pipeline is logged end-to-end.\n\n` +
        `Read-only git commands (\`git status\`, \`git diff\`, \`git log\`, ` +
        `\`git branch\`, \`git show\`, \`git blame\`) are fine to run yourself — ` +
        `they don't change repository state.`
      )
    }

    const otherAgents = this.agentsRepo.list(task.id).filter((a) => a.id !== agentId)
    if (otherAgents.length > 0) {
      const agentLines = otherAgents.map((a) => {
        const summary = this.getAgentSummary(a.id)
        const statusLabel = a.status === 'running' ? 'RUNNING' : a.status === 'completed' ? 'DONE' : a.status.toUpperCase()
        let line = `- ${a.tab_name} [${statusLabel}]`
        if (summary) line += `: ${summary}`
        return line
      })
      sections.push(
        `[OTHER AGENTS ON THIS TASK]\n` +
        `The following agents are working on the same task. Coordinate and avoid duplicating their work.\n` +
        agentLines.join('\n')
      )
    }

    return sections.join('\n\n')
  }

  private getAgentSummary(agentId: string): string | null {
    const row = this.db
      .prepare('SELECT summary FROM agent_summaries WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(agentId) as { summary: string } | undefined
    return row?.summary || null
  }

  updateAgentSummary(agentId: string, taskId: string, summary: string): void {
    const { v4: uuid } = require('uuid')
    this.db
      .prepare('INSERT OR REPLACE INTO agent_summaries (id, agent_id, task_id, summary) VALUES (?, ?, ?, ?)')
      .run(uuid(), agentId, taskId, summary)
  }
}

/* ================= System-prompt helpers ================= */

function describeEnvironment(e: Environment): string {
  const lines: string[] = []
  const role = e.role ?? 'operational'
  const mode = e.execution_mode ?? 'remote'
  lines.push(`- ${e.name}${e.label ? ` (${e.label})` : ''} — ${role} · ${mode}`)
  if (mode === 'remote' && e.ssh_host) {
    const userPart = e.ssh_user ? `${e.ssh_user}@` : ''
    const portPart = e.ssh_port && e.ssh_port !== 22 ? `:${e.ssh_port}` : ''
    lines.push(`  host: ${userPart}${e.ssh_host}${portPart}`)
  }
  if (e.remote_path) lines.push(`  path: ${e.remote_path}`)
  lines.push(describeDeploy(e, false))
  return lines.join('\n')
}

function describeDeploy(e: Environment, current: boolean): string {
  const role = e.role ?? 'operational'
  const heading = current
    ? `Current environment deploy pipeline:`
    : `  deploy:`
  if (role !== 'deploy') {
    return current
      ? `${heading} N/A — this is an operational environment, no automated deploy.`
      : `${heading} not a deploy target.`
  }
  const dc = e.deploy_config
  if (!dc) {
    return current
      ? `${heading} role is "deploy" but no pipeline is configured. The user can fix this in Project Settings → Environment.`
      : `${heading} role=deploy, NO pipeline configured (suggest the user configure it).`
  }
  const pre = dc.pre_commands?.filter(Boolean) ?? []
  const post = dc.post_commands?.filter(Boolean) ?? []
  const indent = current ? '' : '    '
  const parts: string[] = []
  parts.push(`${heading}`)
  parts.push(`${indent}branch: ${dc.branch || 'main'}`)
  parts.push(`${indent}pre-commands (${pre.length}): ${pre.length ? pre.join(' && ') : '(none)'}`)
  parts.push(`${indent}post-commands (${post.length}): ${post.length ? post.join(' && ') : '(none)'}`)
  return parts.join('\n')
}
