import { EventEmitter } from 'events'
import { app, type BrowserWindow } from 'electron'
import { existsSync, appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

// node-pty is a native module — required for local execution mode.
// Loaded lazily so a missing native build only breaks local agents,
// not the whole app (remote SSH agents work without node-pty).
let pty: typeof import('node-pty') | null = null
let ptyLoadError: Error | null = null
try {
  pty = require('node-pty')
} catch (err) {
  ptyLoadError = err as Error
  console.error('[LocalAgent] node-pty failed to load:', ptyLoadError.message)
}

// Persist spawn diagnostics to a file we can ask the user to share — in a
// packaged app the main-process console is unreachable, and the in-pane
// [alby] banner gets wiped if the tab closes before the user reads it.
// File lives at ~/Library/Logs/Alby/local-agent.log on macOS.
function getLogPath(): string | null {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    return join(dir, 'local-agent.log')
  } catch {
    return null
  }
}
function persistLog(line: string): void {
  const p = getLogPath()
  if (!p) return
  try {
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch { /* log-of-last-resort, nothing useful to do */ }
}
// One-shot record at module load so even a truly broken pty shows up here.
persistLog(
  `[module-load] pty=${pty ? 'ok' : 'failed'}${
    ptyLoadError ? ' err=' + ptyLoadError.message : ''
  } shell=${process.env.SHELL ?? '<unset>'} arch=${process.arch} electron=${process.versions.electron}`,
)

function pickShell(): string {
  // Respect user's preferred shell so PATH/aliases from their dotfiles work.
  // Falls back to /bin/zsh which is the macOS default since Catalina.
  const s = process.env.SHELL
  if (s && existsSync(s)) return s
  return '/bin/zsh'
}

type AgentActivity = 'idle' | 'working'

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').trim()
}

