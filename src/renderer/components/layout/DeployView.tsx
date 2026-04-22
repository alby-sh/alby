import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, CheckmarkFilled, WarningAltFilled, Renew, Settings, Stop, Terminal as TerminalIcon } from '@carbon/icons-react'
import { useEnvironment } from '../../hooks/useProjects'
import { useAppStore } from '../../stores/app-store'
import type { Environment, SSHPreflightResult, DeployConfig } from '../../../shared/types'
import { DEFAULT_DEPLOY_CONFIG } from '../../../shared/types'

interface Props {
  environmentId: string
}

interface LogEntry {
  kind: 'info' | 'step-start' | 'step-done' | 'stdout' | 'stderr' | 'done'
  text: string
  step?: { kind: 'pre' | 'pull' | 'post'; index: number; command: string }
  ok?: boolean
  exitCode?: number
}

type RunState =
  | { status: 'idle' }
  | { status: 'running'; runId: string; dryRun: boolean; startedAt: number }
  | { status: 'done'; runId: string; dryRun: boolean; ok: boolean; exitCode?: number; durationMs: number }

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; result: SSHPreflightResult }
  | { status: 'error'; result: SSHPreflightResult }

function stepBadge(kind: 'pre' | 'pull' | 'post'): string {
  if (kind === 'pre') return 'bg-neutral-800 text-neutral-300'
  if (kind === 'pull') return 'bg-blue-500/20 text-blue-300'
  return 'bg-emerald-500/20 text-emerald-300'
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

interface GitSync {
  hasRepo: boolean
  modified: number
  staged: number
  ahead: number
  behind: number
}

interface GhAuth {
  ghInstalled: boolean
  authenticated: boolean
  username?: string
}

export function DeployView({ environmentId }: Props) {
  const { data: environment } = useEnvironment(environmentId)
  const [log, setLog] = useState<LogEntry[]>([])
  const [run, setRun] = useState<RunState>({ status: 'idle' })
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [sync, setSync] = useState<GitSync | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [ghAuth, setGhAuth] = useState<GhAuth | null>(null)
  const [authStarting, setAuthStarting] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const openEditEnvironment = useAppStore((s) => s.openEditEnvironment)
  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const logRef = useRef<HTMLDivElement>(null)
  const activeRunIdRef = useRef<string | null>(null)

  const deploy: DeployConfig = environment?.deploy_config ?? DEFAULT_DEPLOY_CONFIG
  const preCount = deploy.pre_commands.filter((c) => c.trim()).length
  const postCount = deploy.post_commands.filter((c) => c.trim()).length

  // Sync status: how far behind/ahead origin/<branch> the production tree is.
  // Refreshed on mount, every 30 s, and right after a successful deploy.
  const refreshSync = async (force = false): Promise<void> => {
    if (force) setSyncBusy(true)
    try {
      if (force) await window.electronAPI.git.fetch(environmentId).catch(() => {})
      const s = await window.electronAPI.git.status(environmentId) as GitSync
      setSync(s)
    } finally {
      if (force) setSyncBusy(false)
    }
  }
  // Refresh GitHub auth status on mount and after a successful auth flow.
  // The deploy pipeline does `git pull` which only works if the remote box
  // can authenticate to GitHub — block the run button until it can.
  const refreshGhAuth = async (): Promise<void> => {
    try {
      const r = await window.electronAPI.git.checkGitHubAuth(environmentId) as GhAuth
      setGhAuth(r)
    } catch {
      setGhAuth({ ghInstalled: false, authenticated: false })
    }
  }
  useEffect(() => {
    refreshGhAuth()
    const off = window.electronAPI.git.onGitHubAuthComplete((p) => {
      if (p.envId !== environmentId) return
      if (p.success) {
        setAuthStarting(false)
        setAuthError(null)
        setGhAuth({ ghInstalled: true, authenticated: true, username: p.username })
      } else {
        setAuthStarting(false)
        setAuthError(p.error || 'GitHub authentication failed')
      }
    })
    return () => { off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId])

  // Start gh auth login in a fresh terminal on this env. We resolve the env's
  // protected "general" task ourselves (creating it if the cloud doesn't have
  // one yet) so this works even on a fresh deploy env that has no tasks
  // visible in the UI — the previous implementation refused with
  // "Create a task in this environment first".
  const handleStartAuth = async (): Promise<void> => {
    setAuthError(null)
    setAuthStarting(true)
    try {
      let tasks = (await window.electronAPI.tasks.list(environmentId)) as Array<{ id: string; is_default?: 0 | 1; title: string }>
      let general = tasks.find((t) => t.is_default === 1)
      if (!general) {
        const created = (await window.electronAPI.tasks.create({
          environment_id: environmentId,
          title: 'general',
        })) as { id: string; is_default?: 0 | 1; title: string }
        general = created
        tasks = [...tasks, created]
      }
      const taskId = general!.id
      const installCmd = ghAuth && !ghAuth.ghInstalled
        ? 'echo "Installing gh CLI..." && ARCH=$(uname -m) && case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac && VERSION=$(curl -sL https://api.github.com/repos/cli/cli/releases/latest | grep \'"tag_name"\' | head -1 | sed -E \'s/.*"v([^"]+)".*/\\1/\') && mkdir -p ~/.local/bin && curl -sL "https://github.com/cli/cli/releases/download/v${VERSION}/gh_${VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /tmp && cp "/tmp/gh_${VERSION}_linux_${ARCH}/bin/gh" ~/.local/bin/gh && chmod +x ~/.local/bin/gh && rm -rf "/tmp/gh_${VERSION}_linux_${ARCH}" && grep -q "/.local/bin" ~/.bashrc 2>/dev/null || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc && export PATH="$HOME/.local/bin:$PATH" && echo "gh CLI installed!" && '
        : ''
      const agent = (await window.electronAPI.agents.spawn(taskId, 'terminal')) as { id: string }
      selectTask(taskId, environmentId)
      setActiveAgent(agent.id)
      const authCmd = ghAuth && !ghAuth.ghInstalled
        ? `${installCmd}~/.local/bin/gh auth login\n`
        : 'gh auth login\n'
      setTimeout(() => {
        window.electronAPI.agents.writeStdin(agent.id, authCmd)
      }, 1500)
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e))
      setAuthStarting(false)
    }
  }

  useEffect(() => {
    // Force a fresh `git fetch` on open so the behind/ahead counts reflect
    // reality before the user decides whether to deploy. Later refreshes are
    // no-fetch (cheap status check) on a 30 s interval.
    refreshSync(true)
    const t = setInterval(() => refreshSync(), 30_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [environmentId])

  // Subscribe once per environment change — the preload helpers return an
  // unsubscribe function that we call on cleanup to avoid stacking listeners.
  useEffect(() => {
    const match = (envId: string, runId: string): boolean => {
      if (envId !== environmentId) return false
      const current = activeRunIdRef.current
      return current === null || current === runId
    }

    const offInfo = window.electronAPI.deploy.onInfo((p) => {
      if (!match(p.envId, p.runId)) return
      setLog((l) => [...l, { kind: 'info', text: p.line }])
    })
    const offStep = window.electronAPI.deploy.onStep((p) => {
      if (!match(p.envId, p.runId)) return
      setLog((l) => [...l, { kind: 'step-start', text: `▶ ${p.step.kind.toUpperCase()}: ${p.step.command}`, step: p.step }])
    })
    const offData = window.electronAPI.deploy.onData((p) => {
      if (!match(p.envId, p.runId)) return
      setLog((l) => [...l, { kind: p.stream, text: p.data, step: p.step }])
    })
    const offStepDone = window.electronAPI.deploy.onStepDone((p) => {
      if (!match(p.envId, p.runId)) return
      setLog((l) => [
        ...l,
        {
          kind: 'step-done',
          text: p.exitCode === 0 ? `✓ ${p.step.kind} step done` : `✖ ${p.step.kind} step exit=${p.exitCode}`,
          step: p.step,
          exitCode: p.exitCode,
        },
      ])
    })
    const offDone = window.electronAPI.deploy.onDone((p) => {
      if (!match(p.envId, p.runId)) return
      activeRunIdRef.current = null
      setRun((current) => {
        if (current.status !== 'running') return current
        return {
          status: 'done',
          runId: p.runId,
          dryRun: p.dryRun,
          ok: p.ok,
          exitCode: p.exitCode,
          durationMs: Date.now() - current.startedAt,
        }
      })
      setLog((l) => [
        ...l,
        {
          kind: 'done',
          text: p.ok
            ? `✓ Deploy ${p.dryRun ? 'dry-run ' : ''}completed`
            : `✖ Deploy ${p.dryRun ? 'dry-run ' : ''}failed${p.error ? `: ${p.error}` : ''}`,
          ok: p.ok,
          exitCode: p.exitCode,
        },
      ])
      // Refresh the sync badge immediately — after a successful deploy the
      // tree should be at HEAD with 0 commits behind.
      if (p.ok && !p.dryRun) refreshSync(true)
    })

    return () => {
      offInfo()
      offStep()
      offData()
      offStepDone()
      offDone()
    }
  }, [environmentId])

  // Stick-to-bottom with a user override — the previous implementation forced
  // the viewport to the end on every log update, which made reading earlier
  // output impossible while a deploy was streaming. Now we only auto-scroll
  // when the user was already sitting at the bottom; if they've scrolled up
  // to read, we leave them alone and surface a "jump to bottom" button.
  const [stickToBottom, setStickToBottom] = useState(true)
  useEffect(() => {
    if (stickToBottom && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [log, stickToBottom])

  const onLogScroll = (): void => {
    const el = logRef.current
    if (!el) return
    // 32px tolerance so the "stick" flag doesn't thrash on sub-pixel jitter
    // during rapid streaming (especially with momentum scroll on macOS).
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    setStickToBottom(atBottom)
  }

  const jumpToBottom = (): void => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
    setStickToBottom(true)
  }

  const handleRun = async (dryRun: boolean): Promise<void> => {
    if (run.status === 'running') return
    setLog([])
    setRun({ status: 'running', runId: 'pending', dryRun, startedAt: Date.now() })
    try {
      const result = dryRun
        ? await window.electronAPI.deploy.dryRun(environmentId)
        : await window.electronAPI.deploy.run(environmentId)
      const { runId } = result as { runId: string }
      activeRunIdRef.current = runId
      setRun({ status: 'running', runId, dryRun, startedAt: Date.now() })
    } catch (err) {
      activeRunIdRef.current = null
      setRun({ status: 'done', runId: 'n/a', dryRun, ok: false, durationMs: 0 })
      setLog((l) => [...l, { kind: 'done', text: `✖ Could not start deploy: ${(err as Error).message}`, ok: false }])
    }
  }

  const handleCancel = async (): Promise<void> => {
    if (run.status !== 'running') return
    try {
      await window.electronAPI.deploy.cancel(run.runId)
    } catch { /* ignore */ }
  }

  const handleTest = async (): Promise<void> => {
    setTest({ status: 'running' })
    try {
      const result = (await window.electronAPI.deploy.test(environmentId)) as SSHPreflightResult
      setTest({ status: result.ok ? 'ok' : 'error', result })
    } catch (err) {
      setTest({
        status: 'error',
        result: { ok: false, code: 'IPC_ERROR', message: (err as Error).message },
      })
    }
  }

  const statusPill = useMemo(() => {
    if (run.status === 'idle') return null
    if (run.status === 'running') {
      return (
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-500/15 text-blue-300 text-[11px] font-medium">
          <Renew size={12} className="animate-spin" />
          Deploying…
        </span>
      )
    }
    return (
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium ${
          run.ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-red-500/15 text-red-300'
        }`}
      >
        {run.ok ? <CheckmarkFilled size={12} /> : <WarningAltFilled size={12} />}
        {run.ok
          ? `Success in ${formatDuration(run.durationMs)}${run.dryRun ? ' (dry run)' : ''}`
          : `Failed${run.exitCode !== undefined ? ` · exit ${run.exitCode}` : ''}${run.dryRun ? ' (dry run)' : ''}`}
      </span>
    )
  }, [run])

  if (!environment) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Environment not found.
      </div>
    )
  }

  if (environment.role !== 'deploy') {
    // DeployView should only be reached for deploy envs; bail out gracefully.
    return null
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0 gap-3">
        <div className="text-[14px] text-neutral-400 truncate">
          <span className="text-neutral-200 font-medium">{environment.name}</span>
          <span className="text-neutral-600 mx-2">·</span>
          <span>Deploy target · {environment.platform ?? 'linux'}</span>
        </div>
        <div className="flex-1" />
        {statusPill}
        <button
          type="button"
          onClick={async () => {
            // Resolve or create the env's protected "general" task, then
            // select it — MainArea falls through to the terminal view when a
            // task is selected inside a deploy env.
            try {
              const list = (await window.electronAPI.tasks.list(environmentId)) as Array<{
                id: string; is_default?: 0 | 1
              }>
              let general = list.find((t) => t.is_default === 1)
              if (!general) {
                general = (await window.electronAPI.tasks.create({
                  environment_id: environmentId,
                  title: 'general',
                })) as { id: string; is_default?: 0 | 1 }
              }
              selectTask(general!.id, environmentId)
            } catch (e) {
              console.error('[DeployView] failed to open terminals:', e)
            }
          }}
          className="h-8 px-3 flex items-center gap-1.5 rounded-md hover:bg-neutral-800 text-neutral-300 hover:text-neutral-100 text-[12px] transition-colors"
          title="Open terminals in this environment"
        >
          <TerminalIcon size={14} />
          <span>Terminals</span>
        </button>
        <button
          type="button"
          onClick={() => openEditEnvironment(environmentId)}
          className="size-8 flex items-center justify-center rounded-md hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          title="Pipeline settings"
        >
          <Settings size={16} />
        </button>
      </div>

      <div className="flex-1 grid grid-cols-[320px_1fr] min-h-0">
        {/* Sidebar: pipeline config + actions */}
        <div className="border-r border-neutral-800 overflow-y-auto">
          <div className="p-5 space-y-5">
            <section>
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Pipeline</div>
              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between">
                  <dt className="text-neutral-500">Branch</dt>
                  <dd className="text-neutral-200 font-mono">{deploy.branch || 'main'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-500">Pre-commands</dt>
                  <dd className="text-neutral-200">{preCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-500">Post-commands</dt>
                  <dd className="text-neutral-200">{postCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-500">Path</dt>
                  <dd className="text-neutral-200 font-mono text-[11px] truncate max-w-[180px]" title={environment.remote_path}>
                    {environment.remote_path}
                  </dd>
                </div>
              </dl>
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between mb-2">
                <div className="text-[11px] uppercase tracking-wider text-neutral-500">Sync with GitHub</div>
                <button
                  type="button"
                  onClick={() => refreshSync(true)}
                  disabled={syncBusy}
                  className="size-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 disabled:opacity-50 transition-colors"
                  title="Fetch from origin and recompute"
                >
                  <Renew size={12} className={syncBusy ? 'animate-spin' : ''} />
                </button>
              </div>
              <SyncBadge sync={sync} branch={deploy.branch || 'main'} />
            </section>

            <section className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">GitHub</div>
              {ghAuth === null ? (
                <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-[12px] text-neutral-500">Checking…</div>
              ) : ghAuth.authenticated ? (
                <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-[12px] text-emerald-200 flex items-center gap-2">
                  <CheckmarkFilled size={14} />
                  <span>Authenticated{ghAuth.username ? ` as ${ghAuth.username}` : ''}</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-[12px] text-amber-200">
                    GitHub auth is required before this env can <span className="font-mono">git pull</span>. {ghAuth.ghInstalled ? '' : 'gh CLI will be installed first.'}
                  </div>
                  <button
                    type="button"
                    onClick={handleStartAuth}
                    disabled={authStarting}
                    className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-md bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-neutral-50 text-[12px] transition-colors"
                  >
                    {authStarting ? <Renew size={13} className="animate-spin" /> : null}
                    {authStarting ? 'Opening terminal…' : 'Authenticate to GitHub'}
                  </button>
                  {authError && (
                    <div className="text-[11px] text-red-300">{authError}</div>
                  )}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Run</div>
              {ghAuth && !ghAuth.authenticated && (
                <div className="text-[11px] text-amber-300/90 mb-1">Deploy is disabled until GitHub auth is completed above.</div>
              )}
              {run.status === 'running' ? (
                <button
                  type="button"
                  onClick={handleCancel}
                  className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-md bg-red-600/90 hover:bg-red-600 text-white text-[13px] font-medium transition-colors"
                >
                  <Stop size={14} />
                  Cancel run
                </button>
              ) : (
                (() => {
                  const needsAuth = !!ghAuth && !ghAuth.authenticated
                  const upToDate = !!sync && sync.hasRepo && sync.behind === 0
                  const disabled = needsAuth || upToDate
                  const tooltip = needsAuth
                    ? 'Authenticate to GitHub above first.'
                    : upToDate
                    ? 'Production already matches origin/' + (deploy.branch || 'main') + '. Nothing to deploy.'
                    : ''
                  return (
                    <button
                      type="button"
                      onClick={() => handleRun(false)}
                      disabled={disabled}
                      title={tooltip}
                      className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-md bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-500 disabled:cursor-not-allowed text-white text-[13px] font-medium transition-colors"
                    >
                      <Play size={14} />
                      {upToDate ? 'No updates to deploy' : 'Deploy now'}
                    </button>
                  )
                })()
              )}
            </section>

            <section className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Connection</div>
              <button
                type="button"
                onClick={handleTest}
                disabled={test.status === 'running'}
                className="w-full inline-flex items-center justify-center gap-2 h-9 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:opacity-50 text-neutral-200 text-[12px] transition-colors"
              >
                {test.status === 'running' ? <Renew size={13} className="animate-spin" /> : null}
                Test connection
              </button>
              {test.status === 'ok' && (
                <div className="text-[11px] text-emerald-300 flex items-center gap-1.5">
                  <CheckmarkFilled size={12} /> {test.result.message || 'OK'}
                </div>
              )}
              {test.status === 'error' && (
                <div className="text-[11px] text-red-300 space-y-1">
                  <div className="flex items-center gap-1.5">
                    <WarningAltFilled size={12} />
                    <span>{test.result.message || 'Failed'}</span>
                  </div>
                  {test.result.hint && (
                    <div className="text-[11px] text-red-200/80 bg-red-500/5 border border-red-500/20 rounded p-2 whitespace-pre-wrap">
                      {test.result.hint}
                    </div>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>

        {/* Log viewer */}
        <div className="flex flex-col min-h-0 relative">
          <div
            ref={logRef}
            onScroll={onLogScroll}
            className="flex-1 overflow-y-auto bg-black/60 font-mono text-[12px] leading-relaxed p-4"
          >
            {log.length === 0 && run.status === 'idle' && (
              <div className="text-neutral-600">
                Ready. When updates land on <span className="font-mono">origin/{deploy.branch || 'main'}</span>, click <span className="text-neutral-300">Deploy now</span> to pull and run the pipeline.
              </div>
            )}
            {log.map((entry, idx) => (
              <LogLine key={idx} entry={entry} />
            ))}
          </div>
          {!stickToBottom && log.length > 0 && (
            <button
              type="button"
              onClick={jumpToBottom}
              title="Jump to latest output"
              className="absolute bottom-4 right-4 w-8 h-8 rounded-full bg-neutral-800 border border-neutral-600 flex items-center justify-center text-neutral-300 hover:bg-neutral-700 hover:text-white shadow-lg transition-all z-10"
            >
              <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

    </div>
  )
}

function LogLine({ entry }: { entry: LogEntry }) {
  if (entry.kind === 'step-start' && entry.step) {
    return (
      <div className="mt-3 mb-1 flex items-center gap-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${stepBadge(entry.step.kind)}`}>
          {entry.step.kind}
        </span>
        <span className="text-neutral-300">{entry.step.command}</span>
      </div>
    )
  }
  if (entry.kind === 'info') {
    return <div className="text-neutral-400">{entry.text}</div>
  }
  if (entry.kind === 'stderr') {
    return <div className="text-red-300 whitespace-pre-wrap">{entry.text.replace(/\n$/, '')}</div>
  }
  if (entry.kind === 'stdout') {
    return <div className="text-neutral-200 whitespace-pre-wrap">{entry.text.replace(/\n$/, '')}</div>
  }
  if (entry.kind === 'step-done') {
    return <div className={entry.exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>{entry.text}</div>
  }
  if (entry.kind === 'done') {
    return <div className={`mt-2 ${entry.ok ? 'text-emerald-300' : 'text-red-300'} font-semibold`}>{entry.text}</div>
  }
  return <div>{entry.text}</div>
}

function SyncBadge({ sync, branch }: { sync: GitSync | null; branch: string }) {
  if (!sync) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-[12px] text-neutral-500">
        Checking remote…
      </div>
    )
  }
  if (!sync.hasRepo) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-200">
        No git repository at the remote path. Initialize one or check the deploy target's path in settings.
      </div>
    )
  }
  if (sync.behind === 0 && sync.modified === 0) {
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-[12px] text-emerald-200 flex items-start gap-2">
        <CheckmarkFilled size={14} className="mt-0.5 shrink-0" />
        <div>
          <div className="font-medium text-emerald-100">Up to date</div>
          <div className="text-emerald-200/80 mt-0.5">Production matches <span className="font-mono">origin/{branch}</span>. Nothing to deploy.</div>
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-[12px] text-blue-200 space-y-1.5">
      <div className="flex items-start gap-2">
        <WarningAltFilled size={14} className="mt-0.5 shrink-0 text-blue-300" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-blue-100">Update available</div>
          {sync.behind > 0 && (
            <div className="text-blue-200/85 mt-0.5">
              Production is <span className="font-semibold">{sync.behind}</span> commit{sync.behind === 1 ? '' : 's'} behind <span className="font-mono">origin/{branch}</span> — click <span className="text-neutral-200">Deploy now</span> to update.
            </div>
          )}
          {sync.modified > 0 && (
            <div className="text-amber-200/85 mt-1">
              {sync.modified} uncommitted file{sync.modified === 1 ? '' : 's'} on the deploy target — they'll be lost if your pipeline does a clean checkout.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
