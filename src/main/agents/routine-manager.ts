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

  private buildLoopScript(routine: Routine, remotePath: string): string {
    // Force line-buffered stdout/stderr so the user sees output as soon as the
    // agent CLI emits each line, instead of one big wall at the end. Without
    // `stdbuf`, some CLIs (Python-backed ones especially) detect they're not
    // writing to a real TTY when tmux is in the pipeline and switch to block
    // buffering — which is what makes a manual routine look frozen for 20+
    // seconds on first token. `|| …` ensures we degrade gracefully on servers
    // that don't ship `stdbuf` (busybox / macOS without coreutils).
    const agentCmd =
      `(command -v stdbuf >/dev/null && stdbuf -oL -eL ${routine.agent_type} ` +
      `|| ${routine.agent_type}) --dangerously-skip-permissions -p "${shellEscape(routine.prompt)}"`
    const header = [
      '#!/bin/bash',
      `# Routine: ${routine.name}`,
      // Source user shell rc so tools installed via nvm/asdf/etc end up in PATH.
      // Login shell semantics without relying on shebang args.
      '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null',
      '[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null',
      '[ -f "$HOME/.profile" ] && source "$HOME/.profile" 2>/dev/null',
      `trap 'echo "[routine] stopped"; exit 0' SIGTERM SIGINT`,
      `cd "${shellEscape(remotePath)}" || { echo "[routine] cd failed"; exit 1; }`,
      `echo -e "\\033[36m[routine] started — using $(command -v ${routine.agent_type} || echo 'NOT FOUND'): ${routine.agent_type}\\033[0m"`,
    ]
    // Visible "invoking" line + waiting hint. Without this, the agent CLI can
    // take 10-30s to emit its first token on a cold start and the terminal
    // looks stuck. The echo is the user's proof the script got past setup.
    const invokeEcho =
      `echo -e "\\033[2m[routine] invoking ${routine.agent_type} — first response can take 10–30s on a cold start…\\033[0m"`
    // Manual-only routines (interval null / 0) run the agent once and exit.
    // No while-loop, so the user sees the output and the tmux session
    // naturally closes when the agent finishes — same ergonomics as a
    // regular Claude tab except kicked off by the Start button.
    const interval = routine.interval_seconds ?? 0
    if (!interval || interval <= 0) {
      return [
        ...header,
        `echo -e "\\n\\033[36m[routine] manual run at $(date)\\033[0m"`,
        invokeEcho,
        agentCmd,
        'rc=$?',
        `echo -e "\\033[36m[routine] run finished (exit $rc)\\033[0m"`,
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

  async start(routineId: string, win: BrowserWindow): Promise<Routine> {
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
    const loopContent = this.buildLoopScript(routine, env.remote_path)
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
