import { useMemo, useRef, useState } from 'react'
import { AddLarge, Apps } from '@carbon/icons-react'
import { UserMenu } from '../auth/UserMenu'
import { useAuthStore } from '../../stores/auth-store'
import { useProjects, useReorderProjects, useUpdateProject } from '../../hooks/useProjects'
import { useAllAgents } from '../../hooks/useAgents'
import { useActivityStore } from '../../stores/activity-store'
import { useAppStore } from '../../stores/app-store'
import { useUnreadStore } from '../../stores/unread-store'
import { NewProjectDialog } from '../dialogs/NewProjectDialog'
import { FaviconOrIdenticon } from '../ui/ProjectIcon'
import { InstantTooltip } from '../ui/Tooltip'
import {
  ContextMenu,
  RenameProjectDialog,
  type ContextMenuState,
} from './Sidebar'
import type { Agent, Project } from '../../../shared/types'

const ease = 'cubic-bezier(0.25, 1.1, 0.4, 1)'

function AppMark() {
  return (
    <div className="size-7">
      <div className="aspect-[24/24] grow min-h-px min-w-px overflow-clip relative shrink-0">
        <div className="absolute aspect-[24/16] left-0 right-0 top-1/2 -translate-y-1/2">
          <svg className="block size-full" fill="none" viewBox="0 0 24 16">
            <path
              d="M0.32 0C0.20799 0 0.151984 0 0.109202 0.0217987C0.0715695 0.0409734 0.0409734 0.0715695 0.0217987 0.109202C0 0.151984 0 0.20799 0 0.32V6.68C0 6.79201 0 6.84801 0.0217987 6.8908C0.0409734 6.92843 0.0715695 6.95902 0.109202 6.9782C0.151984 7 0.207989 7 0.32 7L3.68 7C3.79201 7 3.84802 7 3.8908 6.9782C3.92843 6.95903 3.95903 6.92843 3.9782 6.8908C4 6.84801 4 6.79201 4 6.68V4.32C4 4.20799 4 4.15198 4.0218 4.1092C4.04097 4.07157 4.07157 4.04097 4.1092 4.0218C4.15198 4 4.20799 4 4.32 4L19.68 4C19.792 4 19.848 4 19.8908 4.0218C19.9284 4.04097 19.959 4.07157 19.9782 4.1092C20 4.15198 20 4.20799 20 4.32V6.68C20 6.79201 20 6.84802 20.0218 6.8908C20.041 6.92843 20.0716 6.95903 20.1092 6.9782C20.152 7 20.208 7 20.32 7L23.68 7C23.792 7 23.848 7 23.8908 6.9782C23.9284 6.95903 23.959 6.92843 23.9782 6.8908C24 6.84802 24 6.79201 24 6.68V0.32C24 0.20799 24 0.151984 23.9782 0.109202C23.959 0.0715695 23.9284 0.0409734 23.8908 0.0217987C23.848 0 23.792 0 23.68 0H0.32Z"
              fill="#FAFAFA"
            />
            <path
              d="M0.32 16C0.20799 16 0.151984 16 0.109202 15.9782C0.0715695 15.959 0.0409734 15.9284 0.0217987 15.8908C0 15.848 0 15.792 0 15.68V9.32C0 9.20799 0 9.15198 0.0217987 9.1092C0.0409734 9.07157 0.0715695 9.04097 0.109202 9.0218C0.151984 9 0.207989 9 0.32 9H3.68C3.79201 9 3.84802 9 3.8908 9.0218C3.92843 9.04097 3.95903 9.07157 3.9782 9.1092C4 9.15198 4 9.20799 4 9.32V11.68C4 11.792 4 11.848 4.0218 11.8908C4.04097 11.9284 4.07157 11.959 4.1092 11.9782C4.15198 12 4.20799 12 4.32 12L19.68 12C19.792 12 19.848 12 19.8908 11.9782C19.9284 11.959 19.959 11.9284 19.9782 11.8908C20 11.848 20 11.792 20 11.68V9.32C20 9.20799 20 9.15199 20.0218 9.1092C20.041 9.07157 20.0716 9.04098 20.1092 9.0218C20.152 9 20.208 9 20.32 9H23.68C23.792 9 23.848 9 23.8908 9.0218C23.9284 9.04098 23.959 9.07157 23.9782 9.1092C24 9.15199 24 9.20799 24 9.32V15.68C24 15.792 24 15.848 23.9782 15.8908C23.959 15.9284 23.9284 15.959 23.8908 15.9782C23.848 16 23.792 16 23.68 16H0.32Z"
              fill="#FAFAFA"
            />
            <path
              d="M6.32 10C6.20799 10 6.15198 10 6.1092 9.9782C6.07157 9.95903 6.04097 9.92843 6.0218 9.8908C6 9.84802 6 9.79201 6 9.68V6.32C6 6.20799 6 6.15198 6.0218 6.1092C6.04097 6.07157 6.07157 6.04097 6.1092 6.0218C6.15198 6 6.20799 6 6.32 6L17.68 6C17.792 6 17.848 6 17.8908 6.0218C17.9284 6.04097 17.959 6.07157 17.9782 6.1092C18 6.15198 18 6.20799 18 6.32V9.68C18 9.79201 18 9.84802 17.9782 9.8908C17.959 9.92843 17.9284 9.95903 17.8908 9.9782C17.848 10 17.792 10 17.68 10H6.32Z"
              fill="#FAFAFA"
            />
          </svg>
        </div>
      </div>
    </div>
  )
}

