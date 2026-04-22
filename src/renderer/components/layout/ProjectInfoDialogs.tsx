import { useEffect, useState } from 'react'
import { Close } from '@carbon/icons-react'
import type { Project, Task } from '../../../shared/types'
import { UserAvatar } from '../ui/UserAvatar'

interface AuditEntry {
  id: number
  actor: { id: number; name: string; email: string; avatar_url: string | null } | null
  entity_type: string
  entity_id: string
  action: string
  diff: unknown
  created_at: string
}

interface TaskWithEnv extends Task {
  environment: { id: string; name: string; label: string | null }
}

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

function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-[760px] max-w-[92vw] max-h-[80vh] flex flex-col overflow-hidden"
      >
        <div className="h-12 px-4 flex items-center border-b border-neutral-800 shrink-0">
          <div className="text-[14px] font-medium text-neutral-100">{title}</div>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <Close size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}

export function ProjectAuditDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.audit
      .project(project.id)
      .then((data) => { if (!cancelled) setEntries(data as AuditEntry[]) })
      .catch((err: Error) => { if (!cancelled) setError(err.message) })
    return () => { cancelled = true }
  }, [project.id])

  return (
    <Modal title={`Activity · ${project.name}`} onClose={onClose}>
      {error && (
        <div className="px-4 py-3 text-[12px] text-red-400">Failed to load activity: {error}</div>
      )}
      {!error && entries === null && (
        <div className="px-4 py-8 text-center text-[12px] text-neutral-500">Loading…</div>
      )}
      {entries && entries.length === 0 && (
        <div className="px-4 py-8 text-center text-[12px] text-neutral-500">No activity recorded yet.</div>
      )}
      {entries && entries.length > 0 && (
        <ul className="divide-y divide-neutral-800">
          {entries.map((e) => (
            <li key={e.id} className="px-4 py-2.5 flex items-start gap-3">
              <UserAvatar url={e.actor?.avatar_url ?? null} name={e.actor?.name ?? null} size={28} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-neutral-100">
                  <span className="font-medium">{e.actor?.name ?? 'system'}</span>{' '}
                  <span className="text-neutral-400">
                    {e.action} {e.entity_type}
                  </span>
                </div>
                <div className="text-[11px] text-neutral-500">{formatRelative(e.created_at)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

interface TaskPage {
  data: TaskWithEnv[]
  current_page: number
  last_page: number
  per_page: number
  total: number
}

export function ProjectTasksDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [pages, setPages] = useState<TaskPage[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'open' | 'done' | 'all'>('open')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')

  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q), 250)
    return () => clearTimeout(h)
  }, [q])

  // Reload page 1 on filter change. Backend returns a Laravel paginator;
  // we keep the accumulated pages in state and the "Load more" button
  // appends subsequent pages without re-fetching the earlier ones.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.electronAPI.tasks
      .listByProject(project.id, {
        q: debouncedQ || undefined,
        status,
        per_page: 50,
        page: 1,
      })
      .then((data) => {
        if (!cancelled) setPages([data as TaskPage])
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [project.id, status, debouncedQ])

  const rows = pages.flatMap((p) => p.data ?? [])
  const last = pages[pages.length - 1]
  const hasMore = last ? last.current_page < last.last_page : false
  const total = last?.total ?? 0

  const loadMore = async () => {
    if (!last || loading) return
    setLoading(true)
    try {
      const next = (await window.electronAPI.tasks.listByProject(project.id, {
        q: debouncedQ || undefined,
        status,
        per_page: last.per_page,
        page: last.current_page + 1,
      })) as TaskPage
      setPages((prev) => [...prev, next])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal title={`Tasks · ${project.name}`} onClose={onClose}>
      <div className="px-3 pt-3 pb-2 flex items-center gap-2 border-b border-neutral-800">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="h-8 rounded-md bg-neutral-900/60 border border-neutral-800 px-2.5 text-[13px] text-neutral-100 placeholder:text-neutral-500 outline-none focus:border-neutral-600 w-60"
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
        <div className="ml-auto text-[11px] text-neutral-500 tabular-nums">{total} total</div>
      </div>
      {error && (
        <div className="px-4 py-3 text-[12px] text-red-400">Failed to load tasks: {error}</div>
      )}
      {!error && loading && pages.length === 0 && (
        <div className="px-4 py-8 text-center text-[12px] text-neutral-500">Loading…</div>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="px-4 py-8 text-center text-[12px] text-neutral-500">No matching tasks.</div>
      )}
      {rows.length > 0 && (
        <table className="w-full text-[13px]">
          <thead className="bg-neutral-900/60 text-neutral-400 text-[11px] uppercase tracking-wide sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Title</th>
              <th className="px-3 py-2 text-left font-medium">Environment</th>
              <th className="w-28 px-3 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-neutral-800">
                <td className="px-3 py-1.5 text-neutral-100">{t.title}</td>
                <td className="px-3 py-1.5 text-neutral-400">
                  {t.environment.label || t.environment.name}
                </td>
                <td className="px-3 py-1.5">
                  <StatusBadge status={t.status} />
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
    </Modal>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    open: 'bg-neutral-800 text-neutral-300',
    in_progress: 'bg-blue-900/40 text-blue-300',
    done: 'bg-emerald-900/40 text-emerald-300',
    completed: 'bg-emerald-900/40 text-emerald-300',
  }
  const cls = colors[status] || 'bg-neutral-800 text-neutral-300'
  return (
    <span className={`inline-flex items-center px-1.5 h-5 rounded text-[11px] ${cls}`}>{status}</span>
  )
}
