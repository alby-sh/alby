import type Database from 'better-sqlite3'
import type { BrowserWindow } from 'electron'
import type { Client } from 'ssh2'
import { RoutinesRepo } from '../db/routines.repo'
import { ProjectsRepo } from '../db/projects.repo'
import { ConnectionPool } from '../ssh/connection-pool'
import { RemoteAgent } from './remote-agent'
import type { Routine } from '../../shared/types'

function shellEscape(value: string): string {
  // Escape chars that would break inside a double-quoted bash string
  return value.replace(/([\\$`"])/g, '\\$1')
}

function shellSingleQuote(value: string): string {
  // Safe for 'single quoted' bash strings — replace ' with '\''
  return value.replace(/'/g, `'\\''`)
}

export class RoutineManager {
  private running = new Map<string, RemoteAgent>()
  private routinesRepo: RoutinesRepo
  private projectsRepo: ProjectsRepo

  constructor(db: Database.Database, private connectionPool: ConnectionPool) {
    this.routinesRepo = new RoutinesRepo(db)
    this.projectsRepo = new ProjectsRepo(db)
  }

  private sessionName(routineId: string): string {
    return `routine-${routineId.substring(0, 8)}`
  }

  private scriptPath(routineId: string): string {
    return `/tmp/.routine-${routineId.substring(0, 8)}.sh`
  }

  private buildLoopScript(routine: Routine, remotePath: string, extraInput?: string): string {
    // The final prompt sent to the CLI is the stored prompt + any one-off
    // input the user typed in the RoutineView before pressing Start (manual
    // routines only — scheduled ones don't have a UI to collect it). We keep
    // them separated by a blank line so the base prompt stays intact and the
    // addendum reads as fresh context rather than a continuation.
    const promptForRun = extraInput && extraInput.trim().length > 0
      ? `${routine.prompt}\n\n${extraInput.trim()}`
      : routine.prompt

    // Force line-buffered stdout/stderr so the user sees output as soon as the
    // agent CLI emits each line, instead of one big wall at the end. Without
    // `stdbuf`, some CLIs (Python-backed ones especially) detect they're not
    // writing to a real TTY when tmux is in the pipeline and switch to block
    // buffering — which is what makes a manual routine look frozen for 20+
    // seconds on first token.
    //
    // v0.8.4 FIX: the previous form — `(command -v stdbuf && stdbuf X || X) --flags`
    // — is a bash SYNTAX ERROR. `(subshell) args` isn't valid bash; the parser
    // rejects it with exit 2 before a single line of the script runs, which
    // bypassed the v0.8.2 `tail -f /dev/null & wait $!` survival guard and made
    // every manual routine show "Routine is stopped, exit 0" the instant it
    // started. Rewritten as a `run_agent` function that accepts the full argv
    // and prefixes with stdbuf only when available — word-splitting-safe via
    // "$@", degrades silently on busybox / macOS without coreutils.
    const agentCmd =
      `run_agent ${routine.agent_type} --dangerously-skip-permissions -p "${shellEscape(promptForRun)}"`
    const header = [
      '#!/bin/bash',
      `# Routine: ${routine.name}`,
      // Source user shell rc so tools installed via nvm/asdf/etc end up in PATH.
      // Login shell semantics without relying on shebang args.
      '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null',
      '[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null',
      '[ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null',
      // v0.8.4: line-buffering prefix as a proper function instead of a
      // subshell-args hack. Same graceful-fallback semantics, valid bash.
      'run_agent() {',
      '  if command -v stdbuf >/dev/null 2>&1; then',
      '    stdbuf -oL -eL "$@"',
      '  else',
      '    "$@"',
      '  fi',
      '}',
      `trap 'echo "[routine] stopped"; exit 0' SIGTERM SIGINT`,
      `cd "${shellEscape(remotePath)}" || { echo "[routine] cd failed"; exit 1; }`,
      `echo -e "\\033[36m[routine] started — using $(command -v ${routine.agent_type} || echo 'NOT FOUND'): ${routine.agent_type}\\033[0m"`,
    ]
    // Visible "invoking" line + waiting hint. Without this, the agent CLI can
    // take 10-30s to emit its first token on a cold start and the terminal
    // looks stuck. The echo is the user's proof the script got past setup.
    const invokeEcho =
      `echo -e "\\033[2m[routine] invoking ${routine.agent_type} — first response can take 10–30s on a cold start…\\033[0m"`
    // Manual-only routines (interval null / 0) run the agent once and then
    // EXIT cleanly. Earlier versions parked bash on `tail -f /dev/null & wait $!`
    // to keep the tmux session alive so the user could scroll the buffer —
    // fixing a v0.8.2 race where the session died before the last bytes of
    // output reached the client. Two things made that park obsolete in v0.8.5,
    // and it actively hurts now:
    //   1. `remain-on-exit on` (set by RemoteAgent, see remote-agent.ts) keeps
    //      the tmux pane visible in "dead" state once bash exits, so the buffer
    //      survives on the server for the 1-second grace window RemoteAgent
    //      gives before emitting `exit`.
    //   2. RoutineView latches `hasRanOnce=true` and keeps TerminalPanel
    //      mounted across stop/start (v0.8.5), preserving the xterm scrollback
    //      client-side regardless of what happens server-side.
    // With the park in place, bash would wait on tail forever → the tmux
    // session never transitioned to dead → `markStopped` never fired →
    // `tmux_session_name` stayed set in the DB → `isRunning` stayed true →
    // the UI showed only a Stop button, and the user had no way to relaunch.
    // Worse: if they pressed Stop or Ctrl+C the SIGTERM/SIGINT trap exited
    // bash, the pane died, and `remain-on-exit` left a zombie session with
    // the same name — so the NEXT `tmux new-session` would fail with
    // "duplicate session" and the new start would silently re-attach to the
    // dead pane instead of running the agent again.
    // Now: let bash fall through to a natural exit. Pane dies → tmux marks it
    // dead → RemoteAgent detects "Pane is dead" → emits exit → markStopped →
    // UI flips to stopped with the xterm scrollback preserved → Start button
    // reappears. RemoteAgent.start() pre-kills any leftover session of the
    // same name so the restart is idempotent even against remain-on-exit
    // zombies (see remote-agent.ts).
    const interval = routine.interval_seconds ?? 0
    if (!interval || interval <= 0) {
      return [
        ...header,
        `echo -e "\\n\\033[36m[routine] manual run at $(date)\\033[0m"`,
        invokeEcho,
        agentCmd,
        'rc=$?',
        `echo -e "\\033[36m[routine] run finished (exit $rc)\\033[0m"`,
        `echo -e "\\033[2m[routine] click Start again — optionally with extra context in the launcher — to run another iteration.\\033[0m"`,
        'exit $rc',
        ''
      ].join('\n')
    }
    return [
      ...header,
      'while true; do',
      `  echo -e "\\n\\033[36m[routine] running at $(date)\\033[0m"`,
      `  ${invokeEcho}`,
      `  ${agentCmd}`,
      `  rc=$?`,
      `  echo -e "\\033[36m[routine] run finished (exit $rc), sleeping ${interval}s\\033[0m"`,
      `  sleep ${interval}`,
      'done',
      ''
    ].join('\n')
  }

  private writeScript(client: Client, path: string, content: string): Promise<void> {
    // Try SFTP first — it bypasses shell quoting and is the most reliable transport.
    // Fall back to base64-via-exec if SFTP is unavailable OR times out (some servers
    // are slow to open the SFTP subsystem when sshd is under MaxSessions pressure).
    return this.writeScriptViaSftp(client, path, content).catch((sftpErr: Error) => {
      console.warn(`[RoutineManager] SFTP upload failed (${sftpErr.message}) — falling back to exec`)
      return this.writeScriptViaExec(client, path, content).catch((execErr: Error) => {
        // Surface BOTH errors so the user knows neither path worked.
        throw new Error(
          `Could not upload script. SFTP: ${sftpErr.message}. exec: ${execErr.message}. ` +
          `The SSH server may be at its session limit — try increasing MaxSessions in ` +
          `/etc/ssh/sshd_config, or close some agents.`
        )
      })
    })
  }

  private writeScriptViaSftp(client: Client, path: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
      const t = setTimeout(
        () => settle(() => reject(new Error('SFTP upload timed out after 30s'))),
        30000
      )
      client.sftp((err, sftp) => {
        if (err) { clearTimeout(t); return settle(() => reject(err)) }
        const stream = sftp.createWriteStream(path, { mode: 0o755 })
        const done = (cb: () => void) => { clearTimeout(t); try { sftp.end() } catch { /* ignore */ } ; settle(cb) }
        stream.on('error', (e: Error) => done(() => reject(e)))
        // Some servers fire 'finish' but not 'close' — listen to both.
        stream.on('finish', () => done(() => resolve()))
        stream.on('close', () => done(() => resolve()))
        stream.end(content)
      })
    })
  }

  private writeScriptViaExec(client: Client, path: string, content: string): Promise<void> {
    const b64 = Buffer.from(content).toString('base64')
    const cmd = `base64 -d > "${path}" && chmod +x "${path}"`
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn() } }
      const t = setTimeout(
        () => settle(() => reject(new Error('Script upload (exec) timed out after 30s'))),
        30000
      )
      client.exec(cmd, (err, channel) => {
        if (err) { clearTimeout(t); return settle(() => reject(err)) }
        let stderr = ''
        let exitCode: number | null = null
        // Drain stdout — if we don't consume it, ssh2's flow control can deadlock
        // when the server writes anything (motd, etc) to a non-tty channel.
        channel.on('data', () => {})
        channel.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
        channel.on('exit', (code: number) => { exitCode = code })
        channel.on('close', () => {
          clearTimeout(t)
          settle(() => {
            if (exitCode === 0) resolve()
            else reject(new Error(`exit ${exitCode}: ${stderr.trim() || 'unknown error'}`))
          })
        })
        channel.end(b64)
      })
    })
  }

  private getEnvForRoutine(routine: Routine): { env: ReturnType<ProjectsRepo['getEnvironment']>; sshClient: Client | undefined } {
    const env = this.projectsRepo.getEnvironment(routine.environment_id)
    if (!env) throw new Error(`Environment not found for routine ${routine.id}`)
    const sshClient = this.connectionPool.get(env.id) || undefined
    return { env, sshClient }
  }

  async start(routineId: string, win: BrowserWindow, extraInput?: string): Promise<Routine> {
    const routine = this.routinesRepo.get(routineId)
    if (!routine) throw new Error(`Routine not found: ${routineId}`)
    if (this.running.has(routineId)) return routine

    const env = this.projectsRepo.getEnvironment(routine.environment_id)
    if (!env) throw new Error(`Environment not found: ${routine.environment_id}`)

    if (env.execution_mode !== 'remote') {
      throw new Error('Routines on local environments are not supported yet — use a remote (SSH) environment.')
    }

    console.log(`[RoutineManager] starting routine ${routineId} (${routine.name}) on ${env.ssh_host}`)

    let sshClient = this.connectionPool.get(env.id) || null
    if (!sshClient) {
      console.log(`[RoutineManager] SSH not connected, dialing ${env.ssh_host}`)
      sshClient = await this.connectionPool.connect(env)
    }

    const sessionName = this.sessionName(routineId)
    const scriptPath = this.scriptPath(routineId)

    // Upload the loop script, then let RemoteAgent open tmux + attach.
    // Scheduled routines ignore extraInput — the textarea is only rendered
    // for manual ones, but guard here too so future UI changes can't leak
    // a typed addendum into a cron run without us noticing.
    const isManual = (routine.interval_seconds ?? 0) <= 0 && !routine.cron_expression
    const loopContent = this.buildLoopScript(routine, env.remote_path, isManual ? extraInput : undefined)
    console.log(`[RoutineManager] uploading loop script to ${scriptPath} (${loopContent.length} bytes)`)
    try {
      await this.writeScript(sshClient, scriptPath, loopContent)
    } catch (err) {
      console.error(`[RoutineManager] script upload failed:`, (err as Error).message)
      throw err
    }
    console.log(`[RoutineManager] script uploaded, opening tmux session ${sessionName}`)

    const runner = new RemoteAgent(
      routineId,
      sshClient,
      // Use bash -l so ~/.bashrc is sourced for nvm/asdf users; without this
      // claude/gemini/codex may not be found in PATH inside tmux.
      `bash -l "${scriptPath}"`,
      win,
      routine.agent_type,
      sessionName
    )

    runner.on('exit', (code: number) => {
      console.log(`[RoutineManager] routine ${routineId} exited (code=${code})`)
      if (!this.running.has(routineId)) return
      this.running.delete(routineId)
      this.routinesRepo.markStopped(routineId, code)
      win.webContents.send('routine:status-change', {
        routineId, running: false, exitCode: code
      })
    })

    runner.start()
    this.running.set(routineId, runner)

    // Give tmux a moment to either spawn the session or fail, then verify.
    // This surfaces errors like "tmux not installed" or "script path wrong"
    // that otherwise would just leave the user staring at an empty terminal.
    await new Promise((r) => setTimeout(r, 800))
    const alive = await this.sessionAlive(sshClient, sessionName)
    if (!alive) {
      // Two sub-cases here:
      //   a) The exit handler already fired (routine crashed / finished super
      //      fast — possible even with tail -f /dev/null if bash itself can't
      //      start). `this.running` no longer has the routine; markStopped
      //      has already recorded the real exit code. Return silently —
      //      throwing now would race the UI into showing a toast for a
      //      routine that already updated its status.
      //   b) The session genuinely never came up (tmux missing, script path
      //      wrong, bash not found). `this.running` still has the routine
      //      because exit never fired. THIS is the original failure path.
      if (!this.running.has(routineId)) {
        console.warn(`[RoutineManager] routine ${routineId} finished before sessionAlive check — treating as normal completion`)
        return this.routinesRepo.get(routineId)!
      }
      console.error(`[RoutineManager] session ${sessionName} did not come up`)
      this.running.delete(routineId)
      try { await runner.kill() } catch { /* ignore */ }
      throw new Error(
        `tmux session did not start on the server. Check that 'tmux' and 'base64' ` +
        `are installed and that '${routine.agent_type}' is available in the login shell.`
      )
    }

    this.routinesRepo.markRunning(routineId, sessionName)
    win.webContents.send('routine:status-change', { routineId, running: true })
    console.log(`[RoutineManager] routine ${routineId} running as tmux session ${sessionName}`)
    return this.routinesRepo.get(routineId)!
  }

  async stop(routineId: string): Promise<void> {
    const runner = this.running.get(routineId)
    if (runner) {
      this.running.delete(routineId)
      await runner.kill()
    } else {
      // Session may still be alive on the server even if we lost track of it — best-effort kill.
      const routine = this.routinesRepo.get(routineId)
      if (routine?.tmux_session_name) {
        try {
          const { env, sshClient } = this.getEnvForRoutine(routine)
          if (env && sshClient) {
            await new Promise<void>((resolve) => {
              sshClient.exec(`tmux kill-session -t ${routine.tmux_session_name} 2>/dev/null || true`, (err, channel) => {
                if (err) return resolve()
                channel.on('close', () => resolve())
              })
            })
          }
        } catch { /* ignore */ }
      }
    }
    this.routinesRepo.markStopped(routineId, null)
  }

  writeStdin(routineId: string, data: string): void {
    this.running.get(routineId)?.writeStdin(data)
  }

  resize(routineId: string, cols: number, rows: number): void {
    this.running.get(routineId)?.resize(cols, rows)
  }

  async delete(routineId: string): Promise<void> {
    await this.stop(routineId)
    this.routinesRepo.delete(routineId)
  }

  isRunning(routineId: string): boolean {
    return this.running.has(routineId)
  }

  /**
   * On app boot: reattach to tmux sessions for routines that were running when
   * we last shut down. If the session is gone on the server, mark the routine
   * as stopped so the UI reflects reality.
   */
  async reconnectAll(win: BrowserWindow): Promise<void> {
    const routines = this.routinesRepo.listRunning()
    for (const routine of routines) {
      if (!routine.tmux_session_name) continue
      try {
        const env = this.projectsRepo.getEnvironment(routine.environment_id)
        if (!env) continue
        let sshClient = this.connectionPool.get(env.id) || null
        if (!sshClient) sshClient = await this.connectionPool.connect(env)

        const alive = await this.sessionAlive(sshClient, routine.tmux_session_name)
        if (!alive) {
          this.routinesRepo.markStopped(routine.id, null)
          continue
        }

        const runner = new RemoteAgent(
          routine.id,
          sshClient,
          `bash "${this.scriptPath(routine.id)}"`,
          win,
          routine.agent_type,
          routine.tmux_session_name
        )
        runner.on('exit', (code: number) => {
          if (!this.running.has(routine.id)) return
          this.running.delete(routine.id)
          this.routinesRepo.markStopped(routine.id, code)
          win.webContents.send('routine:status-change', {
            routineId: routine.id, running: false, exitCode: code
          })
        })
        // Attach to the existing session — do NOT call start() which would recreate tmux.
        runner.attach()
        this.running.set(routine.id, runner)
      } catch (err) {
        console.error(`[RoutineManager] reconnect failed for ${routine.id}:`, (err as Error).message)
        this.routinesRepo.markStopped(routine.id, null)
      }
    }
  }

  private sessionAlive(client: Client, sessionName: string): Promise<boolean> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 5000)
      client.exec(
        `tmux has-session -t ${shellSingleQuote(sessionName)} 2>/dev/null && echo A || echo D`,
        (err, channel) => {
          if (err) { clearTimeout(t); return resolve(false) }
          let out = ''
          channel.on('data', (d: Buffer) => { out += d.toString() })
          channel.on('close', () => { clearTimeout(t); resolve(out.trim() === 'A') })
        }
      )
    })
  }

  detachAll(): void {
    for (const [, runner] of this.running) runner.detach()
    this.running.clear()
  }
}
