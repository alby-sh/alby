import { EventEmitter } from 'events'
import type { Client, ClientChannel } from 'ssh2'
import type { BrowserWindow } from 'electron'

export type AgentActivity = 'idle' | 'working'

export class RemoteAgent extends EventEmitter {
  private channel: ClientChannel | null = null
  private currentActivity: AgentActivity = 'working'
  private sessionName: string
  private detached = false
  private titlePollTimer: ReturnType<typeof setInterval> | null = null
  private waitingForReconnect = false
  private activityDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private agentId: string,
    private sshClient: Client,
    private claudeCommand: string,
    private win: BrowserWindow,
    private agentType: string = 'claude',
    customSessionName?: string
  ) {
    super()
    // customSessionName lets callers (e.g. RoutineManager) control the tmux session
    // name so it can be reattached across restarts without the agent UUID prefix.
    this.sessionName = customSessionName || `agent-${agentId.substring(0, 8)}`
  }

  start(): void {
    // Write the command to a temp script on the remote server, then start tmux with it.
    // This way the user only sees Claude Code output, not the raw bash command.
    const scriptPath = `/tmp/.agent-${this.agentId.substring(0, 8)}.sh`
    const scriptContent = `#!/bin/bash\nrm -f "${scriptPath}"\nexec ${this.claudeCommand}`
    const b64Script = Buffer.from(scriptContent).toString('base64')

    const tmuxOpts = [
      `tmux set-option -t ${this.sessionName} set-titles on`,
      `tmux set-option -t ${this.sessionName} status off`,
      // mouse OFF — xterm.js handles selection, scroll, and focus natively
      `tmux set-option -t ${this.sessionName} mouse off`,
      // Allow apps to set the pane title via OSC escape sequences (needed for activity detection)
      `tmux set-option -t ${this.sessionName} allow-rename on 2>/dev/null || true`,
      `tmux set-window-option -t ${this.sessionName} allow-rename on 2>/dev/null || true`,
      // Keep pane open after command exits so user can see output/errors
      `tmux set-option -t ${this.sessionName} remain-on-exit on 2>/dev/null || true`,
    ]
    // allow-passthrough is needed for Claude's OSC activity detection but not supported in older tmux
    if (this.agentType !== 'terminal') {
      tmuxOpts.push(`tmux set-option -t ${this.sessionName} allow-passthrough on 2>/dev/null || true`)
    }

    // Single pty exec: write script, create session, apply options, then attach.
    // Collapses two SSH round-trips (setup + attach) into one, so output reaches
    // the renderer as soon as the first command in the chain produces any bytes.
    const fullCmd = [
      `echo "${b64Script}" | base64 -d > "${scriptPath}"`,
      `chmod +x "${scriptPath}"`,
      `tmux new-session -d -s ${this.sessionName} -x 120 -y 40 "${scriptPath}"`,
      ...tmuxOpts,
      `exec tmux attach-session -t ${this.sessionName}`,
    ].join(' && ')

    this.openPty(fullCmd)
  }

  attach(): void {
    // Probe the session first. If it's gone (server reboot, manual cleanup,
    // or the wrapped command exited and the session collapsed), emit a clean
    // exit(0) so the agent is marked 'completed' instead of 'error' — these
    // are stale records, not failures the user needs to debug.
    if (!this.isSSHConnected()) {
      this.enterWaitingState()
      return
    }
    this.execSimple(
      `tmux has-session -t ${this.sessionName} 2>/dev/null && echo ALIVE || echo DEAD`,
      (_ok, output) => {
        if (output.trim() === 'ALIVE') {
          this.openPty(`tmux attach-session -t ${this.sessionName}`)
        } else {
          // Stale tmux session — surface as a clean completion, not an error.
          this.emit('exit', 0)
        }
      }
    )
  }

  private openPty(cmd: string): void {
    this.detached = false
    this.waitingForReconnect = false

    this.sshClient.exec(
      cmd,
      { pty: { cols: 120, rows: 40, term: 'xterm-256color' } },
      (err, channel) => {
        if (err) {
          console.error(`[RemoteAgent ${this.agentId}] pty exec error:`, err.message)
          // SSH might be dead — wait for reconnection instead of dying
          if (!this.isSSHConnected()) {
            this.enterWaitingState()
            return
          }
          this.emit('exit', 1)
          return
        }

        this.channel = channel

        channel.on('data', (data: Buffer) => {
          const text = data.toString('utf-8')
          // Try detecting from passthrough OSC sequences
          this.detectActivityFromOutput(text)
          this.win.webContents.send('agent:stdout', {
            agentId: this.agentId,
            data: text
          })

          // Detect tmux "Pane is dead" (shown when remain-on-exit is on and command exits)
          if (text.includes('Pane is dead')) {
            console.log(`[RemoteAgent ${this.agentId}] Pane is dead detected — exiting`)
            // Small delay to let the message render in the terminal
            setTimeout(() => {
              this.detach()
              this.emit('exit', 0)
            }, 1000)
          }
        })

        channel.stderr.on('data', (data: Buffer) => {
          this.win.webContents.send('agent:stdout', {
            agentId: this.agentId,
            data: data.toString('utf-8')
          })
        })

        channel.on('close', () => {
          this.channel = null
          this.stopTitlePolling()
          if (this.detached) return

          // Check if SSH is still alive
          if (!this.isSSHConnected()) {
            // Network died — don't exit, wait for reconnection
            this.enterWaitingState()
            return
          }

          // SSH is alive, channel closed for other reason — check tmux session
          this.checkSessionAlive()
        })

        // Start polling tmux pane title as reliable fallback (not for plain terminals)
        if (this.agentType !== 'terminal') this.startTitlePolling()
      }
    )
  }

  /**
   * Replace the SSH client (after reconnection) and reattach to the tmux session.
   */
  reconnect(newClient: Client): void {
    if (this.detached) return
    console.log(`[RemoteAgent ${this.agentId}] Reconnecting with new SSH client`)
    this.sshClient = newClient
    this.waitingForReconnect = false

    // Notify renderer that we're reconnecting
    this.win.webContents.send('agent:stdout', {
      agentId: this.agentId,
      data: '\r\n\x1b[33m[Reconnected — reattaching to session...]\x1b[0m\r\n'
    })

    // Check if the tmux session is still alive, then reattach
    this.checkSessionAlive()
  }

  isWaitingForReconnect(): boolean {
    return this.waitingForReconnect
  }

  private enterWaitingState(): void {
    this.waitingForReconnect = true
    this.stopTitlePolling()
    console.log(`[RemoteAgent ${this.agentId}] SSH disconnected — waiting for reconnection`)

    // Notify the renderer that we lost connection
    try {
      this.win.webContents.send('agent:stdout', {
        agentId: this.agentId,
        data: '\r\n\x1b[31m[Connection lost — reconnecting...]\x1b[0m\r\n'
      })
    } catch { /* window may be closed */ }
  }

  /* ============ Title polling (reliable, works through tmux) ============ */

  private startTitlePolling(): void {
    this.stopTitlePolling()
    this.titlePollTimer = setInterval(() => {
      this.pollTitle()
    }, 3000)
  }

  private stopTitlePolling(): void {
    if (this.titlePollTimer) {
      clearInterval(this.titlePollTimer)
      this.titlePollTimer = null
    }
  }

  private pollTitle(): void {
    if (this.detached || !this.isSSHConnected()) {
      this.stopTitlePolling()
      return
    }

    // tmux stores the pane title internally - read it
    this.execSimple(
      `tmux display-message -t ${this.sessionName} -p '#{pane_title}'`,
      (ok, output) => {
        if (!ok) return
        const title = output.trim()
        if (!title) return
        console.log(`[RemoteAgent ${this.agentId}] pane_title: "${title}" (${[...title].map(c => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')).slice(0, 3).join(' ')})`)
        this.updateActivity(title)
      }
    )
  }

  /* ============ Activity detection ============ */

  private detectActivityFromOutput(text: string): void {
    if (this.agentType === 'terminal') return
    // Look for the ✳ character anywhere in the output — it's unique to Claude's idle title
    // This is more reliable than parsing OSC sequences which tmux may mangle
    if (text.includes('✳')) {
      this.updateActivity('✳ idle')
      return
    }
    // Match OSC title sequences (direct or passthrough-wrapped)
    const pattern = /\]0;(.+?)(?:\x07|\x1b\\)/g
    let match
    while ((match = pattern.exec(text)) !== null) {
      this.updateActivity(match[1])
    }
  }

  private static stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').trim()
  }

  private updateActivity(title: string): void {
    // Plain terminal sessions don't set Claude-style title markers — skip activity detection
    if (this.agentType === 'terminal') return

    const clean = RemoteAgent.stripAnsi(title)

    // Ignore titles that are clearly not from the agent (tmux copy-mode, empty, bash default)
    if (!clean || /^\[\d+\/\d+\]/.test(clean) || clean === 'bash' || clean === 'zsh') return

    // Claude Code sets title to:
    //   "✳ Claude Code" when idle (waiting for input)
    //   anything else (spinner chars) when working
    // Also check for the ✳ character by codepoint (U+2733) in case of encoding differences
    const firstChar = clean.codePointAt(0)
    const isIdle = clean.startsWith('✳') || firstChar === 0x2733
    const newActivity: AgentActivity = isIdle ? 'idle' : 'working'

    if (newActivity !== this.currentActivity) {
      console.log(`[RemoteAgent ${this.agentId}] activity: ${this.currentActivity} -> ${newActivity} (title: "${clean.substring(0, 30)}", firstChar: U+${(firstChar || 0).toString(16).toUpperCase()})`)
      // Clear any pending debounce
      if (this.activityDebounceTimer) {
        clearTimeout(this.activityDebounceTimer)
        this.activityDebounceTimer = null
      }

      // Debounce idle transitions to avoid false notifications from transient title changes
      if (newActivity === 'idle') {
        this.activityDebounceTimer = setTimeout(() => {
          this.activityDebounceTimer = null
          this.currentActivity = 'idle'
          this.win.webContents.send('agent:activity', {
            agentId: this.agentId,
            activity: 'idle'
          })
          // Broadcast to the project channel so every other device running
          // Alby with the same account sees a red dot on this agent — user
          // asked for cross-device "my agent just finished" awareness.
          // Fire-and-forget — main-process fetch via cloudClient bypasses
          // renderer CORS.
          import('../cloud/cloud-client').then(({ cloudClient }) => {
            cloudClient.signalAgentIdle(this.agentId).catch((err) => {
              console.warn('[RemoteAgent] signalAgentIdle failed:', (err as Error).message)
            })
          }).catch(() => { /* ignore */ })
        }, 1500)
      } else {
        this.currentActivity = newActivity
        this.win.webContents.send('agent:activity', {
          agentId: this.agentId,
          activity: newActivity
        })
      }
    }
  }

  /* ============ Session check ============ */

  private checkSessionAlive(): void {
    if (!this.isSSHConnected()) {
      this.enterWaitingState()
      return
    }
    this.execSimple(
      `tmux has-session -t ${this.sessionName} 2>/dev/null && echo ALIVE || echo DEAD`,
      (_ok, output) => {
        if (output.trim() === 'ALIVE') {
          this.openPty(`tmux attach-session -t ${this.sessionName}`)
        } else {
          this.emit('exit', 0)
        }
      }
    )
  }

  /** Returns false as soon as ssh2's underlying TCP socket is destroyed —
   *  catches the "sleep-killed SSH but the channel still looks open" case
   *  that otherwise leaves the terminal stuck on black until the user
   *  manually reconnects. Used by agent-manager.ensureAttached so we can
   *  detect zombie runners on tab reopen. */
  isSSHAlive(): boolean {
    try {
      return !!(this.sshClient && (this.sshClient as unknown as { _sock?: { destroyed?: boolean } })._sock && !(this.sshClient as unknown as { _sock?: { destroyed?: boolean } })._sock?.destroyed)
    } catch {
      return false
    }
  }
  private isSSHConnected(): boolean {
    return this.isSSHAlive()
  }

  private execSimple(cmd: string, callback: (ok: boolean, output: string) => void): void {
    try {
      this.sshClient.exec(cmd, (err, channel) => {
        if (err) { callback(false, err.message); return }
        let out = ''
        channel.on('data', (d: Buffer) => { out += d.toString() })
        channel.stderr.on('data', (d: Buffer) => { out += d.toString() })
        channel.on('close', (code: number) => { callback(code === 0, out) })
      })
    } catch (e) {
      callback(false, (e as Error).message)
    }
  }

  writeStdin(data: string): void {
    this.channel?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.channel) {
      try { (this.channel as any).setWindow(rows, cols, 0, 0) } catch { /* ignore */ }
    }
  }

  detach(): void {
    this.detached = true
    this.waitingForReconnect = false
    this.stopTitlePolling()
    if (this.activityDebounceTimer) { clearTimeout(this.activityDebounceTimer); this.activityDebounceTimer = null }
    this.channel?.close()
    this.channel = null
  }

  kill(): Promise<void> {
    this.detached = true
    this.waitingForReconnect = false
    this.stopTitlePolling()
    if (this.activityDebounceTimer) { clearTimeout(this.activityDebounceTimer); this.activityDebounceTimer = null }

    return new Promise((resolve) => {
      if (!this.isSSHConnected()) {
        this.channel?.close()
        this.channel = null
        resolve()
        return
      }
      this.execSimple(`tmux kill-session -t ${this.sessionName}`, () => {
        this.channel?.close()
        this.channel = null
        resolve()
      })
      // Timeout in case the command hangs
      setTimeout(() => {
        this.channel?.close()
        this.channel = null
        resolve()
      }, 5000)
    })
  }

  isRunning(): boolean {
    return this.channel !== null
  }

  getSessionName(): string {
    return this.sessionName
  }

  getEnvironmentId(): string | null {
    // Will be set by AgentManager
    return (this as any)._environmentId || null
  }

  setEnvironmentId(envId: string): void {
    (this as any)._environmentId = envId
  }
}
