import { useMemo, useState } from 'react'
import { ChevronLeft, Close, Notification, Settings } from '@carbon/icons-react'
import { useAppStore } from '../../stores/app-store'
import { useApps, useIssues } from '../../hooks/useIssues'
import { useEnvironments, useAllProjects } from '../../hooks/useProjects'
import { useStack } from '../../hooks/useStacks'
import type { IssueLevel, IssueStatus, Project } from '../../../shared/types'
import { IssuesSetupView } from './IssuesSetupView'
import { AlertsPanel } from './AlertsPanel'

const STATUS_OPTIONS: { value: IssueStatus | 'all'; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'all', label: 'All' },
]

const LEVEL_COLOR: Record<IssueLevel, string> = {
  debug: 'text-neutral-500',
  info: 'text-blue-300',
  warning: 'text-amber-300',
  error: 'text-red-300',
  fatal: 'text-red-500 font-semibold',
}

function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}

export function IssuesListView({
  projectId,
  stackId,
}: {
  projectId: string
  stackId?: string | null
}) {
  const closeIssues = useAppStore((s) => s.closeIssues)
  const openIssueDetail = useAppStore((s) => s.openIssueDetail)
  const openEditEnvironment = useAppStore((s) => s.openEditEnvironment)

  const { data: environments = [], isLoading: envLoading } = useEnvironments(projectId)
  const { data: scopedStack } = useStack(stackId ?? null)
  const { data: allApps = [] } = useApps(projectId)
  // Filter by stack: an app belongs to a stack via its env's stack_id. When a
  // stack is selected (sidebar entry inside a StackGroup) we only show the
  // issues from apps whose hosting env lives in that stack.
  const apps = useMemo(() => {
    if (!stackId) return allApps
    const envIdsInStack = new Set(
      environments.filter((e) => e.stack_id === stackId).map((e) => e.id)
    )
    return allApps.filter((a) => a.environment_id && envIdsInStack.has(a.environment_id))
  }, [allApps, environments, stackId])
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null)
  const currentAppId = selectedAppId ?? apps[0]?.id ?? null

  const [status, setStatus] = useState<IssueStatus | 'all'>('open')
  const [query, setQuery] = useState('')

  const { data: page, isLoading } = useIssues(currentAppId, {
    status,
    q: query || undefined,
    sort: 'last_seen_at',
    dir: 'desc',
  })
  const issues = page?.data ?? []

  const filteredByAppName = useMemo(() => {
    const app = apps.find((a) => a.id === currentAppId)
    return app?.name ?? '—'
  }, [apps, currentAppId])

  const monitoredEnvs = useMemo(
    () =>
      environments.filter(
        (e) => e.app != null && (!stackId || e.stack_id === stackId)
      ),
    [environments, stackId]
  )

  // Total events ever received on this project's primary app — drives the
  // "setup wizard vs real table" decision. Until the first test event lands,
  // we keep the user in the wizard (which polls for it) rather than show an
  // empty table that lies about monitoring being active.
  const { data: totalPage } = useIssues(currentAppId, { status: 'all' })
  const hasFirstEvent = (totalPage?.total ?? 0) > 0

  // The user can force the setup wizard open from the table (e.g. to
  // re-run the install agent against a different env). Local state so the
  // flag disappears when the user navigates away.
  const [manageInstallOpen, setManageInstallOpen] = useState(false)
  const [manageAlertsOpen, setManageAlertsOpen] = useState(false)
  const { data: allProjects = [] } = useAllProjects()
  const project = useMemo<Project | null>(
    () => allProjects.find((p) => p.id === projectId) ?? null,
    [allProjects, projectId],
  )

  // Setup wizard shows WHEN:
  //   - Monitoring isn't enabled yet (no env has a bound app), OR
  //   - No real event has been received yet (first-event is the authoritative
  //     signal that the whole loop works — DSN + SDK + transport + ingest), OR
  //   - The user explicitly clicked "Manage install" on the table.
  // Once first-event lands we flip to the table by default so the user sees
  // live issues immediately; the table's header still links back here via the
  // "Manage install" button.
  if (!envLoading && (monitoredEnvs.length === 0 || !hasFirstEvent || manageInstallOpen)) {
    return (
      <IssuesSetupView
        projectId={projectId}
        stackId={stackId ?? null}
        onBackToList={manageInstallOpen ? () => setManageInstallOpen(false) : undefined}
      />
    )
  }

  // (unused fallback kept for edge cases: monitoring on + events reported
  // earlier but /api/apps hasn't synced yet)
  if (!apps.length) {
    const envNames = monitoredEnvs.map((e) => e.name).join(', ')
    return (
      <div className="flex-1 flex flex-col bg-neutral-950">
        <div className="flex items-center gap-3 px-6 h-12 border-b border-neutral-900">
          <button onClick={closeIssues} className="text-neutral-400 hover:text-neutral-200">
            <ChevronLeft size={18} />
          </button>
          <h1 className="text-sm font-semibold text-neutral-200">Issues</h1>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-neutral-500 px-8 text-center">
          <div className="size-2 rounded-full bg-emerald-400 mb-3" />
          <p className="text-sm text-neutral-300 mb-2">No issues yet.</p>
          <p className="text-xs max-w-md">
            Monitoring is active on <span className="text-neutral-300">{envNames}</span>.
            We'll show errors here as soon as they're reported.
          </p>
          {monitoredEnvs[0] && (
            <button
              onClick={() => openEditEnvironment(monitoredEnvs[0].id)}
              className="mt-4 text-xs text-neutral-400 hover:text-neutral-200 underline"
            >
              View monitoring settings
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-neutral-950 min-w-0">
      <div className="flex items-center gap-3 px-6 h-12 border-b border-neutral-900">
        <button onClick={closeIssues} className="text-neutral-400 hover:text-neutral-200">
          <ChevronLeft size={18} />
        </button>
        <h1 className="text-sm font-semibold text-neutral-200">Issues</h1>
        {scopedStack && (
          <span className="text-xs text-neutral-400">
            · <span className="text-neutral-200">{scopedStack.name}</span>{' '}
            <span className="text-neutral-600 uppercase tracking-wider text-[10px]">
              {scopedStack.kind.replace(/_/g, ' ')}
            </span>
          </span>
        )}
        <span className="text-xs text-neutral-500">· {filteredByAppName}</span>
        <div className="ml-auto flex items-center gap-2">
          {project && currentAppId && (
            <button
              onClick={() => setManageAlertsOpen(true)}
              title="Pick who gets pinged (email, Slack, Alby push) when this app fires a new issue or a regression."
              className="inline-flex items-center gap-1 text-xs px-3 py-1 rounded border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200"
            >
              <Notification size={12} />
              Manage alerts
            </button>
          )}
          <button
            onClick={() => setManageInstallOpen(true)}
            title="Reopen the detector install wizard — re-run Claude, verify the SDK, or fire a test event."
            className="inline-flex items-center gap-1 text-xs px-3 py-1 rounded border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200"
          >
            <Settings size={12} />
            Manage install
          </button>
        </div>
      </div>

      {manageAlertsOpen && project && currentAppId && (
        <ManageAlertsDialog
          appId={currentAppId}
          project={project}
          onClose={() => setManageAlertsOpen(false)}
        />
      )}

      {/* Filters row */}
      <div className="flex items-center gap-3 px-6 h-12 border-b border-neutral-900">
        {apps.length > 1 && (
          <select
            value={currentAppId ?? ''}
            onChange={(e) => setSelectedAppId(e.target.value)}
            className="text-xs bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-neutral-200"
          >
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
        <div className="flex items-center gap-1 rounded-md bg-neutral-900 p-0.5">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setStatus(opt.value)}
              className={`text-xs px-2 py-1 rounded ${
                status === opt.value
                  ? 'bg-neutral-700 text-white'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title / culprit…"
          className="text-xs bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-neutral-200 flex-1 max-w-md"
        />
        <div className="ml-auto text-xs text-neutral-500">
          {page ? `${page.total} total` : ''}
        </div>
      </div>

      {/* Issue list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && <div className="p-6 text-xs text-neutral-500">Loading…</div>}
        {!isLoading && issues.length === 0 && (
          <div className="p-8 text-center text-sm text-neutral-500">No issues.</div>
        )}
        <ul className="divide-y divide-neutral-900">
          {issues.map((i) => (
            <li
              key={i.id}
              onClick={() => openIssueDetail(i.id)}
              title={i.title}
              className="px-6 py-3 hover:bg-neutral-900 cursor-pointer overflow-hidden"
            >
              <div className="flex items-start gap-3 min-w-0">
                <span className={`text-[10px] font-semibold uppercase tracking-wider ${LEVEL_COLOR[i.level]} mt-0.5 w-14 shrink-0`}>
                  {i.level}
                </span>
                {/* min-w-0 on the flex parent + inner container lets children
                 *  actually shrink below their intrinsic width. break-all is
                 *  the last line of defense against single unbroken tokens
                 *  (long paths, stack frames) that truncate alone can't
                 *  constrain — it forces wrapping mid-char, then line-clamp
                 *  caps to one visible line. */}
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className="text-sm text-neutral-200 line-clamp-1 break-all">
                    {i.title}
                  </div>
                  {i.culprit && (
                    <div className="text-xs text-neutral-500 line-clamp-1 break-all font-mono mt-0.5">
                      {i.culprit}
                    </div>
                  )}
                </div>
                <div className="text-xs text-neutral-400 shrink-0 text-right">
                  <div>{i.occurrences_count} events</div>
                  <div className="text-neutral-600">{formatRelative(i.last_seen_at)}</div>
                </div>
                {i.status !== 'open' && (
                  <span className="text-[10px] uppercase tracking-wider text-neutral-500 shrink-0 mt-0.5">
                    {i.status.replace(/_/g, ' ')}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function ManageAlertsDialog({
  appId,
  project,
  onClose,
}: {
  appId: string
  project: Project
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[720px] max-h-[85vh] overflow-y-auto bg-neutral-950 border border-neutral-800 rounded-xl shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4">
          <div className="flex items-center gap-2">
            <Notification size={16} className="text-neutral-300" />
            <h3 className="text-[14px] font-medium text-neutral-100">Manage alerts</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-8 flex items-center justify-center rounded-md hover:bg-neutral-800 text-neutral-400"
          >
            <Close size={14} />
          </button>
        </div>
        <div className="px-5">
          <AlertsPanel appId={appId} project={project} />
        </div>
      </div>
    </div>
  )
}
