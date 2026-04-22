import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, Close, Filter } from '@carbon/icons-react'
import { useAllProjects } from '../../hooks/useProjects'
import { useAppStore } from '../../stores/app-store'
import type { AuditEntry } from '../../../shared/types'

function formatRelative(iso: string): string {
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

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || isNaN(seconds)) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ${seconds % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const ACTION_COLORS: Record<string, string> = {
  create: 'bg-emerald-900/40 text-emerald-300',
  update: 'bg-blue-900/40 text-blue-300',
  delete: 'bg-red-900/40 text-red-300',
  share: 'bg-purple-900/40 text-purple-300',
  revoke: 'bg-amber-900/40 text-amber-300',
  transfer: 'bg-fuchsia-900/40 text-fuchsia-300',
}

function actionColor(action: string): string {
  if (action.startsWith('git.')) return 'bg-cyan-900/40 text-cyan-300'
  return ACTION_COLORS[action] || 'bg-neutral-800 text-neutral-300'
}

function entityLabel(e: AuditEntry): string {
  switch (e.entity_type) {
    case 'agent':
      return e.ref?.tab_name
        ? `${e.ref.tab_name}${e.ref.environment ? ` · ${e.ref.environment}` : ''}`
        : 'Agent'
    case 'task':
      return e.ref?.task_title
        ? `Task: ${e.ref.task_title}${e.ref.environment ? ` · ${e.ref.environment}` : ''}`
        : 'Task'
    case 'environment':
      return `Environment: ${e.ref?.environment ?? e.entity_id}`
    case 'project':
      return 'Project'
    case 'routine':
      return e.ref?.name ? `Routine: ${e.ref.name}` : 'Routine'
    default:
      return e.entity_type
  }
}

function actionLabel(e: AuditEntry): string {
  if (e.action.startsWith('git.')) {
    const op = e.action.slice(4).replace(/_/g, ' ')
    return `git ${op}`
  }
  if (e.entity_type === 'agent' && e.action === 'create') return 'launched'
  if (e.entity_type === 'agent' && e.action === 'delete') return 'closed'
  return e.action
}

function ActorCell({ actor }: { actor: AuditEntry['actor'] }) {
  if (!actor) return <span className="text-neutral-500">system</span>
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="size-6 rounded-full bg-neutral-800 border border-neutral-900 flex items-center justify-center overflow-hidden text-[10px] text-neutral-200 shrink-0">
        {actor.avatar_url
          ? <img src={actor.avatar_url} alt="" className="size-full object-cover" />
          : <span>{actor.name?.charAt(0)?.toUpperCase() ?? '?'}</span>}
      </div>
      <span className="truncate text-neutral-200" title={actor.email}>{actor.name}</span>
    </div>
  )
}