interface ProjectIconProps {
  project: Project
  active: boolean
  working: boolean
  /** Slack-style unread dot — something happened in this project while the
   *  user was elsewhere. Cleared automatically when they select the project. */
  unread: boolean
  isDragOver: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

function ProjectIcon({
  project,
  active,
  working,
  unread,
  isDragOver,
  onClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ProjectIconProps) {
  return (
    <InstantTooltip label={project.name} side="right">
    <div
      role="button"
      tabIndex={0}
      aria-label={project.name}
      draggable
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`relative flex items-center justify-center rounded-lg size-10 min-w-10 cursor-grab active:cursor-grabbing select-none transition-colors duration-500 hover:bg-neutral-800/60 ${
        isDragOver ? 'ring-2 ring-blue-500' : ''
      }`}
      style={{ transitionTimingFunction: ease }}
    >
      <div className="relative size-6 flex items-center justify-center">
        <FaviconOrIdenticon url={project.favicon_url} seed={project.id} size={24} />
        {unread && (
          /* Slack-style unread dot. Sits in the top-right corner of the icon;
             ring gives separation from the app-sidebar background so it's
             visible even on dark favicons. Cleared when the user enters
             this project (see useAppStore.selectProject). */
          <span
            className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-red-500 ring-2 ring-[#0f0f0f] pointer-events-none"
            aria-label="Unread activity"
          />
        )}

        {working && (
          <>
            {/* Minimal dim that sits exactly on the favicon — same 24×24 box,
                slightly dark + a subtle blur so the favicon stays accennata. */}
            <div className="absolute inset-0 rounded-sm bg-black/45 pointer-events-none" />
            <svg
              viewBox="0 0 24 24"
              className="absolute inset-0 m-auto size-3.5 animate-spin pointer-events-none"
              fill="none"
            >
              <circle cx="12" cy="12" r="9" stroke="#60a5fa" strokeWidth="3" opacity="0.25" />
              <path
                d="M12 3a9 9 0 0 1 9 9"
                stroke="#60a5fa"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
          </>
        )}
      </div>
    </div>
    </InstantTooltip>
  )
}

export function IconNavSidebar() {
  const { data: projects } = useProjects()
  const { data: allAgents } = useAllAgents()
  const activities = useActivityStore((s) => s.activities)
  const reorderProjects = useReorderProjects()
  const updateProject = useUpdateProject()

  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const selectProject = useAppStore((s) => s.selectProject)
  // Subscribe to every unread map so the primary-sidebar project dot
  // reacts to roll-up changes (direct byProject entries AND any sub-scope
  // entry whose denorm projectId matches). Equivalent to calling
  // `hasProject(id)` for each project on every render, but we avoid the
  // function-level memo mismatch zustand has with derived selectors.
  const unreadByProject = useUnreadStore((s) => s.byProject)
  const unreadByStack = useUnreadStore((s) => s.byStack)
  const unreadByEnvironment = useUnreadStore((s) => s.byEnvironment)
  const unreadByEnvPin = useUnreadStore((s) => s.byEnvPin)
  const unreadByStackPin = useUnreadStore((s) => s.byStackPin)
  const openProjectSettings = useAppStore((s) => s.openProjectSettings)
  const showAllProjects = useAppStore((s) => s.showAllProjects)
  const openAllProjects = useAppStore((s) => s.openAllProjects)
  const closeAllProjects = useAppStore((s) => s.closeAllProjects)

  // Sidebar shows only pinned projects. If nothing is pinned yet, fall back to
  // the full list so existing users aren't staring at an empty rail — the first
  // pin narrows it automatically.
  const visibleProjects = useMemo(() => {
    if (!projects || projects.length === 0) return [] as Project[]
    const pinned = projects.filter((p) => p.pinned)
    return pinned.length > 0 ? pinned : projects
  }, [projects])

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renamingProject, setRenamingProject] = useState<Project | null>(null)
  const openAddEnvironment = useAppStore((s) => s.openAddEnvironment)
  const [showNewProject, setShowNewProject] = useState(false)

  const [dragOverProjectId, setDragOverProjectId] = useState<string | null>(null)
  const dragProjectRef = useRef<string | null>(null)

  // Map projectId -> true if any of its agents is currently "working".
  // Uses agent.project_id (populated by listAll JOIN) + the activity store.
  const workingByProject = useMemo(() => {
    const map = new Map<string, boolean>()
    if (!allAgents) return map
    for (const a of allAgents as Agent[]) {
      if (!a.project_id) continue
      if (a.status !== 'running') continue
      if (activities.get(a.id) === 'working') map.set(a.project_id, true)
    }
    return map
  }, [allAgents, activities])

  const handleProjectContextMenu = (e: React.MouseEvent, project: Project) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Rename', onClick: () => setRenamingProject(project) },
        { label: 'Add Environment', onClick: () => openAddEnvironment(project.id) },
        {
          label: project.pinned ? 'Unpin from sidebar' : 'Pin to sidebar',
          onClick: () =>
            updateProject.mutate({
              id: project.id,
              data: { pinned: project.pinned ? 0 : 1 },
            }),
        },
        { label: 'Project Settings', onClick: () => openProjectSettings(project.id) },
      ],
    })
  }

  const handleClick = (project: Project) => {
    if (showAllProjects) closeAllProjects()
    selectProject(project.id)
  }

  return (
    <>
      <aside className="bg-black flex flex-col gap-2 items-center p-4 w-16 shrink-0 h-full border-r border-neutral-800">
        <div className="mb-2 size-10 flex items-center justify-center">
          <AppMark />
        </div>

        <InstantTooltip label="All projects" side="right">
          <button
            type="button"
            aria-label="All projects"
            onClick={() => (showAllProjects ? closeAllProjects() : openAllProjects())}
            className={`flex items-center justify-center rounded-lg size-10 min-w-10 transition-colors duration-500 ${
              showAllProjects
                ? 'bg-neutral-800 text-neutral-50'
                : 'hover:bg-neutral-800/60 text-neutral-400 hover:text-neutral-200'
            }`}
            style={{ transitionTimingFunction: ease }}
          >
            <Apps size={20} />
          </button>
        </InstantTooltip>

        <div className="h-px w-6 bg-neutral-800 shrink-0" />

        <div className="flex flex-col gap-2 w-full items-center overflow-y-auto flex-1 min-h-0 no-scrollbar">
          {visibleProjects.map((project) => (
            <ProjectIcon
              key={project.id}
              project={project}
              active={selectedProjectId === project.id && !showAllProjects}
              working={!!workingByProject.get(project.id)}
              unread={
                !!unreadByProject[project.id] ||
                Object.values(unreadByStack).some((e) => e.projectId === project.id) ||
                Object.values(unreadByEnvironment).some((e) => e.projectId === project.id) ||
                Object.values(unreadByEnvPin).some((e) => e.projectId === project.id) ||
                Object.values(unreadByStackPin).some((e) => e.projectId === project.id)
              }
              isDragOver={dragOverProjectId === project.id}
              onClick={() => handleClick(project)}
              onContextMenu={(e) => handleProjectContextMenu(e, project)}
              onDragStart={(e) => {
                e.stopPropagation()
                e.dataTransfer.setData('project-id', project.id)
                e.dataTransfer.effectAllowed = 'move'
                dragProjectRef.current = project.id
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                if (dragProjectRef.current && dragProjectRef.current !== project.id) {
                  setDragOverProjectId(project.id)
                }
              }}
              onDrop={(e) => {
                e.preventDefault()
                e.stopPropagation()
                const fromId = e.dataTransfer.getData('project-id')
                if (fromId && fromId !== project.id && projects) {
                  // Reorder only within the visible (pinned) slice; keep the
                  // remaining projects in their existing order so unpinned
                  // sort_order isn't disturbed.
                  const visibleIds = visibleProjects.map((p) => p.id)
                  const fi = visibleIds.indexOf(fromId)
                  const ti = visibleIds.indexOf(project.id)
                  if (fi !== -1 && ti !== -1) {
                    visibleIds.splice(fi, 1)
                    visibleIds.splice(ti, 0, fromId)
                    const visibleSet = new Set(visibleIds)
                    const rest = projects.filter((p) => !visibleSet.has(p.id)).map((p) => p.id)
                    reorderProjects.mutate([...visibleIds, ...rest])
                  }
                }
                setDragOverProjectId(null)
                dragProjectRef.current = null
              }}
              onDragEnd={() => {
                setDragOverProjectId(null)
                dragProjectRef.current = null
              }}
            />
          ))}
        </div>

        <div className="flex flex-col gap-2 w-full items-center shrink-0">
          <InstantTooltip label="New project" side="right">
            <button
              type="button"
              aria-label="New project"
              onClick={() => setShowNewProject(true)}
              className="flex items-center justify-center rounded-lg size-10 min-w-10 hover:bg-neutral-800 text-neutral-400 hover:text-neutral-300 transition-colors duration-500"
              style={{ transitionTimingFunction: ease }}
            >
              <AddLarge size={16} />
            </button>
          </InstantTooltip>
          <CurrentUserAvatar />
        </div>
      </aside>
      {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
      {renamingProject && (
        <RenameProjectDialog
          project={renamingProject}
          onClose={() => setRenamingProject(null)}
        />
      )}
      {showNewProject && (
        <NewProjectDialog onClose={() => setShowNewProject(false)} />
      )}
    </>
  )
}

function CurrentUserAvatar() {
  const user = useAuthStore((s) => s.user)
  if (!user) return null
  const initial = user.name?.charAt(0)?.toUpperCase() ?? '?'
  return (
    <UserMenu
      trigger={
        <button
          type="button"
          aria-label={user.name}
          title={user.name}
          className="size-8 rounded-full bg-neutral-900 border border-neutral-800 hover:border-neutral-600 overflow-hidden flex items-center justify-center text-[12px] text-neutral-50 transition-colors"
        >
          {user.avatar_url ? (
            <img src={user.avatar_url} alt="" className="size-full object-cover" />
          ) : (
            <span>{initial}</span>
          )}
        </button>
      }
    />
  )
}
