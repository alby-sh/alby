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

const IS_WIN = process.platform === 'win32'

function pickShell(): string {
  if (IS_WIN) {
    // Prefer PowerShell 7 (`pwsh.exe`) over the built-in Windows PowerShell 5
    // (`powershell.exe`) — pwsh has better ANSI handling and is the
    // recommended shell as of 2024. Fall back to cmd.exe if neither is
    // installed (a 2009-era Windows install without the store, unlikely but
    // cheap to support). The ComSpec env var is Windows' canonical path to
    // the default command interpreter.
    const candidates = [
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files\\PowerShell\\pwsh.exe',
      process.env['ProgramFiles'] ? `${process.env['ProgramFiles']}\\PowerShell\\7\\pwsh.exe` : '',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      process.env['ComSpec'] || 'C:\\Windows\\System32\\cmd.exe',
    ].filter(Boolean)
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return process.env['ComSpec'] || 'cmd.exe'
  }
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
  // Remember the last size the renderer asked for so that when we fall back
  // to a different shell mid-start, the new pty is sized to match the
  // xterm DOM instead of staying at the 120x40 spawn default (mismatch
  // breaks cursor math, which in turn can make input look frozen).
  private lastCols = 120
  private lastRows = 40

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

    // Diagnostics. Always persisted to ~/Library/Logs/Alby/local-agent.log
    // so a post-mortem is possible even if the tab closes. Only echoed into
    // the terminal pane itself when `visible=true` (the fallback/failure
    // paths) — the success path stays quiet so the user doesn't see a
    // banner scroll by every time they open a shell.
    const diag = (msg: string, color = 36, visible = false): void => {
      persistLog(`${tag} ${msg}`)
      if (!visible) return
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

    const userShell = pickShell()
    const wantsInteractiveShell =
      this.agentType === 'terminal' ||
      !this.command ||
      this.command === 'bash -l' ||
      this.command === 'zsh -l'

    // Windows: single-attempt spawn via PowerShell / cmd. We don't need the
    // POSIX rc-file fallback ladder below — PowerShell doesn't have the
    // `.zshrc` + `.zprofile` silent-death patterns that drove that ladder
    // on macOS. `-NoLogo` hides the copyright banner on pwsh; command mode
    // uses `-Command` (or `/c` on cmd) to run the agent invocation and
    // exit. `$env:ALBY_SYSTEM_PROMPT` style refs in `this.command` are
    // prepared upstream in AgentManager (the POSIX path uses `"$VAR"`).
    if (IS_WIN) {
      const isPwsh = /pwsh\.exe$|powershell\.exe$/i.test(userShell)
      const isCmd = /cmd\.exe$/i.test(userShell)
      const winEnv: Record<string, string> = {
        ...(process.env as Record<string, string>),
        ...this.extraEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      }
      const winArgs: string[] = wantsInteractiveShell
        ? isPwsh
          ? ['-NoLogo']
          : []
        : isPwsh
          ? ['-NoLogo', '-NoProfile', '-Command', this.command]
          : isCmd
            ? ['/c', this.command]
            : []

      try {
        this.process = pty!.spawn(userShell, winArgs, {
          name: 'xterm-256color',
          cols: this.lastCols,
          rows: this.lastRows,
          cwd: this.cwd,
          env: winEnv,
        })
        console.log(`${tag} [win-primary] spawned pid=${this.process.pid} shell=${userShell} args=${JSON.stringify(winArgs)}`)
        persistLog(`${tag} [win-primary] spawn pid=${this.process.pid} shell=${userShell}`)
        diag(`[win-primary] shell=${userShell} args=${JSON.stringify(winArgs).slice(0, 120)} cwd=${this.cwd}`)
      } catch (err) {
        this.fail(`Windows shell spawn failed: ${(err as Error).message}`)
        return
      }

      this.process!.onData((data: string) => {
        if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
          try { this.process?.kill() } catch { /* ignore */ }
          this.process = null
          return
        }
        try {
          this.detectActivityFromOutput(data)
          // Fan out to main-process listeners (e.g. AgentManager's
          // localhost-URL → default-browser opener for local launch agents)
          // before the IPC send, so any side-effect they trigger is in flight
          // by the time the renderer paints the same line. Parity with
          // RemoteAgent.openPty which also emits `stdout-chunk`.
          this.emit('stdout-chunk', data)
          this.win.webContents.send('agent:stdout', {
            agentId: this.agentId,
            data,
          })
        } catch { /* ignore */ }
      })

      this.process!.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        console.log(`${tag} [win-primary] exited code=${exitCode} signal=${signal ?? 0}`)
        persistLog(`${tag} [win-primary] exited code=${exitCode} signal=${signal ?? 0}`)
        this.process = null
        this.emit('exit', exitCode)
      })
      return
    }

    // Three-step fallback ladder for spawning the local shell. Each attempt
    // produces a tagged diag line so the user can see which strategy worked
    // (or failed). Earlier revisions hard-coded `zsh -l -i` + full env —
    // some macOS setups (nvm + oh-my-zsh + custom .zprofile) produce an
    // immediate exit=1 bytes=0 under node-pty even though the same command
    // works from Terminal.app. The ladder degrades gracefully:
    //   1) user's shell + -l -i + full process.env
    //   2) user's shell + --no-rcs + minimal env (HOME/PATH/TERM/USER/LANG/SHELL only)
    //   3) /bin/bash + -l + same minimal env
    // Step 2 skips .zshrc/.zprofile, step 3 escapes zsh entirely for the
    // users whose shell config is fundamentally incompatible with a fresh
    // node-pty tty.
    interface SpawnAttempt {
      label: string
      shell: string
      args: string[]
      env: Record<string, string>
    }
    const fullEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...this.extraEnv,
    }
    // Minimal env for rc-file-less fallbacks. We inherit PATH from the parent
    // process (which was set by login / Spotlight / Terminal.app launch and
    // includes nvm's shims, Homebrew, the user's ~/.local/bin, etc.) so
    // binaries like `claude`, `gemini`, `codex`, `node` remain findable even
    // when we skip sourcing .zshrc / .zprofile. Previous revision hardcoded
    // PATH=/usr/bin:/bin:/opt/homebrew/bin which lost every nvm-managed tool.
    const minimalEnv: Record<string, string> = {
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
      TERM: 'xterm-256color',
      SHELL: userShell,
      ...this.extraEnv,
    }

    // `zsh -l` (login shell) dies silently (exit=1, bytes=0, ~180ms) on
    // packaged hardened-runtime Electron builds on some macOS setups — plain
    // `node` and `electron` dev can't reproduce, but Alby.app from
    // /Applications consistently does. We can't stop zsh from dying during
    // login init, so we sidestep it: spawn `zsh -i` instead, pre-populate
    // PATH with the paths /etc/zprofile's path_helper + ~/.zprofile's brew
    // shellenv would normally add, and let `.zshrc` handle the rest (nvm,
    // aliases, prompt). Users whose PATH setup lives exclusively in
    // ~/.zprofile will miss those exports, but that's rare — most dev setups
    // either use .zshrc for PATH or have the paths we inject covering it.
    const interactiveEnv: Record<string, string> = { ...fullEnv }
    if (!interactiveEnv.LANG && !interactiveEnv.LC_ALL) {
      interactiveEnv.LANG = 'en_US.UTF-8'
    }
    const pathParts = (interactiveEnv.PATH ?? '').split(':').filter(Boolean)
    const injectIfMissing = (p: string): void => {
      if (existsSync(p) && !pathParts.includes(p)) pathParts.unshift(p)
    }
    // Homebrew first so `brew`-installed binaries shadow system ones, matching
    // what `eval "$(/opt/homebrew/bin/brew shellenv)"` would produce.
    injectIfMissing(`${process.env.HOME}/.local/bin`)
    injectIfMissing('/opt/homebrew/bin')
    injectIfMissing('/opt/homebrew/sbin')
    injectIfMissing('/usr/local/bin')
    interactiveEnv.PATH = pathParts.join(':')
    // HOMEBREW_* vars normally set by `brew shellenv` — keep them consistent
    // so scripts that rely on them (including Homebrew's own formulae) work.
    if (existsSync('/opt/homebrew/bin/brew') && !interactiveEnv.HOMEBREW_PREFIX) {
      interactiveEnv.HOMEBREW_PREFIX = '/opt/homebrew'
      interactiveEnv.HOMEBREW_CELLAR = '/opt/homebrew/Cellar'
      interactiveEnv.HOMEBREW_REPOSITORY = '/opt/homebrew'
    }

    // Build the attempt ladder. Each attempt degrades along two axes: rc-file
    // sourcing and env cleanliness. The primary is what Terminal.app-users
    // expect; the last resort is a bare POSIX shell that can't miss.
    const attempts: SpawnAttempt[] = wantsInteractiveShell
      ? [
          // Login + interactive with augmented env. Pre-injected PATH gives
          // login rc files (brew shellenv, nvm use default) a head start, and
          // on setups where the earlier `zsh -l` silent-exit was actually
          // tripped by missing PATH entries it no longer fires.
          { label: 'primary', shell: userShell, args: ['-l', '-i'], env: interactiveEnv },
          // Interactive-only fallback — no login rc files. Sources .zshrc
          // (aliases, nvm function, prompt) but skips .zprofile. Loses
          // `nvm use default` so node won't be on PATH until the user runs
          // it themselves, but at least the shell is alive.
          { label: 'no-login', shell: userShell, args: ['-i'], env: interactiveEnv },
          // zsh's interactivity auto-detection can flake under node-pty; force
          // it via --no-rcs + -i but skip rc files. Keep the parent's PATH
          // so shell-managed binaries (nvm, brew) stay reachable.
          {
            label: 'no-rcs',
            shell: userShell,
            args: userShell.endsWith('zsh') ? ['--no-rcs', '-i'] : ['--noprofile', '--norc', '-i'],
            env: minimalEnv,
          },
          { label: 'bash-bare', shell: '/bin/bash', args: ['--noprofile', '--norc', '-i'], env: minimalEnv },
        ]
      : [
          // Command-runner mode (claude/gemini/codex). Login + interactive
          // with augmented env — gives .zprofile's `nvm use default` the
          // chance to put node on PATH before claude/gemini/codex is looked
          // up. Falls back to `-i -c` (no login) if login silently dies.
          { label: 'primary', shell: userShell, args: ['-l', '-i', '-c', this.command], env: interactiveEnv },
          { label: 'no-login', shell: userShell, args: ['-i', '-c', this.command], env: interactiveEnv },
          {
            label: 'no-rcs',
            shell: userShell,
            args: userShell.endsWith('zsh')
              ? ['--no-rcs', '-c', this.command]
              : ['--noprofile', '--norc', '-c', this.command],
            env: minimalEnv,
          },
          { label: 'bash-bare', shell: '/bin/bash', args: ['--noprofile', '--norc', '-c', this.command], env: minimalEnv },
        ]

    let attemptIdx = 0
    let currentLabel = ''
    let spawnedAt = 0
    let totalBytes = 0
    let firstDataLogged = false

    const attachListeners = (): void => {
      if (!this.process) return
      this.process.onData((data: string) => {
        totalBytes += data.length
        if (!firstDataLogged) {
          firstDataLogged = true
          console.log(`${tag} [${currentLabel}] first stdout bytes=${data.length}`)
          persistLog(
            `${tag} [${currentLabel}] first stdout pid=${this.process?.pid} bytes=${data.length}`,
          )
        }
        if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) {
          try { this.process?.kill() } catch { /* ignore */ }
          this.process = null
          return
        }
        try {
          this.detectActivityFromOutput(data)
          // Same as the Windows primary onData handler: emit to main-process
          // listeners before IPC so the localhost URL → browser opener can
          // react before the renderer repaints. Must stay in sync with the
          // onData at ~line 200.
          this.emit('stdout-chunk', data)
          this.win.webContents.send('agent:stdout', {
            agentId: this.agentId,
            data,
          })
        } catch { /* ignore — window torn down mid-write */ }
      })

      this.process.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        const elapsedMs = Date.now() - spawnedAt
        console.log(
          `${tag} [${currentLabel}] exited code=${exitCode} signal=${signal ?? 0} firstData=${firstDataLogged} total=${totalBytes} elapsedMs=${elapsedMs}`,
        )
        persistLog(
          `${tag} [${currentLabel}] exited code=${exitCode} signal=${signal ?? 0} firstData=${firstDataLogged} bytes=${totalBytes} elapsedMs=${elapsedMs}`,
        )
        // If the shell died nearly-instantly without ever printing anything,
        // the most likely cause is rc-file breakage or env incompatibility —
        // or zsh exiting clean code=0 because it couldn't acquire a
        // controlling tty (seen on some macOS + node-pty + Electron combos:
        // the tty is there, but zsh reads EOF on stdin immediately and
        // interprets that as "session ended successfully"). Either way,
        // zero output in < 2s means the session is unusable, regardless of
        // exit code — fall back.
        const earlyFailure = !firstDataLogged && totalBytes === 0 && elapsedMs < 2000
        if (earlyFailure && attemptIdx < attempts.length) {
          diag(
            `[${currentLabel}] exited code=${exitCode} sig=${signal ?? 0} bytes=0 in ${elapsedMs}ms — falling back`,
            33,
            true,
          )
          this.process = null
          firstDataLogged = false
          totalBytes = 0
          if (tryNext()) {
            attachListeners()
            return
          }
        }
        diag(
          `[${currentLabel}] shell exited code=${exitCode} bytes=${totalBytes}${
            totalBytes === 0
              ? ' (nothing printed — all fallback shells failed, check ~/Library/Logs/Alby/local-agent.log)'
              : ''
          }`,
          exitCode === 0 ? 32 : 31,
          totalBytes === 0,
        )
        this.process = null
        this.emit('exit', exitCode)
      })
    }

    const tryNext = (): boolean => {
      if (attemptIdx >= attempts.length) return false
      const a = attempts[attemptIdx]
      attemptIdx++
      try {
        this.process = pty!.spawn(a.shell, a.args, {
          name: 'xterm-256color',
          cols: this.lastCols,
          rows: this.lastRows,
          cwd: this.cwd,
          env: a.env,
        })
        currentLabel = a.label
        spawnedAt = Date.now()
        console.log(`${tag} [${a.label}] spawned pid=${this.process.pid} shell=${a.shell} args=${JSON.stringify(a.args)}`)
        diag(
          `[${a.label}] shell=${a.shell} args=${JSON.stringify(a.args).slice(0, 120)} envKeys=${Object.keys(a.env).length} cols=${this.lastCols} rows=${this.lastRows}`,
        )
        return true
      } catch (err) {
        const msg = (err as Error).message
        persistLog(`${tag} [${a.label}] spawn threw: ${msg}`)
        diag(`[${a.label}] spawn threw: ${msg}`, 31, true)
        return tryNext()
      }
    }

    if (!tryNext()) {
      this.fail(`All spawn attempts failed. Last shell tried: ${userShell}`)
      return
    }
    attachListeners()
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
    if (!this.process) {
      persistLog(`[LocalAgent ${this.agentId.slice(0, 8)}] writeStdin DROPPED (no process) len=${data.length}`)
      return
    }
    try {
      this.process.write(data)
      persistLog(
        `[LocalAgent ${this.agentId.slice(0, 8)}] writeStdin pid=${this.process.pid} len=${data.length} firstByte=${data.charCodeAt(0)}`,
      )
    } catch (err) {
      persistLog(
        `[LocalAgent ${this.agentId.slice(0, 8)}] writeStdin THREW err=${(err as Error).message}`,
      )
    }
  }

  resize(cols: number, rows: number): void {
    this.lastCols = cols
    this.lastRows = rows
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
