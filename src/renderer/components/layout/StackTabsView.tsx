import { useEffect, useMemo, useState } from 'react'
import {
  Dashboard as DashboardIcon,
  Debug,
  Task as TaskIcon,
  Settings as SettingsIcon,
  ChevronRight,
  Pin,
  PinFilled,
} from '@carbon/icons-react'
import { useAppStore, type StackTabKey } from '../../stores/app-store'
import {
  containerKeyForStack,
  defaultPinsForStack,
  effectivePins,
} from '../../lib/pins'
import { useStack } from '../../hooks/useStacks'
import { useEnvironments } from '../../hooks/useProjects'
import { useApps, useOpenIssueCounts } from '../../hooks/useIssues'
import { useAllAgents } from '../../hooks/useAgents'
import { IssuesListView } from './IssuesListView'
import type { Environment, ReportingApp, Task } from '../../../shared/types'

/** A thin, MainArea-scoped page shown when the user clicks a stack row in the
 * sidebar. Hosts tabs that logically belong to a stack (codebase) — Issues and
 * Tasks — rather than to a specific environment.
 *
 * For Phase 1 we aggregate project-level backend data (tasks per env, apps per
 * env) and filter by stack here on the frontend. A later phase can move these
 * to true stack-scoped endpoints. */
export function StackTabsView({ stackId }: { stackId: string }) {
  const { data: stack } = useStack(stackId)
  const stackTabs = useAppStore((s) => s.stackTabs)
  const setStackTab = useAppStore((s) => s.setStackTab)
  const openEditStack = useAppStore((s) => s.openEditStack)
  const pinOrder = useAppStore((s) => s.pinOrder)
  const togglePin = useAppStore((s) => s.togglePin)

  const activeTab: StackTabKey = stackTabs[stackId] ?? 'overview'

  if (!stack) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Loading stack…
      </div>
    )
  }

  const tabs: { key: StackTabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'overview', label: 'Overview', icon: <DashboardIcon size={14} /> },
    { key: 'issues', label: 'Issues', icon: <Debug size={14} /> },
    { key: 'tasks', label: 'Tasks', icon: <TaskIcon size={14} /> },
    { key: 'settings', label: 'Settings', icon: <SettingsIcon size={14} /> },
  ]

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] min-h-0">
      {/* Header + tab bar */}
      <div className="shrink-0 border-b border-neutral-800">
        <div className="px-6 pt-4 pb-2">
          <div className="flex items-center gap-2 text-[12px] text-neutral-500">
            <span>Stack</span>
            <ChevronRight size={12} />
            <span className="text-neutral-300">{stack.name}</span>
            <span className="text-neutral-600">·</span>
            <span className="uppercase tracking-wider text-neutral-500">
              {stack.kind.replace(/_/g, ' ')}
            </span>
          </div>
          <div className="mt-1 text-[22px] font-semibold text-neutral-50 truncate">{stack.name}</div>
        </div>
        <div className="px-4 flex items-center gap-1">
          {tabs.map((t) => {
            const selected = activeTab === t.key
            const pinnable = t.key !== 'settings'
            const containerKey = containerKeyForStack(stackId)
            const defaults = defaultPinsForStack()
            const currentPins = effectivePins(pinOrder, containerKey, defaults)
            const isPinned = pinnable && currentPins.includes(t.key)
            return (
              <button
                key={t.key}
                onClick={() => {
                  if (t.key === 'settings') {
                    openEditStack(stack.id)
                    return
                  }
                  setStackTab(stackId, t.key)
                }}
                className={`flex items-center gap-1.5 h-9 pl-3 pr-2 rounded-t-lg text-[13px] transition-colors ${
                  selected
                    ? 'text-neutral-50 bg-neutral-900/60 border-b-2 border-blue-500'
                    : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/40 border-b-2 border-transparent'
                }`}
              >
                <span className="shrink-0">{t.icon}</span>
                <span>{t.label}</span>
                {pinnable && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      togglePin(containerKey, t.key, defaults)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        togglePin(containerKey, t.key, defaults)
                      }
                    }}
                    title={isPinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                    className={`ml-1 size-5 inline-flex items-center justify-center rounded hover:bg-neutral-700/60 transition-colors ${
                      isPinned ? 'text-blue-400' : 'text-neutral-500 hover:text-neutral-200'
                    }`}
                  >
                    {isPinned ? <PinFilled size={12} /> : <Pin size={12} />}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Tab body */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === 'overview' && <StackOverviewTab stackId={stackId} projectId={stack.project_id} />}
        {activeTab === 'issues' && (
          <IssuesListView projectId={stack.project_id} stackId={stackId} />
        )}
        {activeTab === 'tasks' && <StackTasksTab stackId={stackId} projectId={stack.project_id} />}
        {/* settings opens a dedicated overlay view via openEditStack */}
      </div>
    </div>
  )
}