export function ActivityView({ projectId }: { projectId: string }) {
  const { data: projects } = useAllProjects()
  const project = projects?.find((p) => p.id === projectId)
  const closeAllProjects = useAppStore((s) => s.closeAllProjects)
  const closeActivity = useAppStore((s) => s.closeActivity)

  const [actorFilter, setActorFilter] = useState<string>('all')
  const [actionFilter, setActionFilter] = useState<string>('all')
  const [entityFilter, setEntityFilter] = useState<string>('all')

  const query = useQuery<AuditEntry[]>({
    queryKey: ['audit', projectId],
    queryFn: () => window.electronAPI.audit.project(projectId) as Promise<AuditEntry[]>,
    refetchInterval: 30_000,
  })

  const entries = query.data ?? []

  const actors = useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of entries) {
      if (e.actor) seen.set(String(e.actor.id), e.actor.name)
    }
    return Array.from(seen.entries())
  }, [entries])

  const actions = useMemo(() => Array.from(new Set(entries.map((e) => e.action))).sort(), [entries])
  const entityTypes = useMemo(() => Array.from(new Set(entries.map((e) => e.entity_type))).sort(), [entries])

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (actorFilter !== 'all') {
        if (!e.actor || String(e.actor.id) !== actorFilter) return false
      }
      if (actionFilter !== 'all' && e.action !== actionFilter) return false
      if (entityFilter !== 'all' && e.entity_type !== entityFilter) return false
      return true
    })
  }, [entries, actorFilter, actionFilter, entityFilter])

  // Compute aggregates: total wall time, total working time, total viewed
  // time across every agent run on this project.
  const agentStats = useMemo(() => {
    const seen = new Set<string>()
    let count = 0
    let totalSec = 0
    let workingSec = 0
    let viewedSec = 0
    for (const e of entries) {
      if (e.entity_type !== 'agent' || !e.ref) continue
      if (seen.has(e.entity_id)) continue
      seen.add(e.entity_id)
      count++
      if (e.ref.duration_seconds) totalSec += e.ref.duration_seconds
      if (e.ref.working_seconds) workingSec += e.ref.working_seconds
      if (e.ref.viewed_seconds) viewedSec += e.ref.viewed_seconds
    }
    return { count, totalSec, workingSec, viewedSec }
  }, [entries])

  const goBack = (): void => {
    closeActivity()
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0 gap-2">
        <button
          type="button"
          onClick={goBack}
          className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          title="Back"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="text-[13px] text-neutral-400 truncate">
          <button
            type="button"
            onClick={() => { closeActivity() }}
            className="hover:text-neutral-200 transition-colors"
          >
            All Projects
          </button>
          <span className="text-neutral-600 mx-1.5">/</span>
          <span className="text-neutral-300">{project?.name ?? 'Project'}</span>
          <span className="text-neutral-600 mx-1.5">/</span>
          <span className="text-neutral-100">Activity</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeAllProjects}
          aria-label="Close"
          title="Close"
          className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <Close size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">Activity report</h2>
            <p className="text-[14px] text-neutral-400">
              Every change, agent run and git operation on <span className="text-neutral-200">{project?.name ?? 'this project'}</span>.
              Useful for review, billing, and team auditing.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
            <Stat label="Events" value={String(entries.length)} />
            <Stat label="Agent runs" value={String(agentStats.count)} />
            <Stat label="Time agents worked" value={formatDuration(agentStats.workingSec)} />
            <Stat label="Time spent viewing" value={formatDuration(agentStats.viewedSec)} />
          </div>

          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <Filter size={14} className="text-neutral-500" />
            <FilterSelect label="Actor" value={actorFilter} onChange={setActorFilter}
              options={[{ value: 'all', label: 'All actors' }, ...actors.map(([id, name]) => ({ value: id, label: name }))]} />
            <FilterSelect label="Action" value={actionFilter} onChange={setActionFilter}
              options={[{ value: 'all', label: 'All actions' }, ...actions.map((a) => ({ value: a, label: a }))]} />
            <FilterSelect label="Entity" value={entityFilter} onChange={setEntityFilter}
              options={[{ value: 'all', label: 'All entities' }, ...entityTypes.map((e) => ({ value: e, label: e }))]} />
            {(actorFilter !== 'all' || actionFilter !== 'all' || entityFilter !== 'all') && (
              <button
                type="button"
                onClick={() => { setActorFilter('all'); setActionFilter('all'); setEntityFilter('all') }}
                className="h-7 px-2.5 rounded text-[12px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
              >
                Clear
              </button>
            )}
            <div className="flex-1" />
            <span className="text-[11px] text-neutral-500">{filtered.length} of {entries.length} events</span>
          </div>

          <div className="rounded-lg border border-neutral-800 overflow-hidden">
            <table className="w-full text-[13px]">
              <thead className="bg-neutral-900/60 text-neutral-400 text-[11px] uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium w-44">When</th>
                  <th className="px-3 py-2 text-left font-medium w-48">Actor</th>
                  <th className="px-3 py-2 text-left font-medium w-32">Action</th>
                  <th className="px-3 py-2 text-left font-medium">Target</th>
                  <th className="px-3 py-2 text-left font-medium w-28">Wall time</th>
                  <th className="px-3 py-2 text-left font-medium w-28">Worked</th>
                  <th className="px-3 py-2 text-left font-medium w-28">Viewed</th>
                </tr>
              </thead>
              <tbody>
                {query.isLoading && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-neutral-500">Loading…</td></tr>
                )}
                {!query.isLoading && filtered.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-neutral-500">No events match the filters.</td></tr>
                )}
                {filtered.map((e) => (
                  <tr key={e.id} className="border-t border-neutral-800 hover:bg-neutral-900/50">
                    <td className="px-3 py-2 align-top">
                      <div className="text-neutral-200">{formatRelative(e.created_at)}</div>
                      <div className="text-[11px] text-neutral-500">{new Date(e.created_at).toLocaleString()}</div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <ActorCell actor={e.actor} />
                    </td>
                    <td className="px-3 py-2 align-top">
                      <span className={`inline-flex items-center px-1.5 h-5 rounded text-[11px] ${actionColor(e.action)}`}>
                        {actionLabel(e)}
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="text-neutral-100 truncate" title={entityLabel(e)}>{entityLabel(e)}</div>
                      {e.summary && (
                        <div className="text-[11px] text-neutral-500 truncate" title={e.summary}>{e.summary}</div>
                      )}
                      {e.entity_type === 'agent' && e.ref?.agent_type && (
                        <div className="text-[11px] text-neutral-500">{e.ref.agent_type}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top text-neutral-300">
                      {formatDuration(e.ref?.duration_seconds)}
                    </td>
                    <td className="px-3 py-2 align-top text-neutral-300">
                      {formatDuration(e.ref?.working_seconds)}
                    </td>
                    <td className="px-3 py-2 align-top text-neutral-300">
                      {formatDuration(e.ref?.viewed_seconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="text-[18px] font-semibold text-neutral-50 mt-0.5">{value}</div>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
}) {
  return (
    <label className="inline-flex items-center gap-1 h-7 px-2 rounded border border-neutral-800 bg-neutral-900 text-[12px] text-neutral-400">
      <span>{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-neutral-200 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

