import { useMemo, useState } from 'react'
import { useAllProjects } from '../../hooks/useProjects'
import { useApps, useMyReportedIssues } from '../../hooks/useIssues'
import { useAuthStore } from '../../stores/auth-store'
import { UserAvatar } from '../ui/UserAvatar'
import { FaviconOrIdenticon } from '../ui/ProjectIcon'
import { ReportIssueDialog } from '../dialogs/ReportIssueDialog'
import type { Issue, IssueLevel, Project, ReportingApp } from '../../../shared/types'

/**
 * The ONLY view an issuer sees. Bypasses the full sidebar / main area
 * layout — no environments, no sessions, no settings. They get:
 *
 *   1. A header with their avatar + "Sign out"
 *   2. A one-click "Report a new issue" button
 *   3. Below it, a "My reports" list showing every issue they've filed,
 *      across every project/app they have access to. Each row is
 *      read-only: they can see the title, severity, which app it was
 *      filed against, and when. Clicking does nothing — they can't
 *      navigate into the issue detail (backend policy would 403 anyway).
 *
 * If the user's role changes to something higher later, they'll just
 * see the normal app shell on next load — no state to clear here.
 */
export function IssuerShell() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const { data: projects = [] } = useAllProjects()
  const { data: mineList, isLoading } = useMyReportedIssues()

  const [dialogOpen, setDialogOpen] = useState(false)

  // We don't pre-load apps per project here — it would be a cascade of
  // requests for a role that only rarely opens the form. Instead, when
  // the user clicks "Report", we lazy-load the first project they have
  // via ProjectAppsResolver below. The picker inside the dialog lets
  // them switch across apps they have access to.
  const [reportProjectId, setReportProjectId] = useState<string | null>(null)

  return (
    <div className="flex flex-col h-full w-full bg-[var(--bg-primary)] text-[var(--text-primary)]" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <header className="flex items-center px-5 h-12 border-b border-neutral-800 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="text-[13px] font-semibold tracking-wide">Alby — Report an issue</div>
        <div className="ml-auto flex items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {user && (
            <div className="flex items-center gap-2 text-[12px] text-neutral-400">
              <UserAvatar url={user.avatar_url} name={user.name} size={22} />
              <span>{user.name}</span>
            </div>
          )}
          <button
            type="button"
            onClick={() => logout()}
            className="text-[11px] text-neutral-500 hover:text-neutral-200"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="max-w-[720px] mx-auto px-6 py-10">
          <h1 className="text-xl font-medium mb-1">Report a new issue</h1>
          <p className="text-[13px] text-neutral-500 mb-6">
            You can file a bug or feedback against any project you're an issuer on. The team sees your name on every report, so write it like you'd write it to a colleague.
          </p>

          {projects.length === 0 ? (
            <div className="rounded border border-dashed border-neutral-800 p-6 text-center text-[13px] text-neutral-500">
              You aren't assigned to any project yet. Ask your team admin to invite you as an issuer.
            </div>
          ) : (
            <ProjectPickerGrid
              projects={projects}
              onPick={(pid) => { setReportProjectId(pid); setDialogOpen(true) }}
            />
          )}

          <section className="mt-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-medium text-neutral-200">My reports</h2>
              <span className="text-[11px] text-neutral-600">
                {mineList?.total ?? (isLoading ? '…' : 0)} total
              </span>
            </div>
            {isLoading ? (
              <div className="text-[12px] text-neutral-500 py-6 text-center">Loading…</div>
            ) : (mineList?.data?.length ?? 0) === 0 ? (
              <div className="rounded border border-neutral-800 p-6 text-center text-[12px] text-neutral-500">
                You haven't filed any issue yet.
              </div>
            ) : (
              <MineList issues={mineList!.data} projects={projects} />
            )}
          </section>
        </div>
      </main>

      {dialogOpen && reportProjectId && (
        <ProjectAppsResolver projectId={reportProjectId}>
          {(apps) => (
            <ReportIssueDialog
              apps={apps}
              onClose={() => { setDialogOpen(false); setReportProjectId(null) }}
            />
          )}
        </ProjectAppsResolver>
      )}
    </div>
  )
}

/** Lazy wrapper: only fetch apps when the user actually opens the dialog. */
function ProjectAppsResolver({
  projectId,
  children,
}: {
  projectId: string
  children: (apps: ReportingApp[]) => React.ReactNode
}): React.ReactElement {
  const { data: apps = [], isLoading } = useApps(projectId)
  if (isLoading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div className="bg-neutral-900 border border-neutral-800 rounded px-4 py-3 text-sm text-neutral-400">
          Loading apps…
        </div>
      </div>
    )
  }
  return <>{children(apps)}</>
}

function ProjectPickerGrid({
  projects,
  onPick,
}: {
  projects: Project[]
  onPick: (projectId: string) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {projects.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onPick(p.id)}
          className="flex items-center gap-3 p-3 rounded border border-neutral-800 hover:border-neutral-600 hover:bg-neutral-900/40 transition-colors text-left"
        >
          <FaviconOrIdenticon url={p.favicon_url} seed={p.id} size={26} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium truncate">{p.name}</div>
            {p.url && (
              <div className="text-[11px] text-neutral-500 truncate">{p.url}</div>
            )}
          </div>
          <span className="text-[11px] text-neutral-500 shrink-0">Report →</span>
        </button>
      ))}
    </div>
  )
}

function MineList({ issues, projects: _projects }: { issues: Issue[]; projects: Project[] }) {
  // appId → project, built once so the row doesn't do O(P) lookups on
  // every render. Issues don't carry project_id directly; we use app_id
  // as the join key, and the backend is expected to ship enough info
  // that the issuer can tell their reports apart. If that's ever not
  // the case, this is the place to fall back to "App <id8>".
  const byId = useMemo(() => {
    const m = new Map<string, Issue>()
    for (const i of issues) m.set(i.id, i)
    return m
  }, [issues])

  return (
    <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 overflow-hidden">
      {Array.from(byId.values()).map((i) => (
        <li key={i.id} className="px-3 py-2 flex items-center gap-3">
          <LevelPill level={i.level} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-neutral-100 truncate">{i.title}</div>
            {i.description && (
              <div className="text-[11px] text-neutral-500 truncate">{i.description}</div>
            )}
          </div>
          <div className="text-[11px] text-neutral-600 tabular-nums shrink-0">
            {i.last_seen_at ? new Date(i.last_seen_at).toLocaleString() : '—'}
          </div>
        </li>
      ))}
    </ul>
  )
}

function LevelPill({ level }: { level: IssueLevel }) {
  const map: Record<IssueLevel, string> = {
    debug:   'text-neutral-400 bg-neutral-500/10',
    info:    'text-sky-300 bg-sky-500/10',
    warning: 'text-amber-300 bg-amber-500/10',
    error:   'text-red-300 bg-red-500/10',
    fatal:   'text-red-400 bg-red-500/20',
  }
  return (
    <span className={`shrink-0 text-[10px] uppercase px-1.5 py-0.5 rounded ${map[level]}`}>
      {level}
    </span>
  )
}