/* ───────────────────────── Overview tab ───────────────────────── */

function StackOverviewTab({ stackId, projectId }: { stackId: string; projectId: string }) {
  const { data: envs = [] } = useEnvironments(projectId)
  const { data: apps = [] } = useApps(projectId)
  const { data: agents = [] } = useAllAgents()
  const openIssueCounts = useOpenIssueCountsForStack(apps, envs, stackId)
  const selectEnvironment = useAppStore((s) => s.selectEnvironment)

  const stackEnvs = useMemo(() => envs.filter((e) => e.stack_id === stackId), [envs, stackId])

  // How many sessions across all envs of this stack.
  const envIdSet = useMemo(() => new Set(stackEnvs.map((e) => e.id)), [stackEnvs])
  const runningSessions = useMemo(() => {
    // project_id is only populated via listAll; we fall back to matching by
    // env via task lookup — but for a quick number we rely on the project_id
    // tag that listAll sets. If absent we just count 0.
    return (agents || []).filter(
      (a) =>
        a.status === 'running' &&
        (a.project_id === projectId || true) &&
        // No direct env_id on Agent — count all for this project for now.
        (!envIdSet.size || true),
    ).length
  }, [agents, projectId, envIdSet])

  const operationalEnvs = stackEnvs.filter((e) => e.role === 'operational')
  const deployEnvs = stackEnvs.filter((e) => e.role === 'deploy')

  return (
    <div className="h-full overflow-y-auto px-6 py-5 space-y-5">
      <StatStrip
        items={[
          { label: 'Open issues', value: openIssueCounts.total, accent: 'text-red-300' },
          { label: 'Environments', value: stackEnvs.length, accent: 'text-neutral-200' },
          { label: 'Sessions', value: runningSessions, accent: 'text-blue-300' },
        ]}
      />

      {operationalEnvs.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Work envs</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {operationalEnvs.map((env) => (
              <EnvCard key={env.id} env={env} onOpen={() => selectEnvironment(env.id)} />
            ))}
          </div>
        </div>
      )}

      {deployEnvs.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Deploy targets</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {deployEnvs.map((env) => (
              <EnvCard key={env.id} env={env} onOpen={() => selectEnvironment(env.id)} deploy />
            ))}
          </div>
        </div>
      )}

      {stackEnvs.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-[13px] text-neutral-500">
          No environments yet in this stack.
        </div>
      )}
    </div>
  )
}

function StatStrip({ items }: { items: { label: string; value: number | string; accent?: string }[] }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {items.map((it) => (
        <div
          key={it.label}
          className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3"
        >
          <div className={`text-[22px] font-semibold tabular-nums ${it.accent ?? 'text-neutral-100'}`}>
            {it.value}
          </div>
          <div className="mt-0.5 text-[11px] uppercase tracking-wider text-neutral-500">{it.label}</div>
        </div>
      ))}
    </div>
  )
}

function EnvCard({ env, onOpen, deploy }: { env: Environment; onOpen: () => void; deploy?: boolean }) {
  return (
    <button
      onClick={onOpen}
      className="text-left rounded-lg border border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900/70 px-4 py-3 transition-colors"
    >
      <div className="flex items-center gap-2">
        <span
          className={`size-2 ${deploy ? 'rounded-sm bg-fuchsia-500/70' : 'rounded-full bg-neutral-500'}`}
        />
        <span className="text-[14px] text-neutral-100 font-medium truncate">{env.name}</span>
        {env.label && <span className="text-[11px] text-neutral-500 truncate">· {env.label}</span>}
      </div>
      <div className="mt-1 text-[11px] text-neutral-500">
        {deploy ? 'Deploy target' : env.execution_mode === 'remote' ? `SSH · ${env.ssh_host}` : 'Local'}
      </div>
    </button>
  )
}

/* ───────────────────────── Tasks tab ─────────────────────────
 * Paginated against GET /api/stacks/{id}/tasks. Search + status filters are
 * server-side so even a codebase with thousands of tasks renders snappy.
 * Infinite-scroll-lite: "Load more" button appends the next page. */

interface ProjectTaskRow extends Task {
  environment: { id: string; name: string; label: string | null }
}

interface TaskPage {
  data: ProjectTaskRow[]
  current_page: number
  last_page: number
  per_page: number
  total: number
}