export class LocalAgent extends EventEmitter {
  private process: ReturnType<typeof import('node-pty').spawn> | null = null
  // Local agents emit the same activity events as RemoteAgent so the sidebar
  // and tab spinners light up identically. Default to "working" until the
  // first idle marker arrives — matches RemoteAgent behaviour.
  private currentActivity: AgentActivity = 'working'
  private activityDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private agentId: string,
    private command: string,
    private cwd: string,
    private win: BrowserWindow,
    private agentType: string = 'claude',
    /** Extra env vars to inject when spawning the pty — used to pass long /
     *  newline-heavy strings (system prompt, initial prompt) WITHOUT stuffing
     *  them into the command line where shell quoting breaks on the first
     *  literal newline or unescaped quote. Referenced as "$VARNAME" inside
     *  `command`. */
    private extraEnv: Record<string, string> = {}
  ) {
    super()
    persistLog(
      `[ctor ${agentId.slice(0, 8)}] type=${agentType} cwd=${cwd} cmd=${JSON.stringify(
        command.slice(0, 200),
      )} extraEnvKeys=${Object.keys(extraEnv).join(',')}`,
    )
  }

  start(): void {
    const tag = `[LocalAgent ${this.agentId.slice(0, 8)}]`

    // Visible diagnostics printed directly to the terminal pane so the user
    // can see exactly what happened if the session never renders anything
    // useful. Paired with persistLog → the file is the source of truth even
    // if the tab closes; the in-pane echo is just convenience.
    const diag = (msg: string, color = 36): void => {
      persistLog(`${tag} ${msg}`)
      try {
        if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
        this.win.webContents.send('agent:stdout', {
          agentId: this.agentId,
          data: `\x1b[${color}m[alby] ${msg}\x1b[0m\r\n`,
        })
      } catch (e) {
        persistLog(`${tag} diag-send-failed err=${(e as Error).message}`)
      }
    }

    diag(`starting local session cwd=${this.cwd} type=${this.agentType}`)

    if (!pty) {
      this.fail(
        `node-pty is not available — local agents need it to spawn a PTY. ` +
        `Try running 'npm install && npm run postinstall'. ` +
        (ptyLoadError ? `Original error: ${ptyLoadError.message}` : '')
      )
      return
    }

    if (!existsSync(this.cwd)) {
      this.fail(`Local folder does not exist: ${this.cwd}`)
      return
    }

    const shell = pickShell()
    // Plain-terminal mode: start a login shell + force interactive (-i).
    // Without -i the shell auto-detects interactivity via isatty; that
    // detection can return false under node-pty on some macOS setups (the
    // slave fd isn't always recognised as the controlling terminal before
    // exec), making zsh exit code=1 bytes=0 the instant it starts. Passing
    // -i explicitly is what Terminal.app does internally for a new window
    // and takes the guessing out of the equation.
    const wantsInteractiveShell =
      this.agentType === 'terminal' ||
      !this.command ||
      this.command === 'bash -l' ||
      this.command === 'zsh -l'
    const args = wantsInteractiveShell
      ? ['-l', '-i']
      : ['-l', '-i', '-c', this.command]
    console.log(`${tag} spawn shell=${shell} cwd=${this.cwd} args=${JSON.stringify(args)}`)
    diag(
      `shell=${shell} ${
        wantsInteractiveShell
          ? 'mode=interactive'
          : 'command=' + JSON.stringify(this.command).slice(0, 200)
      }`,
    )

    try {
      // -l makes it a login shell so .zprofile / .bashrc / nvm / asdf paths
      // are sourced — necessary for `claude`, `gemini`, `codex` to be on PATH.
      // For AI agents we also pass -i -c <cmd> so the command runs inside an
      // interactive shell (oh-my-zsh gates some PATH config on $PS1).
      this.process = pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.cwd,
        env: { ...(process.env as Record<string, string>), ...this.extraEnv },
      })
      console.log(`${tag} spawned pid=${this.process.pid}`)
      diag(`spawned pid=${this.process.pid}`)
    } catch (err) {
      this.fail(`Failed to spawn local shell '${shell}': ${(err as Error).message}`)
      return
    }

    let firstDataLogged = false
    let totalBytes = 0
    this.process.onData((data: string) => {
      totalBytes += data.length
      if (!firstDataLogged) {
        firstDataLogged = true
        console.log(`${tag} first stdout bytes=${data.length}`)
      }
      if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
        // Window is gone (app quitting or being torn down). Kill the pty so
        // we don't get stuck emitting data into a dead receiver.
        try { this.process?.kill() } catch { /* ignore */ }
        this.process = null
        return
      }
      try {
        // Activity detection on the same OSC patterns RemoteAgent listens to —
        // local Claude/Gemini emits them regardless of host.
        this.detectActivityFromOutput(data)
        this.win.webContents.send('agent:stdout', {
          agentId: this.agentId,
          data
        })
      } catch {
        // IPC failed — webContents was likely destroyed between the check
        // and the send. Nothing we can do with the output anymore.
      }
    })

    this.process.onExit(({ exitCode }: { exitCode: number }) => {
      console.log(`${tag} exited code=${exitCode} firstData=${firstDataLogged} total=${totalBytes}`)
      diag(
        `shell exited code=${exitCode} bytes=${totalBytes}${
          totalBytes === 0
            ? " (nothing printed — check the command, your $SHELL or PATH)"
            : ""
        }`,
        exitCode === 0 ? 32 : 31,
      )
      this.process = null
      this.emit('exit', exitCode)
    })
  }

  // Push the failure both as visible stderr in the terminal AND as an exit
  // event so the UI shows it instead of an empty black pane.
  private fail(message: string): void {
    const formatted = `\r\n\x1b[31m[local-agent error]\x1b[0m ${message}\r\n`
    try {
      this.win.webContents.send('agent:stdout', { agentId: this.agentId, data: formatted })
    } catch { /* ignore */ }
    console.error('[LocalAgent]', message)
    // Defer the exit so the renderer has a chance to mount the terminal and
    // show the error before the tab gets marked as completed.
    setTimeout(() => this.emit('exit', 1), 100)
  }

  writeStdin(data: string): void {
    this.process?.write(data)
  }

  resize(cols: number, rows: number): void {
    try { this.process?.resize(cols, rows) } catch { /* ignore */ }
  }

  kill(): Promise<void> {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    return Promise.resolve()
  }

  isRunning(): boolean {
    return this.process !== null
  }

  /* ============ Activity detection (mirrors RemoteAgent) ============ */

  private detectActivityFromOutput(text: string): void {
    if (this.agentType === 'terminal') return
    // Claude's idle title contains the ✳ glyph — fastest signal.
    if (text.includes('✳')) {
      this.updateActivity('✳ idle')
      return
    }
    // Match OSC title sequences (the ones Claude/Gemini emit on activity).
    const pattern = /\]0;(.+?)(?:\x07|\x1b\\)/g
    let match
    while ((match = pattern.exec(text)) !== null) {
      this.updateActivity(match[1])
    }
  }

  private updateActivity(title: string): void {
    if (this.agentType === 'terminal') return
    const clean = stripAnsi(title)
    if (!clean || /^\[\d+\/\d+\]/.test(clean) || clean === 'bash' || clean === 'zsh') return

    const firstChar = clean.codePointAt(0)
    const isIdle = clean.startsWith('✳') || firstChar === 0x2733
    const newActivity: AgentActivity = isIdle ? 'idle' : 'working'

    if (newActivity === this.currentActivity) return

    if (this.activityDebounceTimer) {
      clearTimeout(this.activityDebounceTimer)
      this.activityDebounceTimer = null
    }

    const send = (act: AgentActivity): void => {
      try {
        if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return
        this.win.webContents.send('agent:activity', { agentId: this.agentId, activity: act })
      } catch { /* ignore */ }
    }

    if (newActivity === 'idle') {
      // Debounce idle so a transient title flicker doesn't fire a notification.
      this.activityDebounceTimer = setTimeout(() => {
        this.activityDebounceTimer = null
        this.currentActivity = 'idle'
        send('idle')
      }, 1500)
    } else {
      this.currentActivity = newActivity
      send(newActivity)
    }
  }
}
