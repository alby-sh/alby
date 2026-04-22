import { EventEmitter } from 'events'
import type { Client } from 'ssh2'
import type {
  Environment,
  DeployConfig,
} from '../../shared/types'
import { wrapCommand, platformLabel } from './shell-adapter'

export type DeployStepKind = 'pre' | 'pull' | 'post'

export interface DeployStep {
  kind: DeployStepKind
  index: number        // 0-based index within its kind
  command: string      // display form — not the wrapped form
}

export interface DeployEvents {
  info: (line: string) => void
  step: (step: DeployStep) => void
  data: (chunk: { step: DeployStep; stream: 'stdout' | 'stderr'; data: string }) => void
  stepDone: (result: { step: DeployStep; exitCode: number }) => void
  done: (summary: { ok: boolean; failedAt?: DeployStep; exitCode?: number }) => void
}

export interface DeployExecutor {
  on<K extends keyof DeployEvents>(event: K, listener: DeployEvents[K]): DeployExecutor
  emit<K extends keyof DeployEvents>(event: K, ...args: Parameters<DeployEvents[K]>): boolean
  run(): Promise<{ ok: boolean; failedAt?: DeployStep; exitCode?: number }>
  cancel(): void
}

function defaultDeployConfig(): DeployConfig {
  return { branch: 'main', pre_commands: [], post_commands: [] }
}

class RealExecutor extends EventEmitter implements DeployExecutor {
  private cancelled = false
  private currentStream: { end: () => void } | null = null

  constructor(
    private readonly client: Client,
    private readonly env: Environment,
    private readonly config: DeployConfig,
    private readonly dryRun: boolean
  ) {
    super()
  }

  cancel(): void {
    this.cancelled = true
    try { this.currentStream?.end() } catch { /* ignore */ }
  }

  async run(): Promise<{ ok: boolean; failedAt?: DeployStep; exitCode?: number }> {
    this.emit(
      'info',
      `Deploy → ${this.env.name} (${platformLabel(this.env.platform ?? 'linux')})` +
        (this.dryRun ? ' — DRY RUN, commands will be printed only' : '')
    )
    this.emit('info', `cwd: ${this.env.remote_path}`)
    this.emit('info', `branch: ${this.config.branch || 'main'}`)

    const steps: DeployStep[] = []
    this.config.pre_commands.forEach((command, index) => {
      if (command.trim()) steps.push({ kind: 'pre', index, command })
    })
    // The pull command is always present — it's the whole point of the deploy
    // pipeline. Users configure pre/post around it.
    steps.push({
      kind: 'pull',
      index: 0,
      command: `git fetch --all --prune && git checkout ${this.config.branch || 'main'} && git pull --ff-only`,
    })
    this.config.post_commands.forEach((command, index) => {
      if (command.trim()) steps.push({ kind: 'post', index, command })
    })

    for (const step of steps) {
      if (this.cancelled) {
        this.emit('info', '— cancelled —')
        const summary = { ok: false, failedAt: step, exitCode: -1 }
        this.emit('done', summary)
        return summary
      }
      this.emit('step', step)
      const wrapped = wrapCommand(this.env.platform ?? 'linux', step.command, { cwd: this.env.remote_path })

      if (this.dryRun) {
        this.emit('data', { step, stream: 'stdout', data: `$ ${wrapped}\n` })
        this.emit('stepDone', { step, exitCode: 0 })
        continue
      }

      const { code } = await this.execStreaming(step, wrapped)
      this.emit('stepDone', { step, exitCode: code })

      if (code !== 0) {
        const summary = { ok: false, failedAt: step, exitCode: code }
        this.emit('info', `✖ Step failed with exit code ${code}. Aborting.`)
        this.emit('done', summary)
        return summary
      }
    }

    this.emit('info', '✓ Deploy complete.')
    const summary = { ok: true }
    this.emit('done', summary)
    return summary
  }

  private execStreaming(step: DeployStep, wrapped: string): Promise<{ code: number }> {
    return new Promise((resolve, reject) => {
      this.client.exec(wrapped, (err, channel) => {
        if (err) {
          reject(err)
          return
        }
        this.currentStream = { end: () => channel.end() }
        channel.on('data', (d: Buffer) => {
          this.emit('data', { step, stream: 'stdout', data: d.toString() })
        })
        channel.stderr.on('data', (d: Buffer) => {
          this.emit('data', { step, stream: 'stderr', data: d.toString() })
        })
        channel.on('close', (code: number) => {
          this.currentStream = null
          resolve({ code: code ?? 0 })
        })
      })
    })
  }
}

export function createDeployExecutor(
  client: Client,
  env: Environment,
  options?: { dryRun?: boolean }
): DeployExecutor {
  const cfg: DeployConfig = env.deploy_config ?? defaultDeployConfig()
  return new RealExecutor(client, env, cfg, options?.dryRun ?? false)
}
