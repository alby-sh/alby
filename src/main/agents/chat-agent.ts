import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import type { BrowserWindow } from 'electron'
import type { Client, ClientChannel } from 'ssh2'
import { existsSync } from 'fs'

/**
 * ChatAgent: Claude Code in "stream-json" mode (headless SDK protocol).
 *
 * Runs `claude -p --output-format stream-json --input-format stream-json …`
 * either in a local child process (when sshClient is null) or inside an
 * SSH exec channel on a remote server (when sshClient is provided). The
 * rest of the logic — JSON parsing, session-id extraction, event
 * fan-out to the renderer/persistence layers — is mode-agnostic.
 *
 * We always drive the user's own `claude` binary, so no extra auth setup
 * is required beyond the CLI login the user already has.
 */

type ActivityState = 'idle' | 'working'

export interface ChatEventPayload {
  agentId: string
  /** Raw SDK event — shape depends on `type`. Renderer does the rendering. */
  event: Record<string, unknown>
}

function pickShell(): string {
  const s = process.env.SHELL
  if (s && existsSync(s)) return s
  return '/bin/zsh'
}

/** Escape a single argument for bash single-quoting: '…' with `'\''` for any
 *  embedded quote. */
function sqEscape(s: string): string {
  return s.replace(/'/g, `'\\''`)
}

export class ChatAgent extends EventEmitter {
  private child: ChildProcess | null = null
  private channel: ClientChannel | null = null
  private stdoutBuf = ''
  private stderrBuf = ''
  private currentActivity: ActivityState = 'idle'
  private readonly mode: 'local' | 'remote'

  constructor(
    private agentId: string,
    private cwd: string,
    private win: BrowserWindow,
    private systemPrompt: string,
    /** If set, spawn claude with `--resume <id>` so the conversation continues
     *  with the same context/model state instead of starting fresh. */
    private sessionId: string | null = null,
    /** When provided, the agent runs over SSH instead of as a local child —
     *  used for chat sessions on remote environments. Live cross-device
     *  transcript sync (via AgentManager) is only enabled in this mode. */
    private sshClient: Client | null = null,
  ) {
    super()
    this.mode = sshClient ? 'remote' : 'local'
  }

  isRemote(): boolean {
    return this.mode === 'remote'
  }

  /** Aliased to match LocalAgent / RemoteAgent so AgentManager can call it. */
  start(): void {
    const tag = `[ChatAgent ${this.agentId.slice(0, 8)}${this.mode === 'remote' ? ' remote' : ''}]`

    if (this.mode === 'local' && !existsSync(this.cwd)) {
      this.fail(`Local folder does not exist: ${this.cwd}`)
      return
    }

    const flags = this.buildClaudeFlags()

    if (this.mode === 'remote') {
      this.startRemote(tag, flags)
    } else {
      this.startLocal(tag, flags)
    }
  }

  private buildClaudeFlags(): string[] {
    const flags = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      // Emit per-token deltas (content_block_delta etc.) so the renderer can
      // stream the assistant bubble word-by-word instead of showing a blank
      // "typing" indicator until the full turn completes.
      '--include-partial-messages',
      // Chat has no interactive TUI for "Allow Claude to write to X?" prompts
      // — if we don't skip, the CLI prints "Claude requested permissions to
      // write to … but you haven't granted it yet" inside the conversation
      // and hangs. This mirrors the classic `claude` tab which defaults to
      // skip_permissions=true in agent_settings.
      '--dangerously-skip-permissions',
    ]
    if (this.sessionId) flags.push('--resume', this.sessionId)
    if (this.systemPrompt.trim()) flags.push('--append-system-prompt', this.systemPrompt)
    return flags
  }

  private startLocal(tag: string, flags: string[]): void {
    // Local: `shell -l -i -c "claude -p <flags>"`. A login+interactive shell
    // loads the user's dotfiles so `claude` resolves from nvm / asdf / brew.
    const shell = pickShell()
    const quoted = flags.map((a) => `'${sqEscape(a)}'`).join(' ')
    const command = `claude -p ${quoted}`
    console.log(`${tag} spawn cwd=${this.cwd} cmd=${command}`)
    try {
      this.child = spawn(shell, ['-l', '-i', '-c', command], {
        cwd: this.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      this.fail(`Failed to spawn ${shell}: ${(err as Error).message}`)
      return
    }
    if (!this.child.pid) {
      this.fail(`Spawn produced no PID (shell=${shell})`)
      return
    }
    this.updateActivity('working')
    this.bindPipes(this.child.stdout!, this.child.stderr!)
    this.child.on('exit', (code) => this.handleExit(tag, code ?? 1))
    this.child.on('error', (err) => {
      console.error(`${tag} spawn error:`, err)
      this.sendEvent({ type: 'stderr', data: `spawn error: ${err.message}` })
    })
  }

  private startRemote(tag: string, flags: string[]): void {
    if (!this.sshClient) { this.fail('ssh client missing'); return }
    // Two layers of escaping: (1) flags quoted for bash inside the remote
    // `bash -l -c '…'`, and (2) that whole inner command wrapped in single
    // quotes for the outer bash that receives the ssh exec string.
    const quotedFlags = flags.map((a) => `'${sqEscape(a)}'`).join(' ')
    const innerCmd = `cd '${sqEscape(this.cwd)}' && claude -p ${quotedFlags}`
    const outer = `bash -l -c '${sqEscape(innerCmd)}'`
    console.log(`${tag} ssh exec cwd=${this.cwd}`)
    this.sshClient.exec(outer, (err, stream) => {
      if (err) { this.fail(`ssh exec error: ${err.message}`); return }
      this.channel = stream
      this.updateActivity('working')
      this.bindPipes(stream, stream.stderr)
      stream.on('close', (code: number | null) => this.handleExit(tag, code ?? 1))
    })
  }

  private bindPipes(stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream): void {
    stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuf += chunk.toString('utf8')
      let idx = this.stdoutBuf.indexOf('\n')
      while (idx !== -1) {
        const line = this.stdoutBuf.slice(0, idx).trim()
        this.stdoutBuf = this.stdoutBuf.slice(idx + 1)
        if (line) this.handleStdoutLine(line)
        idx = this.stdoutBuf.indexOf('\n')
      }
    })
    stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      this.stderrBuf += text
      // Forward as a synthetic "stderr" event so the chat UI can show startup
      // errors (missing binary, auth failures) inline instead of a silent tab.
      this.sendEvent({ type: 'stderr', data: text })
    })
  }

  private handleExit(tag: string, code: number): void {
    console.log(`${tag} exit code=${code} stderr=${this.stderrBuf.slice(0, 200)}`)
    const tail = this.stdoutBuf.trim()
    if (tail) this.handleStdoutLine(tail)
    this.stdoutBuf = ''
    this.updateActivity('idle')
    this.child = null
    this.channel = null
    this.emit('exit', code)
  }

  private handleStdoutLine(line: string): void {
    // Claude Code emits one JSON object per line in stream-json mode.
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      const t = event.type
      // First `system` event carries the session_id — capture it so the
      // AgentManager can persist it and respawn with `--resume` later.
      if (t === 'system' && !this.sessionId) {
        const sid = (event as { session_id?: string }).session_id
        if (sid) {
          this.sessionId = sid
          this.emit('session-id', sid)
        }
      }
      // Activity: any streaming from the CLI means "working"; the final
      // `result` event means idle.
      if (t === 'result' || t === 'error') {
        this.updateActivity('idle')
      } else if (t === 'assistant' || t === 'tool_use' || t === 'user' || t === 'stream_event') {
        this.updateActivity('working')
      }
      // Emit to listeners (AgentManager stores to SQLite) and forward to renderer.
      this.emit('event', event)
      this.sendEvent(event)
    } catch {
      // Not JSON — forward as stderr so nothing gets silently swallowed.
      this.sendEvent({ type: 'stderr', data: line })
    }
  }

  /**
   * Write a user message into the CLI's stdin using the SDK's stream-json
   * input protocol: one JSON object per line, type="user".
   */
  sendUserMessage(text: string): void {
    const payload = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }
    const line = JSON.stringify(payload) + '\n'
    let wrote = false
    try {
      if (this.mode === 'remote' && this.channel) {
        this.channel.write(line)
        wrote = true
      } else if (this.mode === 'local' && this.child?.stdin) {
        this.child.stdin.write(line)
        wrote = true
      }
    } catch (err) {
      console.error('[ChatAgent] failed to write stdin:', err)
    }
    if (!wrote) return
    this.updateActivity('working')
    // The CLI doesn't echo the user turn in its stdout — emit a synthetic
    // event so the renderer sees the bubble AND the transcript logs it.
    const event = { type: 'user_input', text }
    this.emit('event', event)
    this.sendEvent(event)
  }

  /** Legacy writeStdin from the terminal API — routed to sendUserMessage so
   *  any path that funnels text through `agents:write-stdin` still works. */
  writeStdin(data: string): void {
    const trimmed = data.replace(/\r?\n$/, '')
    if (trimmed) this.sendUserMessage(trimmed)
  }

  resize(_cols: number, _rows: number): void {
    // No-op: chat isn't backed by a pty.
  }

  kill(): Promise<void> {
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch { /* ignore */ }
      this.child = null
    }
    if (this.channel) {
      try { this.channel.signal('TERM') } catch { /* ignore */ }
      try { this.channel.end() } catch { /* ignore */ }
      this.channel = null
    }
    return Promise.resolve()
  }

  isRunning(): boolean {
    return this.child !== null || this.channel !== null
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
    try {
      this.win.webContents.send('agent:chat-event', {
        agentId: this.agentId,
        event,
      } satisfies ChatEventPayload)
    } catch {
      /* ignore — window gone */
    }
  }

  private fail(message: string): void {
    console.error('[ChatAgent]', message)
    this.sendEvent({ type: 'stderr', data: `[chat-agent error] ${message}` })
    setTimeout(() => this.emit('exit', 1), 100)
  }

  private updateActivity(next: ActivityState): void {
    if (next === this.currentActivity) return
    this.currentActivity = next
    try {
      if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
      this.win.webContents.send('agent:activity', { agentId: this.agentId, activity: next })
    } catch { /* ignore */ }
  }
}
