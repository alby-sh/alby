import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Close, CheckmarkFilled, ChevronLeft } from '@carbon/icons-react'
import { useEnvironments, useAllProjects } from '../../hooks/useProjects'
import { useApps, useIssues } from '../../hooks/useIssues'
import { AlertsPanel } from './AlertsPanel'
import { useAgentStdout } from '../../hooks/useAgents'
import { useAppStore } from '../../stores/app-store'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import type { Environment, ReportingApp } from '../../../shared/types'

interface LogLine {
  kind: 'info' | 'ok' | 'error'
  text: string
}

export function IssuesSetupView({
  projectId,
  stackId,
  onBackToList,
}: {
  projectId: string
  stackId?: string | null
  /** Present only when the wizard was opened from the list (via "Manage
   *  install"). Closes the wizard and returns to the table. Absent on the
   *  initial pre-install/waiting flow, where there's no list to go back to. */
  onBackToList?: () => void
}) {
  const closeIssues = useAppStore((s) => s.closeIssues)
  const { data: allEnvironments = [], isLoading } = useEnvironments(projectId)
  const { data: allApps = [] } = useApps(projectId)
  const { data: allProjects = [] } = useAllProjects()
  const project = useMemo(
    () => allProjects.find((p) => p.id === projectId) ?? null,
    [allProjects, projectId],
  )
  const qc = useQueryClient()

  // Every stack owns its own detector install target + its own apps. We
  // scope strictly to `stackId` here so switching stacks never shows another
  // stack's monitoring state as if it applied. `projectId`-only callers
  // (none left in practice, but back-compat) see the full project.
  const environments = useMemo(
    () => (stackId ? allEnvironments.filter((e) => e.stack_id === stackId) : allEnvironments),
    [allEnvironments, stackId],
  )
  const apps = useMemo(() => {
    if (!stackId) return allApps
    const envIdsInStack = new Set(environments.map((e) => e.id))
    return allApps.filter((a) => a.environment_id && envIdsInStack.has(a.environment_id))
  }, [allApps, environments, stackId])

  const installableEnvs = useMemo(
    () => environments.filter((e) => e.role !== 'deploy'),
    [environments],
  )
  const monitoredEnv = useMemo(
    () => installableEnvs.find((e) => e.app != null) ?? null,
    [installableEnvs],
  )
  const currentApp = useMemo<ReportingApp | null>(
    () =>
      apps.find((a) => a.environment_id && a.environment_id === monitoredEnv?.id) ??
      apps[0] ??
      null,
    [apps, monitoredEnv],
  )

  // Poll the issues endpoint for the newly-created app — first event flipping
  // total from 0 → 1 is the signal that the detector is actually reporting.
  const { data: issuesPage } = useIssues(currentApp?.id ?? null, { status: 'all' })
  const totalEvents = issuesPage?.total ?? 0

  const [selectedEnvId, setSelectedEnvId] = useState<string>('')
  const [installAgentId, setInstallAgentId] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const [installing, setInstalling] = useState(false)
  // Baseline event count at the moment the user clicked Install/Re-install.
  // Used so that during a re-install we don't immediately show "first event
  // received" off old issues from the previous install — we only flip when a
  // NEW event comes in after this attempt started.
  const [installBaselineEvents, setInstallBaselineEvents] = useState<number | null>(null)

  // "First event received" has two meanings:
  //   - First-ever install: any event at all is the go-signal.
  //   - Re-install (user clicked again while issues already exist): only
  //     events received AFTER the click count — otherwise the wizard would
  //     claim "installed" the instant the user opens it.
  const hasFirstEvent =
    installBaselineEvents == null
      ? totalEvents > 0
      : totalEvents > installBaselineEvents
  const [testEvent, setTestEvent] = useState<
    { status: 'idle' } | { status: 'running' } | { status: 'ok' } | { status: 'error'; message: string }
  >({ status: 'idle' })

  // Default-select: prefer the stack's current host env (auto-fix target) or
  // its already-monitored env; fall back to the first installable env.
  useEffect(() => {
    if (selectedEnvId) return
    if (monitoredEnv) setSelectedEnvId(monitoredEnv.id)
    else if (installableEnvs.length > 0) setSelectedEnvId(installableEnvs[0].id)
  }, [monitoredEnv, installableEnvs, selectedEnvId])

  const pushLog = useCallback((line: LogLine): void => {
    setLog((prev) => [...prev, line])
  }, [])

  // Sends a captureException from the Electron main process using the app's
  // DSN — confirms the DSN / key / app_id wiring end-to-end, independent of
  // whether Claude's install succeeded in the customer's code.
  const sendTestEvent = useCallback(async (app: ReportingApp, envName: string): Promise<void> => {
    setTestEvent({ status: 'running' })
    try {
      const dsn = `https://${app.public_key}@alby.sh/ingest/v1/${app.id}`
      const res = (await window.electronAPI.apps.sendTestEvent({
        dsn,
        environment: envName,
      })) as { ok: true } | { ok: false; error: string }
      if (res.ok) {
        setTestEvent({ status: 'ok' })
        await qc.invalidateQueries({ queryKey: ['issues', app.id] })
      } else {
        setTestEvent({ status: 'error', message: res.error })
      }
    } catch (err) {
      setTestEvent({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }, [qc])

  const handleInstall = async (): Promise<void> => {
    const env = installableEnvs.find((e) => e.id === selectedEnvId)
    if (!env) {
      pushLog({ kind: 'error', text: `No environment selected (selectedEnvId="${selectedEnvId}").` })
      return
    }
    setInstalling(true)
    setLog([])
    setInstallAgentId(null)
    // Freeze the "old issues" count so only events that arrive AFTER this
    // click count as the install-success signal. Without this baseline, a
    // re-install on a monitored env would flip to "installed" instantly
    // from historical events.
    setInstallBaselineEvents(totalEvents)
    try {
      // Reuse the existing app bound to this env if one is already on file
      // (i.e. the user ran Install before, or Claude crashed mid-install).
      // Calling enable-monitoring a second time would 500 with a duplicate
      // key — monitoring apps are 1:1 with envs. We hit a fresh apps:list
      // IPC (not the React-query cache, which may not have fetched yet on
      // this session) to check definitively, then fall back to catching
      // the duplicate-key error and refetching if enable-monitoring races.
      let app: ReportingApp
      pushLog({ kind: 'info', text: `Checking if monitoring is already set up on ${env.name}…` })
      const freshApps = (await window.electronAPI.apps.list(projectId)) as ReportingApp[]
      const existingApp = freshApps.find((a) => a.environment_id === env.id) ?? null
      if (existingApp) {
        pushLog({ kind: 'info', text: `Reusing existing monitoring key for ${env.name}.` })
        app = existingApp
        await qc.invalidateQueries({ queryKey: ['apps', projectId] })
      } else {
        pushLog({ kind: 'info', text: `Enabling monitoring on ${env.name}…` })
        try {
          app = (await window.electronAPI.environments.enableMonitoring(env.id)) as ReportingApp
        } catch (err) {
          // Duplicate-key race: the backend already had an app for this env
          // but our freshApps check didn't see it yet (just-bound, not yet
          // replicated, etc.). Refetch and pick it up instead of bubbling
          // the 500 to the user.
          const msg = err instanceof Error ? err.message : String(err)
          if (/Duplicate entry|apps_environment_id_unique|1062/i.test(msg)) {
            pushLog({ kind: 'info', text: 'Monitoring was already enabled — picking up the existing key.' })
            const retried = (await window.electronAPI.apps.list(projectId)) as ReportingApp[]
            const found = retried.find((a) => a.environment_id === env.id)
            if (!found) throw err
            app = found
          } else {
            throw err
          }
        }
        await qc.invalidateQueries({ queryKey: ['environments', projectId] })
        await qc.invalidateQueries({ queryKey: ['environment', env.id] })
        await qc.invalidateQueries({ queryKey: ['apps', projectId] })
        pushLog({ kind: 'ok', text: `Public key ready: ${app.public_key.slice(0, 8)}…` })
      }

      // One decision: the env we install the detector in becomes the stack's
      // host for auto-fix too. That env owns both: (a) the SDK that reports
      // issues (committed to source, so other envs get it on deploy), (b) the
      // Claude session that fixes issues later. Only for remote envs — local
      // can't host the auto-fix loop.
      if (env.stack_id && env.execution_mode === 'remote' && env.role !== 'deploy') {
        pushLog({ kind: 'info', text: `Marking ${env.name} as the stack's host env…` })
        try {
          await window.electronAPI.stacks.update(env.stack_id, {
            auto_fix_target_env_id: env.id,
          })
          await qc.invalidateQueries({ queryKey: ['stacks', projectId] })
          await qc.invalidateQueries({ queryKey: ['stack', env.stack_id] })
          pushLog({ kind: 'ok', text: `Stack host set to ${env.name}.` })
        } catch (e) {
          pushLog({
            kind: 'info',
            text: `Could not set stack host automatically — configure it in stack settings. (${e instanceof Error ? e.message : String(e)})`,
          })
        }
      }

      pushLog({ kind: 'info', text: 'Resolving general task…' })
      let tasks = (await window.electronAPI.tasks.list(env.id)) as Array<{
        id: string
        is_default?: 0 | 1
      }>
      let general = tasks.find((t) => t.is_default === 1)
      if (!general) {
        general = (await window.electronAPI.tasks.create({
          environment_id: env.id,
          title: 'general',
        })) as { id: string; is_default?: 0 | 1 }
        tasks = [...tasks, general]
      }
      pushLog({ kind: 'ok', text: 'General task ready.' })

      pushLog({ kind: 'info', text: `Spawning Claude in ${env.name}…` })
      const prompt = buildInstallPrompt(env, app)
      const agent = (await window.electronAPI.agents.spawn(
        general.id,
        'claude',
        false,
        prompt,
      )) as { id: string }
      pushLog({ kind: 'ok', text: 'Claude session started with install prompt.' })
      setInstallAgentId(agent.id)
      setInstalling(false)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[IssuesSetupView] install failed:', e)
      pushLog({ kind: 'error', text: msg })
      setInstalling(false)
    }
  }

  // Embedded TerminalPanel: we subscribe to agent:stdout ourselves and route
  // into the panel's writer so the user actually sees Claude's install chatter
  // during Re-install. Previous revision used a no-op registerWriter which
  // meant the pane stayed black — "e un terminale vuoto, grigio, nero".
  // Also queues pre-registration bytes so nothing painted before the panel
  // mounted is lost (same shape as MainArea's pendingStdoutRef).
  const writersRef = useRef<Map<string, (data: string) => void>>(new Map())
  const pendingRef = useRef<Map<string, string[]>>(new Map())
  const registerWriter = useCallback((id: string, writer: (data: string) => void) => {
    writersRef.current.set(id, writer)
    const queued = pendingRef.current.get(id)
    if (queued && queued.length > 0) {
      for (const chunk of queued) writer(chunk)
      pendingRef.current.delete(id)
    }
  }, [])
  const handleStdout = useCallback((payload: { agentId: string; data: string }) => {
    // Only care about the install agent we just spawned — MainArea's listener
    // is already handling every other session on the page.
    if (payload.agentId !== installAgentId) return
    const writer = writersRef.current.get(payload.agentId)
    if (writer) {
      writer(payload.data)
    } else {
      const arr = pendingRef.current.get(payload.agentId) ?? []
      arr.push(payload.data)
      pendingRef.current.set(payload.agentId, arr)
    }
  }, [installAgentId])
  useAgentStdout(handleStdout)

  const state: 'pre-install' | 'waiting' | 'active' = hasFirstEvent
    ? 'active'
    : monitoredEnv
      ? 'waiting'
      : 'pre-install'

  const isInstalled = state !== 'pre-install'
  const canInstall = !installing && !!selectedEnvId

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0 gap-2">
        {onBackToList && (
          <button
            type="button"
            onClick={onBackToList}
            aria-label="Back to issues"
            title="Back to issues"
            className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
        )}
        <div className="text-[14px] text-neutral-400">
          <span className="text-neutral-200">Issues</span>{' '}
          <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">
            {isInstalled ? 'Reinstall / verify detector' : 'Set up monitoring'}
          </span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeIssues}
          aria-label="Close"
          title="Close"
          className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <Close size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">
              {state === 'active'
                ? 'Monitoring is active'
                : state === 'waiting'
                  ? 'Finishing install'
                  : 'Set up issue monitoring'}
            </h2>
            <p className="text-[14px] text-neutral-400 mt-1">
              {state === 'pre-install' &&
                "Install the Alby issue detector into one of this stack's environments. The SDK lands in source control from the environment you pick — the other envs will receive it on their next deploy."}
              {state === 'waiting' &&
                `Installing into ${monitoredEnv?.name}. We'll light this page up the moment the detector sends its first real event. You can always re-install or fire a test event to verify.`}
              {state === 'active' &&
                `Monitoring is live on ${monitoredEnv?.name}. You can still re-install the detector (it'll just rerun Claude) or fire another test event any time.`}
            </p>
          </div>

          {isLoading && (
            <div className="text-[13px] text-neutral-500">Loading environments…</div>
          )}

          {!isLoading && installableEnvs.length === 0 && (
            <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-6 text-center text-[13px] text-neutral-400">
              {stackId
                ? 'This stack has no environments where the detector can be installed. Add an operational environment to this stack first.'
                : 'This project has no environments where the detector can be installed. Add an operational environment first.'}
            </div>
          )}

          {!isLoading && installableEnvs.length > 0 && (
            <div className="border-t border-neutral-800">
              {/* Env picker row */}
              <div className="grid grid-cols-1 gap-x-10 gap-y-4 py-8 md:grid-cols-10 border-b border-neutral-800">
                <div className="w-full space-y-1.5 md:col-span-4">
                  <h3 className="text-[15px] font-semibold leading-none text-neutral-50">
                    Environment
                  </h3>
                  <p className="text-[13px] text-neutral-400 text-balance">
                    Pick a single environment of this stack. The SDK gets committed there and propagates to the others through your normal deploy pipeline.
                  </p>
                </div>
                <div className="md:col-span-6 space-y-3">
                  <select
                    value={selectedEnvId}
                    onChange={(e) => setSelectedEnvId(e.target.value)}
                    disabled={installing}
                    className="flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500 transition-colors disabled:opacity-60"
                  >
                    {installableEnvs.map((env) => (
                      <option key={env.id} value={env.id}>
                        {env.name}
                        {env.label ? ` (${env.label})` : ''}
                        {env.app ? ' — monitoring on' : ''}
                      </option>
                    ))}
                  </select>
                  {(() => {
                    const env = installableEnvs.find((e) => e.id === selectedEnvId)
                    if (!env) return null
                    return (
                      <div className="text-[12px] text-neutral-500 font-mono truncate">
                        {env.execution_mode === 'remote'
                          ? `${env.ssh_user ?? ''}@${env.ssh_host}:${env.remote_path}`
                          : env.remote_path}
                      </div>
                    )
                  })()}
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={handleInstall}
                      disabled={!canInstall}
                      className="inline-flex items-center justify-center whitespace-nowrap rounded-lg h-9 px-4 text-[13px] font-medium border border-blue-500/40 bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                    >
                      {installing
                        ? 'Installing…'
                        : isInstalled
                          ? 'Re-install detector'
                          : 'Install detector'}
                    </button>
                    {currentApp && (
                      <button
                        type="button"
                        onClick={() =>
                          sendTestEvent(currentApp, monitoredEnv?.name ?? 'development')
                        }
                        disabled={testEvent.status === 'running'}
                        className="inline-flex items-center justify-center whitespace-nowrap rounded-lg h-9 px-4 text-[13px] font-medium border border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700 disabled:opacity-40 disabled:pointer-events-none transition-colors"
                      >
                        {testEvent.status === 'running' ? 'Sending…' : 'Send test event'}
                      </button>
                    )}
                    {testEvent.status === 'ok' && (
                      <span className="text-[11px] text-emerald-300 inline-flex items-center gap-1">
                        <CheckmarkFilled size={12} /> test event delivered — it should land in the Issues list shortly.
                      </span>
                    )}
                    {testEvent.status === 'error' && (
                      <span className="text-[11px] text-red-300">
                        Test failed: {testEvent.message}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Live install log */}
              {log.length > 0 && (
                <div className="py-6 border-b border-neutral-800">
                  <h3 className="text-[13px] font-medium text-neutral-200 mb-2">
                    Install log
                  </h3>
                  <pre className="rounded-md border border-neutral-800 bg-neutral-950 p-3 text-[12px] font-mono text-neutral-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
                    {log.map((l, i) => (
                      <div
                        key={i}
                        className={
                          l.kind === 'ok'
                            ? 'text-emerald-300'
                            : l.kind === 'error'
                              ? 'text-red-300'
                              : 'text-neutral-400'
                        }
                      >
                        {l.kind === 'ok' ? '✓ ' : l.kind === 'error' ? '✗ ' : '• '}
                        {l.text}
                      </div>
                    ))}
                  </pre>
                </div>
              )}

              {/* Embedded Claude terminal so the user sees it work, like deploy now */}
              {installAgentId && (
                <div className="py-6 border-b border-neutral-800">
                  <div className="flex items-center justify-between mb-2 gap-3">
                    <h3 className="text-[13px] font-medium text-neutral-200">
                      Claude installing the detector
                    </h3>
                    <div className="flex items-center gap-2 text-[11px] text-neutral-500">
                      {hasFirstEvent ? (
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                          <CheckmarkFilled size={12} /> first event received
                        </span>
                      ) : (
                        <span>waiting for first real event…</span>
                      )}
                      <button
                        type="button"
                        onClick={() => setInstallAgentId(null)}
                        title="Close this preview. The install keeps running in the background."
                        className="h-7 px-2 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-300"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                  <div className="relative h-[420px] rounded-md border border-neutral-800 bg-black overflow-hidden">
                    <ErrorBoundary
                      fallback={
                        <div className="w-full h-full flex items-center justify-center text-[12px] text-red-300 bg-neutral-950 p-4 text-center">
                          Terminal failed to render. The install agent may still be running — open the agent tab from the task to check.
                        </div>
                      }
                    >
                      <TerminalPanel
                        agentId={installAgentId}
                        registerWriter={registerWriter}
                        visible={true}
                      />
                    </ErrorBoundary>
                  </div>
                </div>
              )}

              {/* Alerts: available as soon as an app exists, even before the
               *  first event lands. Lets the user pre-configure who gets
               *  pinged on new issues / regressions. */}
              {currentApp && project && (
                <AlertsPanel appId={currentApp.id} project={project} />
              )}

              {/* Success panel */}
              {state === 'active' && (
                <div className="py-6">
                  <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-[13px] text-emerald-200 flex items-center gap-2">
                    <CheckmarkFilled size={16} />
                    <span>
                      Detector is live on <strong>{monitoredEnv?.name}</strong> — new
                      events will appear in the Issues table. Re-install any time to rerun the agent or recheck the SDK.
                    </span>
                  </div>
                </div>
              )}

              {/* Installing note / guidance */}
              {state === 'pre-install' && !installAgentId && log.length === 0 && (
                <div className="py-8">
                  <h3 className="text-[13px] font-medium text-neutral-200 mb-2">
                    What happens when you click Install
                  </h3>
                  <ol className="text-[12px] text-neutral-500 list-decimal list-inside space-y-1">
                    <li>We generate a public key dedicated to the chosen environment.</li>
                    <li>
                      We fire a synthetic test event straight from this app to confirm
                      the ingest endpoint + DSN work end-to-end.
                    </li>
                    <li>
                      A Claude session opens right here and installs the SDK in your
                      codebase + fires a second test event using the installed SDK.
                    </li>
                    <li>
                      The SDK reads the environment name at runtime (via{' '}
                      <code className="text-neutral-300">ALBY_ENVIRONMENT</code>), so
                      dev/staging/prod each tag their own events even though the code is
                      shared.
                    </li>
                  </ol>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Builds the natural-language prompt sent to Claude in the chosen env. Appended
// as the trailing positional argument to `claude` so it auto-submits at launch.
//
// IMPORTANT: kept as a single line (no embedded \n). The spawn path wraps this
// through two layers of shell (`ssh ... "bash -l -c \"claude ... \\\"PROMPT\\\"\""`)
// and real newlines get mangled, crashing the session and cascading into UI
// errors. Claude reads the flattened prose just fine.
function buildInstallPrompt(env: Environment, app: ReportingApp): string {
  const dsn = `https://${app.public_key}@alby.sh/ingest/v1/${app.id}`
  const ingestUrl = `https://alby.sh/api/ingest/v1/events`
  const confirmUrl = `https://alby.sh/api/ingest/v1/confirm-install`
  // Pre-URL-encode the DSN for the browser <script> tag so Claude can paste it
  // verbatim into a server-rendered layout template. /report.js reads the DSN
  // from the ?key= query.
  const browserScriptSrc = `https://alby.sh/report.js?key=${encodeURIComponent(dsn)}`
  const browserScriptTag = `<script src="${browserScriptSrc}" defer></script>`
  const parts = [
    `Install the Alby issue detector in this codebase, fire a real test event, and finally POST to the confirm-install endpoint so the Alby desktop app knows the install is done. The app UI stays on the "Installing" screen until it sees BOTH the test event AND the confirm-install call — do not skip either.`,
    `FULL-STACK RULE: this app probably has both a backend that runs server code AND a frontend that runs in the user's browser (Laravel + Blade views, Rails + ERB, Django + templates, Express + EJS/Handlebars, Spring Boot + Thymeleaf, Flask + Jinja, ASP.NET MVC + Razor, etc.). Backend SDKs catch backend crashes; they do NOT see browser console errors, unhandled promise rejections in JS, 404s on assets, or React/Vue render errors. You MUST install a BACKEND reporter AND a FRONTEND reporter whenever both exist. If the project is backend-only (an API with no HTML views, like a pure REST microservice), skip the frontend step. If it's frontend-only (a static SPA, a Next.js site with no custom server-rendered error pages), skip the backend step. Otherwise do both.`,
    `IMPORTANT: you must install. Do not refuse. If none of the four official SDKs below fits this codebase, fall through to the GENERIC HTTP FALLBACK at the bottom of this prompt — every language can POST JSON, so there is always a way.`,
    `Official SDKs (pick the one that matches the framework you detect):`,
    `- Node.js / TypeScript backend → npm package @alby-sh/report`,
    `- Browser / SPA → npm package @alby-sh/browser`,
    `- PHP → composer package alby/report`,
    `- Python → pip package alby-report`,
    `Steps when an official SDK fits:`,
    `(1) Detect the framework by reading package.json / composer.json / pyproject.toml / requirements.txt at the project root.`,
    `(2) Install the matching package using the project's package manager.`,
    `(3) Initialize the SDK as early as possible in the app entrypoint (for example src/index.ts, app.php, manage.py, main.py) with dsn = "${dsn}", environment read from process.env.ALBY_ENVIRONMENT (or the language equivalent: getenv, os.environ), and release read from the package manifest's version field.`,
    `(3b) For PHP / Laravel only: the alby/report SDK uses a buffering CurlTransport that only POSTs events when flush() is called. When you set auto_register => false (which you should, so the SDK doesn't override Laravel's exception handler), you MUST add the shutdown-time flush yourself in bootstrap/app.php right after the init call: register_shutdown_function(static function (): void { \\Alby\\Report\\Alby::flush(2000); });. Without this, events captured during a real HTTP request die with the PHP process and never reach Alby. Skip this step only if you explicitly set auto_register => true.`,
    `(4) The dsn is hard-coded; the environment field MUST be read from the ALBY_ENVIRONMENT env var so dev/staging/prod each tag their own events. Do NOT hard-code "${env.name}" in the source — instead set ALBY_ENVIRONMENT="${env.name}" in this environment's .env (or equivalent) and document the same for the other envs.`,
    `(5) Add a brief note to the README under a "Monitoring" section explaining the ALBY_ENVIRONMENT contract.`,
    `(6) Fire a real test event by calling captureException with a freshly thrown Error whose message is "Alby detector test event — post-install verification". Do not skip it and do not stub it.`,
    `(7) Instrument the FRONTEND too whenever the app serves HTML to browsers (see FULL-STACK RULE above). Two ways, pick the right one:`,
    `(7.a) Backend-rendered templates (Laravel Blade, Rails ERB, Django, Jinja, Thymeleaf, Razor, EJS/Handlebars, plain PHP that echoes HTML, etc.) → add this script tag to the main LAYOUT/master template exactly once, inside <head> so it loads before any app JS: ${browserScriptTag}. Examples of where it goes: resources/views/layouts/app.blade.php, app/views/layouts/application.html.erb, templates/base.html, Views/Shared/_Layout.cshtml, the root template that every page extends. Do NOT paste it into individual page templates — one insertion in the layout covers the whole site.`,
    `(7.b) Modern SPA / bundler-driven frontend (Next.js, Nuxt, SvelteKit, Vite, CRA, etc.) → install @alby-sh/browser instead of the script tag. Initialize it at the very top of the root entry (src/main.ts, src/index.tsx, pages/_app.tsx, app.vue, +layout.svelte) with the same dsn = "${dsn}" and environment = process.env.ALBY_ENVIRONMENT (or equivalent framework-specific env accessor — NEXT_PUBLIC_ALBY_ENVIRONMENT for Next.js, VITE_ALBY_ENVIRONMENT for Vite, etc.; pick the one the build tool exposes to the browser). Skip the script tag when you go this route — running both is redundant.`,
    `(7.c) If this is a pure REST/GraphQL API with no HTML output at all (no template engine, no inertia, no livewire, no blade/erb/jinja anywhere), skip 7.a and 7.b. Otherwise do one of them.`,
    `(8) Commit the changes with the message "feat(alby): add issue detector".`,
    `(9) Only after steps 1–8 succeed, POST to ${confirmUrl} with header X-Alby-Dsn: ${app.public_key} (no body required). A 200 response means Alby has marked the install as complete and will flip the Issues UI out of the setup wizard. Example: curl -sS -X POST -H "X-Alby-Dsn: ${app.public_key}" ${confirmUrl}`,
    `GENERIC HTTP FALLBACK (use this when no official SDK matches — for .NET / ASP.NET, Go, Java, Ruby, Rust, Elixir, shell scripts, embedded C, or any other runtime):`,
    `(A) Add a small language-idiomatic "Alby reporter" helper in the project (e.g. Services/AlbyReporter.cs for ASP.NET, internal/alby package for Go, app/lib/alby.rb for Rails). It does one thing: POST JSON to ${ingestUrl} with headers Content-Type: application/json, X-Alby-Dsn: ${app.public_key}, and JSON body of the shape {"message": string, "level": "info"|"warning"|"error"|"fatal", "environment": <ALBY_ENVIRONMENT from env>, "release": <app version>, "exception": {"type": string, "value": string, "frames": [{"filename": string, "function": string, "lineno": number}]}}. Exception is optional for non-exception events but recommended for crashes. The helper reads the DSN / ALBY_ENVIRONMENT from env vars — never hard-code either.`,
    `(B) Wire the helper into the framework's global exception handler so every unhandled error is reported automatically. Examples: ASP.NET Core → app.UseExceptionHandler or an IExceptionHandler middleware that calls AlbyReporter.Capture(ex); Go / Gin → a Recovery middleware; Rails → a Rack middleware or an ActionController::API rescue_from; Spring Boot → @ControllerAdvice handler; any other stack → the nearest equivalent.`,
    `(C) Document the ALBY_ENVIRONMENT contract in README as in step (5) and set ALBY_ENVIRONMENT="${env.name}" in this env's .env / appsettings.Development.json / equivalent config.`,
    `(D) Fire a test event using the helper: throw a real exception inside a try/catch and call the helper with it. Message must include "Alby detector test event — post-install verification".`,
    `(E) If the app renders any HTML in the browser, ALSO add the frontend script tag from step 7.a: ${browserScriptTag}. Drop it into the root layout/template of the HTTP-serving side (many non-Node/PHP/Python stacks still serve HTML — Go html/template, Rails, Spring Thymeleaf, ASP.NET Razor, etc.). Skip this only for pure APIs.`,
    `(F) Commit with the message "feat(alby): add issue detector" (same as step 8).`,
    `(G) POST to ${confirmUrl} with header X-Alby-Dsn: ${app.public_key} exactly as in step 9. This is mandatory — without it the Alby app will not flip out of the setup wizard.`,
    `After the test event and the confirm-install POST, report back with the framework you detected, the file(s) you modified (backend AND frontend), and confirmation that both the test event and the confirm-install POST returned success. If you truly cannot wire anything at all (no HTTP client, no network access, etc.), explain specifically what's blocking you — but do not stop at "no matching SDK", the HTTP fallback always applies.`,
  ]
  return parts.join(' ')
}