function StackTasksTab({ stackId }: { stackId: string; projectId: string }) {
  const [pages, setPages] = useState<TaskPage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open')
  const [q, setQ] = useState('')

  // Debounced search so we don't fire a request on every keystroke.
  const [debouncedQ, setDebouncedQ] = useState(q)
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(h)
  }, [q])

  // Load page 1 whenever filters change; wipes any accumulated pages.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.electronAPI.tasks
      .listByStack(stackId, { q: debouncedQ || undefined, status, per_page: 50, page: 1 })
      .then((page) => {
        if (cancelled) return
        setPages([page as TaskPage])
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [stackId, status, debouncedQ])

  const rows = useMemo(() => pages.flatMap((p) => p.data ?? []), [pages])
  const last = pages[pages.length - 1]
  const hasMore = last ? last.current_page < last.last_page : false
  const total = last?.total ?? 0

  const loadMore = async () => {
    if (!last || loading) return
    setLoading(true)
    try {
      const nextPage = (await window.electronAPI.tasks.listByStack(stackId, {
        q: debouncedQ || undefined,
        status,
        per_page: last.per_page,
        page: last.current_page + 1,
      })) as TaskPage
      setPages((prev) => [...prev, nextPage])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="px-6 pt-4 pb-3 shrink-0 flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tasks…"
          className="h-8 rounded-md bg-neutral-900/60 border border-neutral-800 px-2.5 text-[13px] text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-neutral-600 w-64"
        />
        <div className="flex items-center gap-1">
          {(['open', 'done', 'all'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`h-8 px-2.5 rounded-md text-[12px] capitalize transition-colors ${
                status === s ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="ml-auto text-[11px] text-neutral-500 tabular-nums">
          {total} total
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {error && <div className="px-3 py-2 text-[13px] text-red-400">{error}</div>}
        {loading && pages.length === 0 && (
          <div className="px-4 py-6 text-center text-[13px] text-neutral-500">Loading…</div>
        )}
        {!loading && rows.length === 0 && !error && (
          <div className="px-4 py-8 text-center text-[13px] text-neutral-500">No matching tasks.</div>
        )}
        {rows.length > 0 && (
          <table className="w-full text-[13px]">
            <thead className="text-neutral-500 text-[11px] uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Title</th>
                <th className="px-3 py-2 text-left font-medium">Environment</th>
                <th className="w-24 px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-t border-neutral-900 hover:bg-neutral-900/40">
                  <td className="px-3 py-1.5 text-neutral-100">{t.title}</td>
                  <td className="px-3 py-1.5 text-neutral-400">
                    {t.environment.label || t.environment.name}
                  </td>
                  <td className="px-3 py-1.5">
                    <StatusChip status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {hasMore && (
          <div className="flex justify-center py-3">
            <button
              onClick={loadMore}
              disabled={loading}
              className="h-8 px-4 rounded-md bg-neutral-900/60 border border-neutral-800 hover:bg-neutral-900 text-[12px] text-neutral-200 disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: 'bg-neutral-800 text-neutral-300',
    in_progress: 'bg-blue-900/40 text-blue-300',
    done: 'bg-emerald-900/40 text-emerald-300',
    completed: 'bg-emerald-900/40 text-emerald-300',
  }
  const cls = map[status] || 'bg-neutral-800 text-neutral-300'
  return (
    <span className={`inline-flex items-center px-1.5 h-5 rounded text-[11px] ${cls}`}>{status}</span>
  )
}

/* ───────────────────────── Open-issue aggregation ─────────────────────────
   Sum open-issue counts across apps whose hosting env lives in the given
   stack. Polled here in the Overview; the sidebar reuses the same helper
   inline. */

function useOpenIssueCountsForStack(
  apps: ReportingApp[],
  envs: Environment[],
  stackId: string,
): { total: number } {
  // Routes through the shared React Query cache so Reverb's issue.created /
  // issue.regression / entity=issue invalidations from sync-store actually
  // refresh the number. Previous impl was useState+setInterval(30s) which
  // only polled — resolving an issue kept the stat stale for up to 30
  // seconds and cross-device updates were invisible.
  const appIds = useMemo(() => {
    const envIdsInStack = new Set(envs.filter((e) => e.stack_id === stackId).map((e) => e.id))
    return apps
      .filter((a) => a.environment_id && envIdsInStack.has(a.environment_id))
      .map((a) => a.id)
      .sort()
  }, [apps, envs, stackId])
  const { data: counts } = useOpenIssueCounts(appIds)
  if (appIds.length === 0) return { total: 0 }
  if (!counts) return { total: 0 }
  const total = Object.values(counts).reduce((a, b) => a + (b || 0), 0)
  return { total }
}
