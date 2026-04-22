import { useState, useMemo } from 'react'
import { useProjects, useEnvironments, useTasks } from '../../hooks/useProjects'
import { useAllAgents } from '../../hooks/useAgents'
import { useAppStore } from '../../stores/app-store'
import { useActivityStore } from '../../stores/activity-store'
import { NewTaskDialog } from '../dialogs/NewTaskDialog'
import type { Agent, Task, Environment } from '../../../shared/types'

const easing = 'cubic-bezier(0.25, 1.1, 0.4, 1)'

/* ========================= Activity Badge ========================= */

function ActivityBadge({ agents }: { agents: Agent[] }) {
  const activities = useActivityStore((s) => s.activities)
  const running = agents.filter((a) => a.status === 'running')
  const completed = agents.filter((a) => a.status === 'completed')
  const errored = agents.filter((a) => a.status === 'error')
  const hasWorking = running.some((a) => activities.get(a.id) === 'working')

  if (running.length === 0 && completed.length === 0 && errored.length === 0) return null

  return (
    <span className="flex items-center gap-1.5 ml-auto shrink-0">
      {hasWorking ? (
        <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 animate-spin" fill="none">
          <circle cx="8" cy="8" r="6" stroke="#3b82f6" strokeWidth="2" opacity="0.15" />
          <path d="M8 2a6 6 0 0 1 6 6" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : running.length > 0 ? (
        <span className="w-[6px] h-[6px] rounded-full bg-blue-400 animate-pulse" />
      ) : null}
      {running.length > 0 && (
        <span className="text-[10px] font-medium text-blue-400 tabular-nums">{running.length}</span>
      )}
      {completed.length > 0 && (
        <span className="flex items-center gap-0.5">
          <svg viewBox="0 0 16 16" className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M3.5 8.5L6.5 11.5L12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="text-[10px] font-medium text-emerald-400 tabular-nums">{completed.length}</span>
        </span>
      )}
      {errored.length > 0 && (
        <span className="flex items-center gap-0.5">
          <span className="w-[6px] h-[6px] rounded-full bg-red-400" />
          <span className="text-[10px] font-medium text-red-400 tabular-nums">{errored.length}</span>
        </span>
      )}
    </span>
  )
}

/* ========================= Chevron ========================= */

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="w-3 h-3 shrink-0 text-neutral-500 transition-transform duration-300"
      style={{ transitionTimingFunction: easing, transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
      fill="currentColor"
    >
      <path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/* ========================= Add Button ========================= */

function AddButton({ onClick, label }: { onClick: (e: React.MouseEvent) => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center w-6 h-6 rounded-md text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 opacity-0 group-hover:opacity-100 transition-all duration-300 shrink-0"
      style={{ transitionTimingFunction: easing }}
      title={label}
    >
      <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M8 4v8M4 8h8" strokeLinecap="round" />
      </svg>
    </button>
  )
}

/* ========================= Task Node ========================= */

function TaskNode({ task, agentsByTask }: { task: Task; agentsByTask: Map<string, Agent[]> }) {
  const selectedTaskId = useAppStore((s) => s.selectedTaskId)
  const selectTask = useAppStore((s) => s.selectTask)
  const isSelected = selectedTaskId === task.id
  const taskAgents = agentsByTask.get(task.id) ?? []

  return (
    <div
      className={`group flex items-center gap-2.5 h-9 pl-9 pr-2 cursor-pointer text-[13px] rounded-lg mx-1 transition-all duration-300 ${
        isSelected
          ? 'bg-neutral-800 text-neutral-50'
          : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
      }`}
      style={{ transitionTimingFunction: easing }}
      onClick={() => selectTask(task.id)}
    >
      {/* Task dot */}
      <svg viewBox="0 0 16 16" className="w-4 h-4 shrink-0" fill="none">
        <rect x="3" y="3" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
        {isSelected && <rect x="5" y="5" width="6" height="6" rx="1.5" fill="currentColor" opacity="0.7" />}
      </svg>
      <span className="truncate flex-1">{task.title}</span>
      <ActivityBadge agents={taskAgents} />
    </div>
  )
}

/* ========================= Environment Node ========================= */

function EnvironmentNode({ env, agentsByTask }: { env: Environment; agentsByTask: Map<string, Agent[]> }) {
  const expanded = useAppStore((s) => s.expandedEnvironments.has(env.id))
  const toggleExpanded = useAppStore((s) => s.toggleEnvironmentExpanded)
  const selectEnvironment = useAppStore((s) => s.selectEnvironment)
  const { data: tasks } = useTasks(env.id)
  const [showNewTask, setShowNewTask] = useState(false)

  const envAgents = useMemo(() => {
    if (!tasks) return []
    return tasks.flatMap((t) => agentsByTask.get(t.id) ?? [])
  }, [tasks, agentsByTask])

  return (
    <>
      <div
        className="group flex items-center gap-2 h-9 pl-5 pr-2 cursor-pointer text-[13px] hover:bg-neutral-800/50 rounded-lg mx-1 transition-all duration-300"
        style={{ transitionTimingFunction: easing }}
        onClick={() => { toggleExpanded(env.id); selectEnvironment(env.id) }}
      >
        <Chevron expanded={expanded} />
        {/* Server icon */}
        <svg viewBox="0 0 16 16" className="w-4 h-4 shrink-0 text-neutral-400" fill="none" stroke="currentColor" strokeWidth="1.3">
          <rect x="2" y="2" width="12" height="4" rx="1.5" />
          <rect x="2" y="10" width="12" height="4" rx="1.5" />
          <circle cx="5" cy="4" r="0.8" fill="currentColor" />
          <circle cx="5" cy="12" r="0.8" fill="currentColor" />
        </svg>
        <span className="truncate text-neutral-200 flex-1">{env.name}</span>
        {env.label && (
          <span className="text-[11px] text-neutral-500 truncate max-w-[80px]">{env.label}</span>
        )}
        {!expanded && <ActivityBadge agents={envAgents} />}
        <AddButton onClick={(e) => { e.stopPropagation(); setShowNewTask(true) }} label="New Task" />
      </div>

      {/* Children with indent line */}
      {expanded && (
        <div className="ml-[22px] border-l border-neutral-800/60 pl-0">
          {tasks?.map((task) => <TaskNode key={task.id} task={task} agentsByTask={agentsByTask} />)}
          <div
            className="flex items-center h-7 pl-9 pr-2 cursor-pointer text-[11px] text-neutral-600 hover:text-neutral-400 mx-1 transition-colors duration-300"
            style={{ transitionTimingFunction: easing }}
            onClick={() => setShowNewTask(true)}
          >
            + add task
          </div>
        </div>
      )}

      {showNewTask && <NewTaskDialog environmentId={env.id} onClose={() => setShowNewTask(false)} />}
    </>
  )
}

/* ========================= Project Node ========================= */

function ProjectNode({ project, agentsByTask }: { project: { id: string; name: string }; agentsByTask: Map<string, Agent[]> }) {
  const expanded = useAppStore((s) => s.expandedProjects.has(project.id))
  const toggleExpanded = useAppStore((s) => s.toggleProjectExpanded)
  const selectProject = useAppStore((s) => s.selectProject)
  const { data: environments } = useEnvironments(project.id)
  const openAddEnvironment = useAppStore((s) => s.openAddEnvironment)
  const projectAgents = useProjectLevelAgents(environments, agentsByTask)

  return (
    <div className="mb-1">
      {/* Project header */}
      <div
        className="group flex items-center gap-2 h-10 px-2 cursor-pointer text-[14px] hover:bg-neutral-800/50 rounded-lg mx-1 transition-all duration-300"
        style={{ transitionTimingFunction: easing }}
        onClick={() => { toggleExpanded(project.id); selectProject(project.id) }}
      >
        <Chevron expanded={expanded} />
        {/* Folder icon */}
        <svg viewBox="0 0 16 16" className="w-4 h-4 shrink-0 text-blue-400" fill="none" stroke="currentColor" strokeWidth="1.3">
          <path d="M2 4.5V12.5C2 13.05 2.45 13.5 3 13.5H13C13.55 13.5 14 13.05 14 12.5V6C14 5.45 13.55 5 13 5H8.5L7 3H3C2.45 3 2 3.45 2 4V4.5Z" />
        </svg>
        <span className="truncate font-medium text-neutral-50 flex-1">{project.name}</span>
        {!expanded && <ActivityBadge agents={projectAgents} />}
        <AddButton onClick={(e) => { e.stopPropagation(); openAddEnvironment(project.id) }} label="New Environment" />
      </div>

      {/* Children with indent line */}
      {expanded && (
        <div className="ml-[14px] border-l border-neutral-800/60 pl-0">
          {environments?.map((env) => (
            <EnvironmentNode key={env.id} env={env} agentsByTask={agentsByTask} />
          ))}
          <div
            className="flex items-center h-7 pl-5 pr-2 cursor-pointer text-[11px] text-neutral-600 hover:text-neutral-400 mx-1 transition-colors duration-300"
            style={{ transitionTimingFunction: easing }}
            onClick={() => openAddEnvironment(project.id)}
          >
            + add environment
          </div>
        </div>
      )}
    </div>
  )
}

/* ========================= Hooks ========================= */

function useProjectLevelAgents(
  environments: Environment[] | undefined,
  agentsByTask: Map<string, Agent[]>
): Agent[] {
  const envTasks: Task[][] = []
  const envIds = environments?.map((e) => e.id) ?? []
  const t0 = useTasks(envIds[0] ?? null)
  const t1 = useTasks(envIds[1] ?? null)
  const t2 = useTasks(envIds[2] ?? null)
  const t3 = useTasks(envIds[3] ?? null)
  const t4 = useTasks(envIds[4] ?? null)
  if (t0.data) envTasks.push(t0.data)
  if (t1.data) envTasks.push(t1.data)
  if (t2.data) envTasks.push(t2.data)
  if (t3.data) envTasks.push(t3.data)
  if (t4.data) envTasks.push(t4.data)

  return useMemo(() => {
    return envTasks.flat().flatMap((t) => agentsByTask.get(t.id) ?? [])
  }, [envTasks, agentsByTask])
}

/* ========================= Root ========================= */

export function ProjectTree({ onAddProject }: { onAddProject: () => void }) {
  const { data: projects, isLoading } = useProjects()
  const { data: allAgents } = useAllAgents()

  const agentsByTask = useMemo(() => {
    const map = new Map<string, Agent[]>()
    if (allAgents) {
      for (const agent of allAgents) {
        const list = map.get(agent.task_id)
        if (list) list.push(agent)
        else map.set(agent.task_id, [agent])
      }
    }
    return map
  }, [allAgents])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <svg viewBox="0 0 16 16" className="w-5 h-5 animate-spin text-neutral-600" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" />
          <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
    )
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="px-4 py-12 text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-neutral-900 flex items-center justify-center">
          <svg viewBox="0 0 16 16" className="w-6 h-6 text-neutral-600" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M2 4.5V12.5C2 13.05 2.45 13.5 3 13.5H13C13.55 13.5 14 13.05 14 12.5V6C14 5.45 13.55 5 13 5H8.5L7 3H3C2.45 3 2 3.45 2 4V4.5Z" />
          </svg>
        </div>
        <p className="text-[14px] text-neutral-400 mb-1">No projects yet</p>
        <p className="text-[12px] text-neutral-600 mb-4">Create one to get started</p>
        <button
          onClick={onAddProject}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200 rounded-lg transition-colors duration-300"
          style={{ transitionTimingFunction: easing }}
        >
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M8 4v8M4 8h8" strokeLinecap="round" />
          </svg>
          New project
        </button>
      </div>
    )
  }

  return (
    <div className="py-1 flex flex-col gap-0.5">
      {projects.map((project) => (
        <ProjectNode key={project.id} project={project} agentsByTask={agentsByTask} />
      ))}
    </div>
  )
}
