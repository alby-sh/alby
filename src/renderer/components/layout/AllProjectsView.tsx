import { useEffect, useMemo, useRef, useState } from 'react'
import { Add, Close, Launch, List, Pin, PinFilled, Settings, Time } from '@carbon/icons-react'
import { useProjects, useUpdateProject } from '../../hooks/useProjects'
import { useAllAgents } from '../../hooks/useAgents'
import { useActivityStore } from '../../stores/activity-store'
import { UserAvatar } from '../ui/UserAvatar'
import { useAppStore } from '../../stores/app-store'
import { useAuthStore } from '../../stores/auth-store'
import { FaviconOrIdenticon } from '../ui/ProjectIcon'
import { NewProjectDialog } from '../dialogs/NewProjectDialog'
import { ProjectTasksDialog } from './ProjectInfoDialogs'
import type { Agent, Project, ProjectMember } from '../../../shared/types'

const SHORTCUT_LABEL =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl+K'

function MembersStack({ members }: { members: ProjectMember[] | undefined }) {
  if (!members || members.length === 0) {
    return <span className="text-neutral-600">—</span>
  }
  const visible = members.slice(0, 3)
  const extra = members.length - visible.length
  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((m) => (
        <UserAvatar
          key={m.id}
          url={m.avatar_url}
          name={m.name}
          size={24}
          title={`${m.name} · ${m.email}`}
          className="border border-neutral-900"
        />
      ))}
      {extra > 0 && (
        <div
          title={members.slice(3).map((m) => m.name).join(', ')}
          className="size-6 rounded-full bg-neutral-800 border border-neutral-900 flex items-center justify-center text-[10px] text-neutral-300"
        >
          +{extra}
        </div>
      )}
    </div>
  )
}

