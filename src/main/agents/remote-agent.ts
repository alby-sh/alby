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
  private titlePollMs = 0
  private waitingForReconnect = false
  private activityDebounceTimer: ReturnType<typeof setTimeout> | null = null
  /** Last size the renderer asked for, kept so it survives a channel that is
   *  not open yet and gets reapplied across reattach. Mirrors LocalAgent. */
  private lastCols = 120
  private lastRows = 40

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
      // `set-clipboard external` (the default) only forwards an application's
      // OSC 52 outward when tmux believes the outer terminal takes it; without
      // the capability it keeps the text in one of its own buffers instead,
      // which is where every copy from inside a session was ending up. The
      // renderer now handles OSC 52, so say so. Server-scoped and appended, so
      // it adds to whatever the box already declares.
      `tmux set-option -ga terminal-features ',xterm-256color:clipboard' 2>/dev/null || true`,
      // Follow the most recent client rather than the smallest one, so a stale
      // attach cannot hold the pane hostage at its own dimensions.
      `tmux set-option -t ${this.sessionName} window-size latest 2>/dev/null || true`,
    ]
    // allow-passthrough is needed for Claude's OSC activity detection but not supported in older tmux
    if (this.agentType !== 'terminal') {
      tmuxOpts.push(`tmux set-option -t ${this.sessionName} allow-passthrough on 2>/dev/null || true`)
    }

    // Single pty exec: write script, create session, apply options, then attach.
    // Collapses two SSH round-trips (setup + attach) into one, so output reaches
    // the renderer as soon as the first command in the chain produces any bytes.
    //
    // Pre-kill any zombie session with the same name before `tmux new-session`.
    // `remain-on-exit on` (set in tmuxOpts above) is the behaviour we want while
    // a run is live — it freezes the pane in "dead" state when bash exits so the
    // final bytes reach the client — but it also means the SESSION outlives the
    // pane indefinitely, because tmux only garbage-collects a session once its
    // last pane is gone. Without this pre-kill, a second Start (a manual routine
    // re-run, or a reconnect after a crash) hits "duplicate session" at
    // new-session, the `&&` chain short-circuits before `attach-session`, and
    // the user either sees an error or silently re-attaches to the frozen dead
    // pane from the previous run with no fresh output. Separated with `;` and
    // wrapped in `|| true` so it's a no-op when there's nothing to kill — we
    // must not fail the chain here.
    //
    // tmux sizes a window to its SMALLEST attached client by default, so a
    // stale `attach-session` left behind by a laptop that slept — TCP will not
    // notice for hours — used to pin the pane to whatever that dead client last
    // reported. `window-size latest` (below) makes the newest client win
    // instead, which fixes that without evicting anyone.
    //
    // Do NOT reach for `attach-session -d` here. It detaches the others, and
    // when two clients both want the session — two machines, or a channel the
    // server still believes in — each one evicts the other, the evicted side
    // reconnects, and the pane resizes on every round trip. That is an endless
    // small/large flicker, not a fix.
    const fullCmd = [
      `echo "${b64Script}" | base64 -d > "${scriptPath}"`,
      `chmod +x "${scriptPath}"`,
      `{ tmux kill-session -t ${this.sessionName} 2>/dev/null || true; }`,
      `tmux new-session -d -s ${this.sessionName} -x ${this.lastCols} -y ${this.lastRows} "${scriptPath}"`,
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
          this.openPty(
            // Applied on every attach, not just on create: sessions made before
            // this option existed would otherwise keep sizing to the smallest
            // client for the rest of their life.
            `tmux set-option -t ${this.sessionName} window-size latest 2>/dev/null; ` +
            `exec tmux attach-session -t ${this.sessionName}`
          )
        } else {
          // Stale tmux session — surface as a clean completion, not an error.
          this.emit('exit', 0)
        }
      }
    )
  }

  private openPty(cmd: string): void {
    // Whatever is already open here is a second `tmux attach-session` on the
    // same session. It keeps its own data handler, keeps receiving everything
    // tmux emits, and keeps forwarding it — so the renderer writes every chunk
    // once per live channel and the text arrives doubled, or tripled, or worse.
    // Reassigning this.channel was never enough: it drops the reference while
    // leaving the channel running.
    //
    // Observed on a real host: one session with clients at 120x40 and 160x57 —
    // a stale channel still on the default pty size alongside the real one.
    //
    // Listeners come off before the close, or the 'close' handler below reads
    // it as the session dropping out and starts a reconnect for a channel we
    // are deliberately discarding.
    const previous = this.channel
    if (previous) {
      this.channel = null
      try { previous.removeAllListeners() } catch { /* ignore */ }
      try { previous.stderr?.removeAllListeners() } catch { /* ignore */ }
      try { previous.close() } catch { /* ignore */ }
    }

    this.detached = false
    this.waitingForReconnect = false

    this.sshClient.exec(
      cmd,
      // Open at the size the renderer last asked for rather than the 120x40
      // default. The panel measures itself and calls resize() as soon as it
      // mounts, which is usually while this exec is still in flight — and a
      // resize that lands before the channel exists has nowhere to go.
      { pty: { cols: this.lastCols, rows: this.lastRows, term: 'xterm-256color' } },
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

        // A resize can land between the exec call above and this callback, so
        // the pty was opened at whatever the size was then. Reapply whatever
        // is current now that there is a channel to apply it to.
        try { (channel as any).setWindow(this.lastRows, this.lastCols, 0, 0) } catch { /* ignore */ }

        channel.on('data', (data: Buffer) => {
          const text = data.toString('utf-8')
          // Try detecting from passthrough OSC sequences
          this.detectActivityFromOutput(text)
          // Fan out the raw chunk to subscribers in main (e.g.
          // PortForwarder via AgentManager). Listeners run before the IPC
          // send so any side-effect they trigger (opening a tunnel) is in
          // flight by the time the renderer paints the same line.
          this.emit('stdout-chunk', text)
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

  /* Polling the pane title is how a working -> idle transition is noticed, and
   * that transition is what fires the "your agent finished" notification, so it
   * cannot be tied to window visibility — it matters most when nobody is
   * looking. What it can do is match its rate to what it is waiting for.
   *
   * While the agent works, a completion can land at any moment and the 3 s beat
   * stays. While it sits idle the only thing that starts it up again is input,
   * and this process is the one delivering that input (see writeStdin), so the
   * fast cadence can be restored the instant it arrives rather than discovered
   * by polling. Idle agents are the common case — one `tmux display-message`
   * over SSH every 3 s each, around the clock, for sessions doing nothing. */
  private static readonly TITLE_POLL_WORKING_MS = 3000
  private static readonly TITLE_POLL_IDLE_MS = 15000

  private startTitlePolling(intervalMs = RemoteAgent.TITLE_POLL_WORKING_MS): void {
    this.stopTitlePolling()
    this.titlePollMs = intervalMs
    this.titlePollTimer = setInterval(() => {
      this.pollTitle()
    }, intervalMs)
  }

  /** Re-tunes the beat when the activity state changes; no-op if unchanged. */
  private syncTitlePollRate(): void {
    if (!this.titlePollTimer) return
    const wanted =
      this.currentActivity === 'idle'
        ? RemoteAgent.TITLE_POLL_IDLE_MS
        : RemoteAgent.TITLE_POLL_WORKING_MS
    if (wanted !== this.titlePollMs) this.startTitlePolling(wanted)
  }

  private stopTitlePolling(): void {
    if (this.titlePollTimer) {
      clearInterval(this.titlePollTimer)
      this.titlePollTimer = null
    }
    this.titlePollMs = 0
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
          this.syncTitlePollRate()
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
        this.syncTitlePollRate()
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
          this.openPty(
            // Applied on every attach, not just on create: sessions made before
            // this option existed would otherwise keep sizing to the smallest
            // client for the rest of their life.
            `tmux set-option -t ${this.sessionName} window-size latest 2>/dev/null; ` +
            `exec tmux attach-session -t ${this.sessionName}`
          )
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
    // Input is the only thing that wakes an idle agent, and it arrives here
    // first — go back to the fast beat now instead of waiting up to 15 s to
    // notice the session started working again.
    if (this.currentActivity === 'idle' && this.titlePollTimer) {
      this.startTitlePolling(RemoteAgent.TITLE_POLL_WORKING_MS)
    }
  }

  resize(cols: number, rows: number): void {
    // Always remember, even with no channel to apply it to. The panel sends
    // its first size while the pty exec is still in flight, so dropping it
    // here left the session at 120x40 with the renderer convinced it had
    // already reported — the terminal then stayed the wrong size until
    // something changed the dimensions again.
    this.lastCols = cols
    this.lastRows = rows
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
        // The local channel goes away but the tmux session on the box does
        // not, and the caller is about to delete the row that points at it.
        // Nothing here can reach the server, so say so plainly — the reaper
        // sweeps this session on the next successful connection.
        console.warn(
          `[RemoteAgent ${this.agentId}] kill requested while SSH was down; ` +
          `session ${this.sessionName} left for the reaper`
        )
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
