import { useMemo, useState } from 'react'
import { ChevronLeft, Close, TrashCan } from '@carbon/icons-react'
import { useAppStore } from '../../stores/app-store'
import { useIssue, useIssueEvents, useUpdateIssue, useDeleteIssue, useApps } from '../../hooks/useIssues'
import { useEnvironments } from '../../hooks/useProjects'
import { useStacks } from '../../hooks/useStacks'
import type { Issue, IssueEvent, IssueStatus } from '../../../shared/types'

export function IssueDetailView({ issueId }: { issueId: string }) {
  const closeDetail = useAppStore((s) => s.closeIssueDetail)
  const storeProjectId = useAppStore((s) => s.issuesProjectId)
  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const openEditEnvironment = useAppStore((s) => s.openEditEnvironment)
  const { data, isLoading } = useIssue(issueId)
  const { data: eventsPage } = useIssueEvents(issueId, 1)
  // Derive projectId from the issue's app first. The store's `issuesProjectId`
  // is nulled out whenever the user navigates from the sidebar, so relying on
  // it alone left the button permanently disabled the moment anyone clicked
  // anything while reading an issue. The backend now echoes project_id on
  // the app payload for exactly this reason.
  const projectId = data?.app.project_id ?? storeProjectId
  const { data: environments } = useEnvironments(projectId)
  const { data: stacks } = useStacks(projectId)
  const { data: apps = [] } = useApps(projectId)
  const updateIssue = useUpdateIssue()
  const deleteIssue = useDeleteIssue()
  const [tab, setTab] = useState<'overview' | 'events' | 'context' | 'breadcrumbs'>('overview')
  const [fixError, setFixError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Resolve the stack + target env for this issue. Prefers the env the user
  // installed the detector in (i.e. the app's env), because that's where the
  // code lives and where the fix will be made. Walks to stack.auto_fix_target_env_id
  // only as an explicit override — otherwise any operational env of the stack
  // (remote OR local) is fine: the agent runs wherever the user works.
  //
  // Must be called unconditionally — keep it above any early return so React
  // sees the same hook count on the loading and loaded renders (#310).
  const fixTarget = useMemo(() => {
    // Only hard-require environments — without at least one env we can't
    // possibly spawn an agent. `data` / `stacks` / `apps` are soft: we degrade
    // gracefully when any of them hasn't loaded (or is empty). Previously
    // requiring all three meant any one of them missing/empty left the button
    // disabled forever.
    if (!environments || environments.length === 0) return null
    const appId = data?.issue.app_id
    const app = appId ? apps.find((a) => a.id === appId) ?? null : null
    const sourceEnv =
      (app?.environment_id
        ? environments.find((e) => e.id === app.environment_id) ?? null
        : null) ??
      (appId ? environments.find((e) => e.app?.id === appId) ?? null : null)
    const stack = sourceEnv && stacks
      ? stacks.find((s) => s.id === sourceEnv.stack_id) ?? null
      : null
    const explicit = stack?.auto_fix_target_env_id
      ? environments.find((e) => e.id === stack.auto_fix_target_env_id) ?? null
      : null
    const sourceEnvUsable = sourceEnv && sourceEnv.role !== 'deploy' ? sourceEnv : null
    const anyOperationalInStack =
      stack
        ? environments.find((e) => e.stack_id === stack.id && e.role !== 'deploy') ?? null
        : null
    // Last resort — any operational env in the project. Guarantees the button
    // is clickable as long as the project has at least one non-deploy env.
    const anyOperationalInProject =
      environments.find((e) => e.role !== 'deploy') ?? null
    const targetEnv =
      explicit ?? sourceEnvUsable ?? anyOperationalInStack ?? anyOperationalInProject ?? null
    return {
      sourceEnv,
      stack,
      targetEnv,
      usedFallback: !explicit && !!targetEnv,
    }
  }, [data, environments, stacks, apps])

  if (isLoading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center bg-neutral-950 text-neutral-500 text-sm">
        Loading issue…
      </div>
    )
  }

  const { issue, latest_event } = data
  const event = latest_event
  const frames = event?.exception?.frames ?? []

  const setStatus = (status: IssueStatus) => {
    updateIssue.mutate({ id: issue.id, data: { status } })
  }

  const spawnFixAgent = async (): Promise<void> => {
    if (!fixTarget) {
      setFixError('Project data not loaded yet — try again in a moment.')
      return
    }
    const { targetEnv, stack } = fixTarget
    if (!targetEnv) {
      setFixError(
        'No operational environment available. Add an env to this stack (or project) first.'
      )
      return
    }
    setFixing(true)
    setFixError(null)
    try {
      // Resolve or create the env's protected "general" task, then spawn the
      // configured agent there with a prompt built from the issue details.
      const taskList = (await window.electronAPI.tasks.list(targetEnv.id)) as Array<{
        id: string
        is_default?: 0 | 1
      }>
      let general = taskList.find((t) => t.is_default === 1)
      if (!general) {
        general = (await window.electronAPI.tasks.create({
          environment_id: targetEnv.id,
          title: 'general',
        })) as { id: string; is_default?: 0 | 1 }
      }
      // Mint a signed resolve URL the agent can curl when it pushes the fix
      // — no Sanctum token leaks through. Best-effort: if the server is
      // offline we still spawn the agent but without the auto-resolve step.
      let resolveUrl: string | null = null
      try {
        const resp = await window.electronAPI.issues.mintResolveUrl(issue.id) as { url: string }
        resolveUrl = resp?.url ?? null
      } catch (err) {
        console.warn('[fix-agent] could not mint resolve URL:', err)
      }
      const prompt = buildFixPrompt(
        issue,
        event,
        fixTarget.sourceEnv?.name ?? '?',
        stack?.name ?? 'this project',
        resolveUrl,
      )
      const agent = (await window.electronAPI.agents.spawn(
        general!.id,
        stack?.auto_fix_agent_type ?? 'claude',
        false,
        prompt
      )) as { id: string }
      selectTask(general!.id, targetEnv.id)
      setActiveAgent(agent.id)
      closeDetail()
    } catch (e) {
      setFixError(e instanceof Error ? e.message : String(e))
    } finally {
      setFixing(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-neutral-950 min-w-0">
      <div className="flex items-center gap-3 px-6 h-12 border-b border-neutral-900">
        <button onClick={closeDetail} className="text-neutral-400 hover:text-neutral-200">
          <ChevronLeft size={18} />
        </button>
        <h1 className="text-sm font-semibold text-neutral-200 truncate">{issue.title}</h1>
        <div className="ml-auto flex items-center gap-2">
          <span
            className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${
              issue.status === 'open'
                ? 'bg-red-900/50 text-red-300'
                : 'bg-emerald-900/50 text-emerald-300'
            }`}
          >
            {issue.status.replace(/_/g, ' ')}
          </span>
          {issue.status === 'open' ? (
            <>
              <button
                onClick={() => setStatus('resolved')}
                className="text-xs px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white"
              >
                Resolve
              </button>
              <button
                onClick={() => setStatus('ignored')}
                className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
              >
                Ignore
              </button>
              <button
                onClick={() => {
                  const ok = window.confirm(
                    'Discard this error?\n\nThe issue is hidden and every FUTURE event with the same fingerprint is dropped silently on the ingest server — no re-open on regression, no emails, no Slack. Click Reopen to undo.',
                  )
                  if (ok) setStatus('excluded')
                }}
                title="Permanently mute this fingerprint — future matching events are dropped by the ingest server"
                className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-red-900/50 text-neutral-400 hover:text-red-300"
              >
                Discard
              </button>
              <button
                onClick={spawnFixAgent}
                disabled={fixing || !fixTarget?.targetEnv}
                title={
                  fixTarget?.targetEnv
                    ? `Spawns ${fixTarget.stack?.auto_fix_agent_type ?? 'claude'} in ${fixTarget.targetEnv.name}`
                    : undefined
                }
                className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:pointer-events-none text-white"
              >
                {fixing ? 'Spawning…' : 'Fix with agent'}
              </button>
            </>
          ) : (
            <button
              onClick={() => setStatus('open')}
              className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300"
            >
              Reopen
            </button>
          )}
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-4 gap-px bg-neutral-900 border-b border-neutral-900">
        <Metric label="Level" value={issue.level.toUpperCase()} />
        <Metric label="Occurrences" value={String(issue.occurrences_count)} />
        <Metric label="First seen" value={issue.first_seen_at ?? '—'} mono />
        <Metric label="Last seen" value={issue.last_seen_at ?? '—'} mono />
      </div>

      {fixError && (
        <div className="px-6 py-2 border-b border-red-500/30 bg-red-500/5 text-[12px] text-red-200 flex items-center gap-2">
          <span className="flex-1">{fixError}</span>
          {fixTarget?.stack && !fixTarget.targetEnv && (
            <button
              type="button"
              onClick={() => {
                const firstEnv = environments?.find(
                  (e) => e.stack_id === fixTarget.stack?.id && e.role !== 'deploy' && e.execution_mode === 'remote'
                )
                if (firstEnv) openEditEnvironment(firstEnv.id)
              }}
              className="h-7 px-2 rounded text-[11px] text-red-200 border border-red-500/40 hover:bg-red-500/10"
            >
              Open env settings
            </button>
          )}
          <button
            type="button"
            onClick={() => setFixError(null)}
            className="size-6 flex items-center justify-center rounded hover:bg-red-500/10"
          >
            <Close size={12} />
          </button>
        </div>
      )}

      {/* Tab row */}
      <div className="flex items-center gap-0 px-6 h-10 border-b border-neutral-900">
        {(['overview', 'events', 'context', 'breadcrumbs'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-xs px-3 h-full border-b-2 ${
              tab === t
                ? 'border-blue-500 text-neutral-200'
                : 'border-transparent text-neutral-500 hover:text-neutral-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm text-neutral-200">
        {tab === 'overview' && (
          <>
            <Section title="Culprit">
              <div className="text-neutral-400 font-mono text-xs">
                {issue.culprit ?? 'unknown'}
              </div>
            </Section>
            <Section title="Exception">
              {event?.exception ? (
                <div className="space-y-2">
                  <div>
                    <span className="text-red-400 font-semibold">{event.exception.type}</span>
                    {event.exception.value && <span className="text-neutral-400">: {event.exception.value}</span>}
                  </div>
                  {frames.length > 0 && (
                    <pre className="bg-neutral-900 border border-neutral-800 rounded p-3 text-xs font-mono overflow-x-auto whitespace-pre">
{frames.slice(0, 12).map((f, idx) =>
  `${(f.filename ?? '?')}:${f.lineno ?? '?'}${f.colno ? ':' + f.colno : ''}  —  ${f.function ?? ''}`
).join('\n')}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="text-neutral-500 text-xs">No exception — this issue was captured as a message.</div>
              )}
            </Section>
            {event?.message && (
              <Section title="Message">
                <div className="text-neutral-400 text-xs font-mono">{event.message}</div>
              </Section>
            )}
          </>
        )}

        {tab === 'events' && (
          <div className="space-y-2">
            <div className="text-xs text-neutral-500 mb-2">
              {eventsPage?.total ?? 0} event(s) for this issue
            </div>
            <ul className="divide-y divide-neutral-900 border border-neutral-900 rounded">
              {(eventsPage?.data ?? []).map((e) => (
                <li key={e.id} className="px-3 py-2 flex items-center gap-3 text-xs">
                  <span className="text-neutral-500 font-mono">{e.received_at}</span>
                  <span className="text-neutral-400">{e.platform ?? ''}</span>
                  <span className="text-neutral-200 truncate flex-1">{e.message ?? e.exception?.value ?? ''}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === 'context' && (
          <Section title="Context">
            <pre className="bg-neutral-900 border border-neutral-800 rounded p-3 text-xs font-mono overflow-x-auto">
              {JSON.stringify(event?.contexts ?? {}, null, 2)}
            </pre>
          </Section>
        )}

        {tab === 'breadcrumbs' && (
          <Section title="Breadcrumbs">
            {event?.breadcrumbs && event.breadcrumbs.length > 0 ? (
              <ul className="divide-y divide-neutral-900 border border-neutral-900 rounded">
                {event.breadcrumbs.map((b, idx) => (
                  <li key={idx} className="px-3 py-2 text-xs flex items-center gap-3">
                    <span className="text-neutral-500 font-mono">{b.timestamp ?? ''}</span>
                    <span className="text-blue-300 uppercase tracking-wider">{b.type ?? ''}</span>
                    <span className="text-neutral-300 truncate flex-1">{b.message ?? ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-neutral-500 text-xs">No breadcrumbs captured.</div>
            )}
          </Section>
        )}

        {issue.status === 'resolved' && (
          <div className="mt-10 border-t border-neutral-900 pt-8">
            <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-4">
              <h3 className="text-[14px] font-semibold text-red-300 mb-1">Delete issue</h3>
              <p className="text-[13px] text-red-400/80 mb-4">
                Permanently removes the issue record, its events, and breadcrumbs.
                If the same fingerprint fires again in the future it will come
                back as a brand-new issue (no regression history). Only available
                while the issue is resolved — reopen it first if you're not
                sure.
              </p>
              <button
                type="button"
                onClick={() => { setDeleteError(null); setShowDeleteConfirm(true) }}
                disabled={deleteIssue.isPending}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-red-600/90 hover:bg-red-600 disabled:opacity-60 text-white transition-colors"
              >
                <TrashCan size={14} />
                Delete issue
              </button>
              {deleteError && (
                <p className="mt-2 text-[12px] text-red-300">{deleteError}</p>
              )}
            </div>
          </div>
        )}
      </div>

      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setShowDeleteConfirm(false)}
        >
          <div
            className="w-[460px] bg-neutral-950 border border-neutral-800 rounded-xl p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center mb-3">
              <TrashCan size={18} className="text-red-400" />
              <h3 className="ml-2 text-[14px] font-medium text-neutral-100">Delete this issue?</h3>
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                aria-label="Close"
                className="ml-auto size-7 flex items-center justify-center rounded-md hover:bg-neutral-800 text-neutral-400"
              >
                <Close size={14} />
              </button>
            </div>
            <p className="text-[13px] text-neutral-400 mb-5">
              Hard-deletes <span className="text-neutral-200">{issue.title}</span>
              {' '}and all its events. Cannot be undone. If the error fires again
              it'll appear as a fresh issue.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(false)}
                className="h-9 px-4 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[13px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  deleteIssue.mutate(issue.id, {
                    onSuccess: () => {
                      setShowDeleteConfirm(false)
                      closeDetail()
                    },
                    onError: (err) => {
                      setDeleteError(err instanceof Error ? err.message : String(err))
                      setShowDeleteConfirm(false)
                    },
                  })
                }}
                disabled={deleteIssue.isPending}
                className="inline-flex items-center gap-1.5 h-9 px-4 rounded-md bg-red-600/90 hover:bg-red-600 disabled:opacity-60 text-white text-[13px] font-medium"
              >
                <TrashCan size={14} />
                {deleteIssue.isPending ? 'Deleting…' : 'Delete issue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-neutral-950 px-4 py-2">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={`text-xs text-neutral-200 mt-0.5 truncate ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500 mb-2">{title}</div>
      {children}
    </div>
  )
}

// Builds the single-line prompt passed to the auto-fix agent on spawn. Kept
// on one line to avoid shell-escape mangling through the ssh → bash → claude
// wrapping layers (same rationale as the install prompt).
function buildFixPrompt(
  issue: Issue,
  event: IssueEvent | null,
  sourceEnvName: string,
  stackName: string,
  resolveUrl: string | null,
): string {
  const frames = event?.exception?.frames ?? []
  // Keep more frames (up to 15) and one-per-line so the agent can grep them
  // without shell-escape weirdness. Minified filenames / offsets are enough
  // to locate the module in the bundle.
  const fullStack = frames
    .slice(0, 15)
    .map((f) => {
      const loc = `${f.filename ?? '?'}:${f.lineno ?? '?'}${f.colno ? ':' + f.colno : ''}`
      return `  - ${loc} in ${f.function ?? '?'}`
    })
    .join('\n')

  // Pull whatever the Sentry-style envelope put under `contexts.request`
  // and `contexts.browser` without assuming a strict shape.
  const ctx = (event?.contexts ?? {}) as Record<string, unknown>
  const request = (ctx.request as Record<string, unknown> | undefined) ?? {}
  const browser = (ctx.browser as Record<string, unknown> | undefined) ?? {}
  const pageUrl =
    (typeof request.url === 'string' && request.url) ||
    (typeof event?.tags?.url === 'string' ? event.tags.url : '') ||
    ''
  const userAgent =
    (typeof request.headers === 'object' && request.headers &&
      typeof (request.headers as Record<string, unknown>)['User-Agent'] === 'string'
      ? (request.headers as Record<string, string>)['User-Agent']
      : '') ||
    (typeof event?.tags?.['user_agent'] === 'string' ? event.tags['user_agent'] : '') ||
    ''
  const browserName = typeof browser.name === 'string' ? browser.name : ''
  const browserVersion = typeof browser.version === 'string' ? browser.version : ''
  const browserLine = browserName
    ? `${browserName}${browserVersion ? ' ' + browserVersion : ''}`
    : (userAgent || '')

  // Last N user actions before the crash. Keep them concise but include the
  // category + message + data so "clicked what, opened which modal" shows.
  const crumbs = (event?.breadcrumbs ?? []).slice(-8).map((b) => {
    const dataStr = b.data ? ` ${JSON.stringify(b.data).slice(0, 200)}` : ''
    const label = [b.category ?? b.type ?? 'event', b.message ?? ''].filter(Boolean).join(' · ')
    return `  - ${b.timestamp ?? ''} ${label}${dataStr}`
  }).join('\n')

  // Build a shell-friendly multi-line string. The agent's shell quoting
  // layer handles newlines via the ALBY_INITIAL_PROMPT env var path.
  const resolveBlock = resolveUrl
    ? [
        '',
        'When you have pushed a fix that you are confident resolves the issue, mark it resolved by running:',
        '',
        '```bash',
        `curl -fsS -X POST '${resolveUrl}' && echo '[alby] issue ${issue.id} marked resolved'`,
        '```',
        '',
        'The URL is signed and expires in 7 days. If the curl fails, the user can still mark it resolved manually from Alby — don\'t block your commit on it.',
      ].join('\n')
    : ''

  const lines = [
    `A new error was reported from the "${stackName}" stack (source env: ${sourceEnvName}).`,
    '',
    `Issue id: ${issue.id}`,
    `Title: ${issue.title}`,
    issue.culprit ? `Culprit: ${issue.culprit}` : '',
    event?.exception
      ? `Exception: ${event.exception.type}${event.exception.value ? ' — ' + event.exception.value : ''}`
      : '',
    event?.message ? `Message: ${event.message}` : '',
    pageUrl ? `Page URL: ${pageUrl}` : '',
    browserLine ? `Browser / UA: ${browserLine}` : '',
    fullStack ? `\nStack trace (top ${Math.min(frames.length, 15)} frames):\n${fullStack}` : '',
    crumbs ? `\nLast user actions before the crash:\n${crumbs}` : '',
    '',
    `Your job: investigate the root cause, apply a minimal correct fix, and commit with a clear message (include "alby-issue ${issue.id}" in the body for traceability), then push to origin. Do NOT commit placeholder or debug-only changes. If you cannot safely determine a fix without more info, explain exactly what you'd need and stop without committing.`,
    resolveBlock,
  ]
  return lines.filter((l) => l !== '').join('\n')
}