function IconBtn({
  label,
  onClick,
  children,
  active,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick() }}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center size-7 rounded-md transition-colors ${
        active
          ? 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10'
          : 'text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800'
      }`}
    >
      {children}
    </button>
  )
}

export function AllProjectsView() {
  const { data: projects } = useProjects()
  const { data: allAgents } = useAllAgents()
  const activities = useActivityStore((s) => s.activities)
  const updateProject = useUpdateProject()
  const selectProject = useAppStore((s) => s.selectProject)
  const closeAllProjects = useAppStore((s) => s.closeAllProjects)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const openActivity = useAppStore((s) => s.openActivity)
  const workspace = useAuthStore((s) => s.workspace)
  const teams = useAuthStore((s) => s.teams)

  // Per-project counts: how many agents are 'running' (active tab) and how
  // many of those are currently "working" (producing output / not idle).
  const agentStats = useMemo(() => {
    const map = new Map<string, { running: number; working: number }>()
    if (!allAgents) return map
    for (const a of allAgents as Agent[]) {
      if (!a.project_id || a.status !== 'running') continue
      const s = map.get(a.project_id) ?? { running: 0, working: 0 }
      s.running++
      if (activities.get(a.id) === 'working') s.working++
      map.set(a.project_id, s)
    }
    return map
  }, [allAgents, activities])

  // Hide the Activity icon for developer-role workspaces — only owner / admin /
  // viewer / analyst should see audit/reporting data.
  const canSeeActivity = (() => {
    if (workspace === 'all' || workspace === 'personal') return true
    const team = teams.find((t) => t.id === workspace)
    if (!team) return true
    return team.role !== 'developer'
  })()

  const [query, setQuery] = useState('')
  const [tasksFor, setTasksFor] = useState<Project | null>(null)
  const [creating, setCreating] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
      if (e.key === 'Escape') closeAllProjects()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeAllProjects])

  const filtered = useMemo(() => {
    if (!projects) return [] as Project[]
    const q = query.trim().toLowerCase()
    const list = q
      ? projects.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.url ?? '').toLowerCase().includes(q)
        )
      : [...projects]
    return list.sort((a, b) => {
      const ap = a.pinned ? 1 : 0
      const bp = b.pinned ? 1 : 0
      if (ap !== bp) return bp - ap
      return (a.sort_order ?? 0) - (b.sort_order ?? 0)
    })
  }, [projects, query])

  const handleOpen = (project: Project): void => {
    selectProject(project.id)
    closeAllProjects()
  }

  const handleTogglePin = (project: Project): void => {
    updateProject.mutate({
      id: project.id,
      data: { pinned: project.pinned ? 0 : 1 }
    })
  }

  const openLink = (url: string): void => {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    window.open(normalized, '_blank', 'noopener,noreferrer')
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-200">All Projects</div>
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
          <div className="flex items-start justify-between gap-6 mb-6">
            <div className="flex flex-col min-w-0">
              <h2 className="text-2xl font-bold text-neutral-50">All Projects</h2>
              <p className="text-[14px] text-neutral-400">
                Search across every project. Pin the ones you use most — they stay in the sidebar.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="shrink-0 h-9 px-3.5 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[13px] font-medium transition-colors"
              title="New project"
            >
              <Add size={14} /> New project
            </button>
          </div>

          <div className="relative mb-4">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects by name or URL…"
              className="w-full h-11 rounded-lg border border-neutral-700 bg-neutral-900 pl-4 pr-20 text-[14px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors"
            />
            <kbd className="absolute right-3 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded border border-neutral-700 bg-neutral-800 text-[11px] text-neutral-400 font-mono">
              {SHORTCUT_LABEL}
            </kbd>
          </div>

          <div className="rounded-lg border border-neutral-800 overflow-hidden">
            <table className="w-full text-[13px]">
              <thead className="bg-neutral-900/60 text-neutral-400 text-[11px] uppercase tracking-wide">
                <tr>
                  <th className="w-9 px-2 py-1.5 text-left font-medium"></th>
                  <th className="px-2 py-1.5 text-left font-medium">Name</th>
                  <th className="px-2 py-1.5 text-left font-medium">URL</th>
                  <th className="w-24 px-2 py-1.5 text-left font-medium">Active</th>
                  <th className="px-2 py-1.5 text-left font-medium">Members</th>
                  <th className="w-44 px-2 py-1.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-neutral-500">
                      {query ? 'No projects match.' : 'No projects yet.'}
                    </td>
                  </tr>
                )}
                {filtered.map((project) => (
                  <tr
                    key={project.id}
                    onClick={() => handleOpen(project)}
                    className="border-t border-neutral-800 cursor-pointer hover:bg-neutral-900/60 transition-colors"
                  >
                    <td className="px-2 py-1.5 align-middle">
                      <div className="relative size-6 flex items-center justify-center">
                        <FaviconOrIdenticon
                          url={project.favicon_url}
                          seed={project.id}
                          size={22}
                        />
                        {(agentStats.get(project.id)?.working ?? 0) > 0 && (
                          <>
                            <div className="absolute inset-0 rounded-sm bg-black/45 pointer-events-none" />
                            <svg
                              viewBox="0 0 24 24"
                              className="absolute inset-0 m-auto size-3.5 animate-spin pointer-events-none"
                              fill="none"
                            >
                              <circle cx="12" cy="12" r="9" stroke="#60a5fa" strokeWidth="3" opacity="0.25" />
                              <path d="M12 3a9 9 0 0 1 9 9" stroke="#60a5fa" strokeWidth="3" strokeLinecap="round" />
                            </svg>
                          </>
                        )}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 align-middle text-neutral-50">{project.name}</td>
                    <td className="px-2 py-1.5 align-middle text-neutral-400 max-w-[280px]">
                      {project.url ? (
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="truncate">{project.url}</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openLink(project.url!) }}
                            title="Open in browser"
                            aria-label="Open in browser"
                            className="shrink-0 size-5 inline-flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                          >
                            <Launch size={12} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-neutral-600">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      {(() => {
                        const s = agentStats.get(project.id) ?? { running: 0, working: 0 }
                        if (s.running === 0) return <span className="text-neutral-600 text-[12px]">—</span>
                        return (
                          <div className="inline-flex items-center gap-1.5 text-[12px]">
                            <span className={`w-1.5 h-1.5 rounded-full ${s.working > 0 ? 'bg-blue-400 animate-pulse' : 'bg-emerald-400'}`} />
                            <span className="text-neutral-200">{s.running}</span>
                            {s.working > 0 && (
                              <span className="text-[11px] text-neutral-500">· {s.working} working</span>
                            )}
                          </div>
                        )
                      })()}
                    </td>
                    <td className="px-2 py-1.5 align-middle">
                      <MembersStack members={project.members} />
                    </td>
                    <td className="px-2 py-1.5 align-middle text-right">
                      <div className="inline-flex items-center gap-1">
                        {canSeeActivity && (
                          <IconBtn label="Activity log" onClick={() => openActivity(project.id)}>
                            <Time size={14} />
                          </IconBtn>
                        )}
                        <IconBtn label="All tasks" onClick={() => setTasksFor(project)}>
                          <List size={14} />
                        </IconBtn>
                        <IconBtn
                          label={project.pinned ? 'Unpin from sidebar' : 'Pin to sidebar'}
                          onClick={() => handleTogglePin(project)}
                          active={!!project.pinned}
                        >
                          {project.pinned ? <PinFilled size={14} /> : <Pin size={14} />}
                        </IconBtn>
                        <IconBtn label="Project settings" onClick={() => openProjectSettings(project.id)}>
                          <Settings size={14} />
                        </IconBtn>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {tasksFor && <ProjectTasksDialog project={tasksFor} onClose={() => setTasksFor(null)} />}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  )
}
