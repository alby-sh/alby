import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import {
  Search as SearchIcon,
  Folder,
  ChevronDown as ChevronDownIcon,
  AddLarge,
  Launch,
  Terminal as TerminalIcon,
  Timer as TimerIcon,
  CloudUpload,
  Dashboard as DashboardIcon,
  Debug,
  Task as TaskIconCarbon,
  Play,
  Stop,
  LogoGithub,
} from '@carbon/icons-react'
import {
  useProjects,
  useEnvironments,
  useTasks,
  useReorderEnvironments,
  useUpdateEnvironment,
} from '../../hooks/useProjects'
import { useStacks, useReorderStacks } from '../../hooks/useStacks'
import { useApps, useOpenIssueCounts } from '../../hooks/useIssues'
import { useRoutines, useStartRoutine, useStopRoutine, useDeleteRoutine, useReorderRoutines } from '../../hooks/useRoutines'
import { useQueryClient } from '@tanstack/react-query'
import { useAllAgents, useDeleteAgent, useKillAgent, useReorderAgents, useSpawnAgent } from '../../hooks/useAgents'
import { useAppStore, type EnvTabKey, type StackTabKey } from '../../stores/app-store'
import { useToastStore } from '../../stores/toast-store'
import {
  containerKeyForEnv,
  containerKeyForStack,
  defaultPinsForEnv,
  defaultPinsForStack,
  effectivePins,
  EXPANDABLE_ENV_TABS,
  EXPANDABLE_STACK_TABS,
  pinKey as makePinKey,
} from '../../lib/pins'
import { useActivityStore } from '../../stores/activity-store'
import { useConnectionStore } from '../../stores/connection-store'
import { usePresenceFor } from '../../stores/presence-store'
import { AvatarStack } from '../ui/AvatarStack'
import { useUnreadStore, type EnvPinKey, type StackPinKey } from '../../stores/unread-store'
import { NewProjectDialog } from '../dialogs/NewProjectDialog'
import { FaviconOrIdenticon } from '../ui/ProjectIcon'
import type { Agent, Project, Environment, Stack, Task, Routine } from '../../../shared/types'

const ease = 'cubic-bezier(0.25, 1.1, 0.4, 1)'

export interface ContextMenuState { x: number; y: number; items: { label: string; onClick: () => void }[] }

/**
 * Tiny red dot used to signal "something here wants your attention". Shared
 * across project/stack/env/pin rows so the visual language is consistent.
 * `inline` variant sits next to a label (our default); `corner` absolute-
 * positions into the top-right of a square icon.
 */
function UnreadDot({ size = 8, variant = 'inline' }: { size?: number; variant?: 'inline' | 'corner' }) {
  if (variant === 'corner') {
    return (
      <span
        className="absolute -top-0.5 -right-0.5 rounded-full bg-red-500 ring-2 ring-neutral-950"
        style={{ width: size, height: size }}
        aria-label="Unread activity"
      />
    )
  }
  return (
    <span
      className="inline-block rounded-full bg-red-500 shrink-0"
      style={{ width: size, height: size }}
      aria-label="Unread activity"
    />
  )
}

/* Rendering rule (strict cascade): every level of the sidebar tree only
 * shows a dot when the LEVEL BELOW IS HIDDEN. Once a parent is expanded and
 * the child's own dot is visible, the parent's dot is redundant. We pass
 * `hideWhenExpanded` from the parent so the component stops rendering even
 * when its data is still "unread". Leaf rows (SessionRow / RoutineRow)
 * never hide — they're the ground truth. */

function StackUnreadDot({ stackId, hideWhenExpanded }: { stackId: string; hideWhenExpanded?: boolean }) {
  // Stack rollup: byStack + any stackPin / env / envPin / agent / routine
  // whose denorm stackId matches.
  const has = useUnreadStore((s) => {
    if (s.byStack[stackId]) return true
    const scan = (rec: Record<string, { stackId?: string }>): boolean =>
      Object.values(rec).some((e) => e.stackId === stackId)
    return scan(s.byStackPin) || scan(s.byEnvironment) || scan(s.byEnvPin)
      || scan(s.byAgent) || scan(s.byRoutine)
  })
  if (!has || hideWhenExpanded) return null
  return <span className="ml-1"><UnreadDot /></span>
}
function EnvUnreadDot({ envId, hideWhenExpanded }: { envId: string; hideWhenExpanded?: boolean }) {
  // Env rollup: byEnvironment + any pin / agent / routine that denormalized
  // this env id. Keeps the env header lit when the user scrolls its pins
  // into view but hasn't clicked any.
  const has = useUnreadStore((s) => {
    if (s.byEnvironment[envId]) return true
    const scan = (rec: Record<string, { environmentId?: string }>): boolean =>
      Object.values(rec).some((e) => e.environmentId === envId)
    return scan(s.byEnvPin) || scan(s.byAgent) || scan(s.byRoutine)
  })
  if (!has || hideWhenExpanded) return null
  return <span className="ml-1"><UnreadDot /></span>
}
function PinUnreadDot({ envId, pinKey, hideWhenExpanded }: { envId: string; pinKey: EnvPinKey; hideWhenExpanded?: boolean }) {
  // Pin rollup: the explicit byEnvPin entry + any leaf (agent / routine)
  // whose parent matches this env. That way an agent event will light the
  // Sessions pin even if we only marked byAgent (and vice versa).
  const has = useUnreadStore((s) => {
    if (s.byEnvPin[`${envId}::${pinKey}`]) return true
    if (pinKey === 'sessions' || pinKey === 'terminals') {
      return Object.values(s.byAgent).some((e) => e.environmentId === envId)
    }
    if (pinKey === 'routines') {
      return Object.values(s.byRoutine).some((e) => e.environmentId === envId)
    }
    return false
  })
  if (!has || hideWhenExpanded) return null
  return <span className="ml-1"><UnreadDot /></span>
}
function StackPinUnreadDot({ stackId, pinKey }: { stackId: string; pinKey: StackPinKey }) {
  // Stack pins (Issues / Tasks) are leaves in the UI — when visible they're
  // the deepest dot that event rolls up to, so no hideWhenExpanded gate.
  const has = useUnreadStore((s) => !!s.byStackPin[`${stackId}::${pinKey}`])
  return has ? <span className="ml-1"><UnreadDot /></span> : null
}
function AgentUnreadDot({ agentId }: { agentId: string }) {
  const has = useUnreadStore((s) => !!s.byAgent[agentId])
  return has ? <UnreadDot /> : null
}
function RoutineUnreadDot({ routineId }: { routineId: string }) {
  const has = useUnreadStore((s) => !!s.byRoutine[routineId])
  return has ? <UnreadDot /> : null
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  React.useEffect(() => {
    const handler = () => onClose()
    window.addEventListener('click', handler)
    window.addEventListener('contextmenu', handler)
    return () => { window.removeEventListener('click', handler); window.removeEventListener('contextmenu', handler) }
  }, [onClose])
  return (
    <div className="fixed z-50 bg-neutral-900 border border-neutral-700 rounded-lg py-1 shadow-xl min-w-[160px]" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
      {menu.items.map((item, i) => (
        <div key={i} className="px-3 h-8 flex items-center cursor-pointer text-[13px] text-neutral-200 hover:bg-neutral-800 transition-colors" onClick={() => { item.onClick(); onClose() }}>{item.label}</div>
      ))}
    </div>
  )
}

function AppLogo() {
  return (
    <div className="size-7">
      <div className="aspect-[24/24] grow min-h-px min-w-px overflow-clip relative shrink-0">
        <div className="absolute aspect-[24/16] left-0 right-0 top-1/2 -translate-y-1/2">
          <svg className="block size-full" fill="none" viewBox="0 0 24 16">
            <path d="M0.32 0C0.20799 0 0.151984 0 0.109202 0.0217987C0.0715695 0.0409734 0.0409734 0.0715695 0.0217987 0.109202C0 0.151984 0 0.20799 0 0.32V6.68C0 6.79201 0 6.84801 0.0217987 6.8908C0.0409734 6.92843 0.0715695 6.95902 0.109202 6.9782C0.151984 7 0.207989 7 0.32 7L3.68 7C3.79201 7 3.84802 7 3.8908 6.9782C3.92843 6.95903 3.95903 6.92843 3.9782 6.8908C4 6.84801 4 6.79201 4 6.68V4.32C4 4.20799 4 4.15198 4.0218 4.1092C4.04097 4.07157 4.07157 4.04097 4.1092 4.0218C4.15198 4 4.20799 4 4.32 4L19.68 4C19.792 4 19.848 4 19.8908 4.0218C19.9284 4.04097 19.959 4.07157 19.9782 4.1092C20 4.15198 20 4.20799 20 4.32V6.68C20 6.79201 20 6.84802 20.0218 6.8908C20.041 6.92843 20.0716 6.95903 20.1092 6.9782C20.152 7 20.208 7 20.32 7L23.68 7C23.792 7 23.848 7 23.8908 6.9782C23.9284 6.95903 23.959 6.92843 23.9782 6.8908C24 6.84802 24 6.79201 24 6.68V0.32C24 0.20799 24 0.151984 23.9782 0.109202C23.959 0.0715695 23.9284 0.0409734 23.8908 0.0217987C23.848 0 23.792 0 23.68 0H0.32Z" fill="#FAFAFA" />
            <path d="M0.32 16C0.20799 16 0.151984 16 0.109202 15.9782C0.0715695 15.959 0.0409734 15.9284 0.0217987 15.8908C0 15.848 0 15.792 0 15.68V9.32C0 9.20799 0 9.15198 0.0217987 9.1092C0.0409734 9.07157 0.0715695 9.04097 0.109202 9.0218C0.151984 9 0.207989 9 0.32 9H3.68C3.79201 9 3.84802 9 3.8908 9.0218C3.92843 9.04097 3.95903 9.07157 3.9782 9.1092C4 9.15198 4 9.20799 4 9.32V11.68C4 11.792 4 11.848 4.0218 11.8908C4.04097 11.9284 4.07157 11.959 4.1092 11.9782C4.15198 12 4.20799 12 4.32 12L19.68 12C19.792 12 19.848 12 19.8908 11.9782C19.9284 11.959 19.959 11.9284 19.9782 11.8908C20 11.848 20 11.792 20 11.68V9.32C20 9.20799 20 9.15199 20.0218 9.1092C20.041 9.07157 20.0716 9.04098 20.1092 9.0218C20.152 9 20.208 9 20.32 9H23.68C23.792 9 23.848 9 23.8908 9.0218C23.9284 9.04098 23.959 9.07157 23.9782 9.1092C24 9.15199 24 9.20799 24 9.32V15.68C24 15.792 24 15.848 23.9782 15.8908C23.959 15.9284 23.9284 15.959 23.8908 15.9782C23.848 16 23.792 16 23.68 16H0.32Z" fill="#FAFAFA" />
            <path d="M6.32 10C6.20799 10 6.15198 10 6.1092 9.9782C6.07157 9.95903 6.04097 9.92843 6.0218 9.8908C6 9.84802 6 9.79201 6 9.68V6.32C6 6.20799 6 6.15198 6.0218 6.1092C6.04097 6.07157 6.07157 6.04097 6.1092 6.0218C6.15198 6 6.20799 6 6.32 6L17.68 6C17.792 6 17.848 6 17.8908 6.0218C17.9284 6.04097 17.959 6.07157 17.9782 6.1092C18 6.15198 18 6.20799 18 6.32V9.68C18 9.79201 18 9.84802 17.9782 9.8908C17.959 9.92843 17.9284 9.95903 17.8908 9.9782C17.848 10 17.792 10 17.68 10H6.32Z" fill="#FAFAFA" />
          </svg>
        </div>
      </div>
    </div>
  )
}

// Reusable agent badge — works for single task or aggregated across many tasks
function AgentBadge({ agents }: { agents: Agent[] }) {
  const activities = useActivityStore((s) => s.activities)
  const running = agents.filter((a) => a.status === 'running')
  const completed = agents.filter((a) => a.status === 'completed')
  const errored = agents.filter((a) => a.status === 'error')
  const hasWorking = running.some((a) => activities.get(a.id) === 'working')
  if (running.length === 0 && completed.length === 0 && errored.length === 0) return null
  return (
    <span className="flex items-center gap-1 ml-auto shrink-0">
      {running.length > 0 && (<span className="flex items-center gap-1">{hasWorking ? (<svg viewBox="0 0 16 16" className="w-3 h-3 animate-spin" fill="none"><circle cx="8" cy="8" r="6" stroke="#3b82f6" strokeWidth="2" opacity="0.2" /><path d="M8 2a6 6 0 0 1 6 6" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" /></svg>) : (<span className="w-1.5 h-1.5 rounded-full bg-blue-400" />)}<span className="text-[11px] font-medium text-blue-400 tabular-nums">{running.length}</span></span>)}
      {completed.length > 0 && (<span className="flex items-center gap-0.5"><svg viewBox="0 0 16 16" className="w-3 h-3 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" strokeLinecap="round" strokeLinejoin="round" /></svg><span className="text-[11px] font-medium text-emerald-400 tabular-nums">{completed.length}</span></span>)}
      {errored.length > 0 && (<span className="text-[11px] font-medium text-red-400 tabular-nums">{errored.length}</span>)}
    </span>
  )
}

// Aggregate connection dot for a project (all environments)
function ProjectConnectionDot({ environments }: { environments: Environment[] }) {
  const statuses = useConnectionStore((s) => s.statuses)
  const envStatuses = environments.map((e) => statuses.get(e.id)).filter(Boolean) as string[]
  if (envStatuses.length === 0) return null
  const allConnected = envStatuses.every((s) => s === 'connected')
  const allError = envStatuses.every((s) => s === 'error')
  const color = allConnected ? 'bg-emerald-500' : allError ? 'bg-red-500' : 'bg-yellow-500'
  const label = allConnected ? 'All connected' : allError ? 'All disconnected' : 'Partial connection'
  return <span className={`w-2 h-2 rounded-full shrink-0 ml-1.5 ${color}`} title={label} />
}

// Get all agents across all tasks for an environment
function useEnvAgents(tasks: Task[] | undefined, agentsByTask: Map<string, Agent[]>): Agent[] {
  return useMemo(() => {
    if (!tasks) return []
    const all: Agent[] = []
    for (const t of tasks) {
      const agents = agentsByTask.get(t.id)
      if (agents) all.push(...agents)
    }
    return all
  }, [tasks, agentsByTask])
}

/* Sidebar-scoped Session row: one agent under its env. Compact (h-8), shows
 * agent type + task title + status dot + elapsed time. Click selects task +
 * agent so MainArea routes to the terminal. */
const SESSION_COLOR: Record<string, string> = {
  terminal: '#a3a3a3',
  claude: '#d4a27a',
  gemini: '#60a5fa',
  codex: '#34d399',
}

const AGENT_DND_MIME = 'application/x-alby-agent'

function SessionRow({
  agent,
  task,
  envId,
  isSelected,
  index,
  total,
  allAgentIds,
  onReorder,
  onContextMenu,
}: {
  agent: Agent
  task?: Task
  envId: string
  isSelected: boolean
  index: number
  total: number
  allAgentIds: string[]
  onReorder: (orderedIds: string[]) => void
  onContextMenu: (e: React.MouseEvent, agent: Agent, index: number, total: number) => void
}) {
  const activity = useActivityStore((s) => s.activities.get(agent.id))
  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const [dragOver, setDragOver] = useState<'above' | 'below' | null>(null)
  const viewers = usePresenceFor('agent', agent.id)
  // tab_name is stored as a display string like "Claude" or "Terminal"; we
  // normalise to a lowercase kind to pick a colour and a short label.
  const kind = (agent.tab_name?.split(' ')[0] || 'terminal').toLowerCase()
  const color = SESSION_COLOR[kind] ?? SESSION_COLOR.terminal
  const isRunningWorking = agent.status === 'running' && activity === 'working'
  const dotCls =
    agent.status === 'running'
      ? 'bg-blue-500/70'
      : agent.status === 'error'
        ? 'bg-red-500'
        : agent.status === 'completed'
          ? 'bg-neutral-600'
          : 'bg-neutral-500'
  const title = task?.is_default
    ? kind.charAt(0).toUpperCase() + kind.slice(1)
    : task?.title || 'Session'
  // Suppress in-place "ghost" indicators on the dragged row itself.
  const suppressOwnIndicator = (srcId: string): boolean => srcId === agent.id
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(AGENT_DND_MIME, agent.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(AGENT_DND_MIME)) return
        e.preventDefault()
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const upper = e.clientY - rect.top < rect.height / 2
        setDragOver(upper ? 'above' : 'below')
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        const srcId = e.dataTransfer.getData(AGENT_DND_MIME)
        const where = dragOver
        setDragOver(null)
        if (!srcId || srcId === agent.id) return
        const next = allAgentIds.filter((id) => id !== srcId)
        const targetIdx = next.indexOf(agent.id)
        if (targetIdx < 0) return
        const insertAt = where === 'below' ? targetIdx + 1 : targetIdx
        next.splice(insertAt, 0, srcId)
        onReorder(next)
      }}
      onContextMenu={(e) => onContextMenu(e, agent, index, total)}
      className={`relative rounded-lg cursor-pointer flex items-center h-8 pl-10 pr-2 transition-colors ${
        isSelected ? 'bg-neutral-800/60' : 'hover:bg-neutral-800/30'
      }`}
      onClick={() => {
        selectTask(agent.task_id, envId)
        setActiveAgent(agent.id)
      }}
    >
      {dragOver === 'above' && !suppressOwnIndicator(agent.id) && (
        <div className="absolute left-10 right-2 top-0 h-[2px] bg-blue-500 rounded pointer-events-none" />
      )}
      {dragOver === 'below' && !suppressOwnIndicator(agent.id) && (
        <div className="absolute left-10 right-2 bottom-0 h-[2px] bg-blue-500 rounded pointer-events-none" />
      )}
      {isRunningWorking ? (
        // Spinning ring when the agent is actively doing something — mirrors
        // the AgentBadge glyph used on the collapsed "Sessions" pin so the
        // visual language stays consistent between "which envs have work"
        // and "which specific agent is working".
        <svg
          viewBox="0 0 16 16"
          className="size-3 shrink-0 animate-spin"
          fill="none"
          aria-label="Agent working"
        >
          <circle cx="8" cy="8" r="6" stroke="#60a5fa" strokeWidth="2" opacity="0.25" />
          <path d="M8 2a6 6 0 0 1 6 6" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span className={`size-2 rounded-full shrink-0 ${dotCls}`} />
      )}
      <span
        className="ml-2 shrink-0 w-1 h-3 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="ml-2 text-[12px] text-neutral-100 truncate flex-1">{title}</span>
      <span className="ml-2 shrink-0 flex items-center">
        <AgentUnreadDot agentId={agent.id} />
      </span>
      {viewers.length > 0 && (
        <span className="ml-2"><AvatarStack users={viewers} /></span>
      )}
      <span className="ml-2 text-[10px] text-neutral-500 tabular-nums shrink-0">
        {formatAgo(agent.started_at || agent.created_at)}
      </span>
    </div>
  )
}

function formatAgo(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

interface GitStatusData { modified: number; staged: number; ahead: number; behind: number; hasRepo: boolean }

function useGitStatus(envId: string) {
  const [status, setStatus] = useState<GitStatusData | null>(null)
  const refresh = useCallback(() => { window.electronAPI.git.status(envId).then(setStatus).catch(() => {}) }, [envId])
  useEffect(() => { refresh(); const t = setInterval(refresh, 15000); return () => clearInterval(t) }, [refresh])
  return { status, refresh }
}

function GitBadges({ status, onAction }: { status: GitStatusData | null; onAction: (e: React.MouseEvent) => void }) {
  const hasRepo = !!status?.hasRepo
  const hasChanges = hasRepo && ((status!.modified > 0) || (status!.ahead > 0) || (status!.behind > 0))
  // The GitHub icon is always present so the user can reach the git menu
  // on any env, even before a repo is detected (fresh envs, loading, or
  // clone-target folders). The menu itself handles the no-repo state.
  return (
    <div className="flex items-center gap-1.5 ml-auto shrink-0 cursor-pointer" onClick={onAction}>
      {hasRepo && status!.modified > 0 && (<span className="flex items-center gap-0.5" title={`${status!.modified} modified files`}><svg viewBox="0 0 16 16" className="w-3 h-3 text-amber-400" fill="currentColor"><circle cx="8" cy="8" r="4" /></svg><span className="text-[10px] font-medium text-amber-400 tabular-nums">{status!.modified}</span></span>)}
      {hasRepo && status!.ahead > 0 && (<span className="flex items-center gap-0.5" title={`${status!.ahead} to push`}><svg viewBox="0 0 16 16" className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 12V4M5 7l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" /></svg><span className="text-[10px] font-medium text-blue-400 tabular-nums">{status!.ahead}</span></span>)}
      {hasRepo && status!.behind > 0 && (<span className="flex items-center gap-0.5" title={`${status!.behind} to pull`}><svg viewBox="0 0 16 16" className="w-3 h-3 text-purple-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 4v8M5 9l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" /></svg><span className="text-[10px] font-medium text-purple-400 tabular-nums">{status!.behind}</span></span>)}
      {!hasChanges && (
        <span title={hasRepo ? 'Git actions' : 'Git not yet detected — click to open the menu'}>
          <svg viewBox="0 0 16 16" className={`w-3 h-3 ${hasRepo ? 'text-neutral-500' : 'text-neutral-600/80'}`} fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
        </span>
      )}
    </div>
  )
}

function GitActionsMenu({ envId, status, x, y, onClose, onRefresh, repoUrl, isDeployEnv = false }: { envId: string; status: GitStatusData | null; x: number; y: number; onClose: () => void; onRefresh: () => void; repoUrl: string | null; isDeployEnv?: boolean }) {
  const [loading, setLoading] = useState<string | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [showCommitInput, setShowCommitInput] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // GitHub auth state
  const [authStatus, setAuthStatus] = useState<{ authenticated: boolean; username?: string; ghInstalled: boolean } | null>(null)
  const [authSuccess, setAuthSuccess] = useState(false)

  const selectedTaskId = useAppStore((s) => s.selectedTaskId)
  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const { data: tasks } = useTasks(envId)

  // Check GitHub auth on mount
  useEffect(() => {
    window.electronAPI.git.checkGitHubAuth(envId).then(setAuthStatus).catch(() => {})
  }, [envId])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.git-actions-menu') && !(e.target as HTMLElement).closest('.discard-confirm-dialog')) onClose()
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onClose])

  const handleCommitPush = async () => {
    const msg = commitMsg.trim() || 'Update'
    setLoading('commit-push')
    setError(null)
    try { await window.electronAPI.git.commitPush(envId, msg); onRefresh(); onClose() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setLoading(null)
  }

  const handleFetch = async () => {
    setLoading('fetch')
    setError(null)
    try { await window.electronAPI.git.fetch(envId); onRefresh() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setLoading(null)
  }

  const handlePull = async () => {
    setLoading('pull')
    setError(null)
    try { await window.electronAPI.git.pull(envId); onRefresh(); onClose() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setLoading(null)
  }

  const handleDiscard = async () => {
    setLoading('discard')
    setError(null)
    try { await window.electronAPI.git.discard(envId); onRefresh(); onClose() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setLoading(null)
    setShowDiscardConfirm(false)
  }

  const queryClient = useQueryClient()

  const handleStartAuth = async () => {
    // Use the first task of THIS environment (not the globally selected task)
    const taskId = tasks?.[0]?.id
    if (!taskId) {
      setError('Create a task in this environment first')
      return
    }
    setLoading('auth')
    setError(null)
    try {
      // Install script: download gh binary to ~/.local/bin, add to PATH, then run gh auth login
      const installCmd = authStatus && !authStatus.ghInstalled
        ? 'echo "Installing gh CLI..." && ARCH=$(uname -m) && case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac && VERSION=$(curl -sL https://api.github.com/repos/cli/cli/releases/latest | grep \'"tag_name"\' | head -1 | sed -E \'s/.*"v([^"]+)".*/\\1/\') && mkdir -p ~/.local/bin && curl -sL "https://github.com/cli/cli/releases/download/v${VERSION}/gh_${VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /tmp && cp "/tmp/gh_${VERSION}_linux_${ARCH}/bin/gh" ~/.local/bin/gh && chmod +x ~/.local/bin/gh && rm -rf "/tmp/gh_${VERSION}_linux_${ARCH}" && grep -q "/.local/bin" ~/.bashrc 2>/dev/null || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc && export PATH="$HOME/.local/bin:$PATH" && echo "gh CLI installed!" && '
        : ''
      const agent = await window.electronAPI.agents.spawn(taskId, 'terminal')
      // Switch to the correct task/environment and select the new agent
      selectTask(taskId, envId)
      setActiveAgent(agent.id)
      // Invalidate queries so MainArea picks up the new agent and shows it
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      await queryClient.invalidateQueries({ queryKey: ['agents-all'] })
      // Send the install + auth command to the terminal
      // Use ~/.local/bin/gh as fallback path in case PATH isn't updated yet
      const authCmd = authStatus && !authStatus.ghInstalled
        ? `${installCmd}~/.local/bin/gh auth login\n`
        : 'gh auth login\n'
      setTimeout(() => {
        window.electronAPI.agents.writeStdin(agent.id, authCmd)
      }, 1500)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setLoading(null)
  }

  const notAuthenticated = authStatus && !authStatus.authenticated
  const hasRepo = !!status?.hasRepo

  // No git repo detected in this env's folder yet. Still show a minimal menu
  // so the user can sign in to GitHub (which is prerequisite for cloning /
  // pushing later) and re-check once they've initialized the repo.
  if (!hasRepo || !status) {
    return (
      <>
        <div className="git-actions-menu fixed z-50 bg-neutral-900 border border-neutral-700 rounded-lg py-1 shadow-xl min-w-[220px] max-w-[360px]" style={{ left: x, top: y }}>
          {error && (
            <div className="px-3 py-2 border-b border-red-900 bg-red-950/50 text-[11px] text-red-300">{error}</div>
          )}
          {notAuthenticated && !authSuccess && (
            <div className="px-3 py-2 border-b border-neutral-800">
              <div className="flex items-center gap-1.5 mb-2">
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 1v6M8 11v.5" strokeLinecap="round" /><circle cx="8" cy="8" r="7" /></svg>
                <span className="text-[12px] text-amber-400">Not authenticated on GitHub</span>
              </div>
              <button
                onClick={handleStartAuth}
                disabled={loading === 'auth'}
                className="w-full h-8 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-[12px] text-neutral-200 font-medium transition-colors flex items-center justify-center gap-1.5"
              >
                {loading === 'auth' ? 'Starting…' : 'Authenticate GitHub'}
              </button>
            </div>
          )}
          {authStatus?.authenticated && !authSuccess && (
            <div className="px-3 py-1.5 border-b border-neutral-800">
              <div className="flex items-center gap-1.5 text-[11px] text-green-400">
                <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5L6.5 12L13 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
                GitHub{authStatus.username ? `: ${authStatus.username}` : ' connected'}
              </div>
            </div>
          )}
          <div className="px-3 py-2 text-[12px] text-neutral-400">
            No git repo detected in this environment's folder yet.
          </div>
          <div className="px-1 py-1">
            <div
              className="px-2 h-8 flex items-center cursor-pointer text-[13px] text-neutral-200 hover:bg-neutral-800 rounded transition-colors"
              onClick={() => { onRefresh(); onClose() }}
            >
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-neutral-400" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8a6 6 0 0 1 10.47-4M14 8a6 6 0 0 1-10.47 4" strokeLinecap="round" /><path d="M14 2v4h-4M2 14v-4h4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Re-check
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <div className="git-actions-menu fixed z-50 bg-neutral-900 border border-neutral-700 rounded-lg py-1 shadow-xl min-w-[220px] max-w-[360px]" style={{ left: x, top: y }}>
        {/* Error banner */}
        {error && (
          <div className="px-3 py-2 border-b border-red-900 bg-red-950/50">
            <div className="text-[11px] text-red-400 font-medium mb-0.5">Error</div>
            <div className="text-[11px] text-red-300/80 whitespace-pre-wrap break-words max-h-[80px] overflow-auto">{error}</div>
          </div>
        )}

        {/* Auth success banner */}
        {authSuccess && (
          <div className="px-3 py-2 border-b border-green-900 bg-green-950/50">
            <div className="text-[12px] text-green-400 font-medium flex items-center gap-1.5">
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5L6.5 12L13 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Logged in{authStatus?.username ? ` as ${authStatus.username}` : ''}
            </div>
          </div>
        )}

        {/* GitHub auth status + login button */}
        {notAuthenticated && !authSuccess && (
          <div className="px-3 py-2 border-b border-neutral-800">
            <div className="flex items-center gap-1.5 mb-2">
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 1v6M8 11v.5" strokeLinecap="round" /><circle cx="8" cy="8" r="7" /></svg>
              <span className="text-[12px] text-amber-400">Not authenticated on GitHub</span>
            </div>
            <button
              onClick={handleStartAuth}
              disabled={loading === 'auth'}
              className="w-full h-8 rounded-lg bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-[12px] text-neutral-200 font-medium transition-colors flex items-center justify-center gap-1.5"
            >
              {loading === 'auth' ? (
                <>
                  <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 animate-spin" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" /><path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                  {authStatus?.ghInstalled ? 'Starting...' : 'Installing gh CLI...'}
                </>
              ) : (
                <>
                  <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                  Authenticate GitHub
                </>
              )}
            </button>
          </div>
        )}

        {/* Authenticated badge (inline) */}
        {authStatus?.authenticated && !authSuccess && (
          <div className="px-3 py-1.5 border-b border-neutral-800">
            <div className="flex items-center gap-1.5 text-[11px] text-green-400">
              <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5L6.5 12L13 4" strokeLinecap="round" strokeLinejoin="round" /></svg>
              GitHub{authStatus.username ? `: ${authStatus.username}` : ' connected'}
            </div>
          </div>
        )}

        {/* Status summary */}
        <div className="px-3 py-2 border-b border-neutral-800">
          <div className="text-[11px] text-neutral-500 uppercase tracking-wider mb-1">Git Status</div>
          <div className="flex flex-col gap-0.5 text-[12px]">
            {status.modified > 0 && <span className="text-amber-400">{status.modified} modified files</span>}
            {status.staged > 0 && <span className="text-green-400">{status.staged} staged</span>}
            {status.ahead > 0 && <span className="text-blue-400">{status.ahead} commits to push</span>}
            {status.behind > 0 && <span className="text-purple-400">{status.behind} commits to pull</span>}
          </div>
        </div>

        {/* Fetch — always visible */}
        <div className="px-1 py-1 border-b border-neutral-800">
          <div className="px-2 h-8 flex items-center cursor-pointer text-[13px] text-neutral-200 hover:bg-neutral-800 rounded transition-colors" onClick={handleFetch}>
            {loading === 'fetch' ? (
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 animate-spin" fill="none"><circle cx="8" cy="8" r="6" stroke="#a3a3a3" strokeWidth="2" opacity="0.2" /><path d="M8 2a6 6 0 0 1 6 6" stroke="#a3a3a3" strokeWidth="2" strokeLinecap="round" /></svg>
            ) : (
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-neutral-400" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 8a6 6 0 0 1 10.47-4M14 8a6 6 0 0 1-10.47 4" strokeLinecap="round" /><path d="M14 2v4h-4M2 14v-4h4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            )}
            Fetch
          </div>
        </div>

        {/* Open on GitHub */}
        {repoUrl && (
          <div className="px-1 py-1 border-b border-neutral-800">
            <div className="px-2 h-8 flex items-center cursor-pointer text-[13px] text-neutral-200 hover:bg-neutral-800 rounded transition-colors" onClick={() => { window.open(repoUrl, '_blank'); onClose() }}>
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-neutral-400" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
              Open on GitHub
            </div>
          </div>
        )}

        {/* Commit & Push */}
        {status.modified > 0 && (
          <div className="px-1 py-1">
            {showCommitInput ? (
              <div className="px-2 py-1 flex flex-col gap-1.5">
                <input autoFocus type="text" value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCommitPush() }}
                  placeholder="Commit message..."
                  className="w-full h-7 rounded bg-black border border-neutral-700 px-2 text-[12px] text-neutral-50 outline-none focus:border-neutral-500" />
                <button onClick={handleCommitPush} disabled={loading === 'commit-push'}
                  className="w-full h-7 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-[12px] text-white font-medium transition-colors">
                  {loading === 'commit-push' ? 'Pushing...' : 'Commit & Push'}
                </button>
              </div>
            ) : (
              <div className="px-2 h-8 flex items-center cursor-pointer text-[13px] text-neutral-200 hover:bg-neutral-800 rounded transition-colors" onClick={() => {
                setShowCommitInput(true)
                // Pre-populate commit message with diff summary
                window.electronAPI.git.diffSummary(envId).then((summary: string) => {
                  if (summary) setCommitMsg(summary)
                }).catch(() => {})
              }}>
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 12V4M5 7l3-3 3 3" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Commit & Push
              </div>
            )}
          </div>
        )}

        {/* Cancel Edits */}
        {status.modified > 0 && (
          <div className="px-1 py-1">
            <div className="px-2 h-8 flex items-center cursor-pointer text-[13px] text-red-400 hover:bg-red-950/40 rounded transition-colors"
              onClick={() => setShowDiscardConfirm(true)}>
              <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
              Cancel Edits
            </div>
          </div>
        )}

        {/* Pull — not on deploy envs. Deploy envs pull as part of the
         *  "Deploy now" pipeline, so exposing a separate Pull Changes here
         *  would let the user do a half-deploy (pull without the pre/post
         *  steps) and leave the remote in a weirdly partial state. */}
        {!isDeployEnv && status.behind > 0 && (
          <div className="px-1 py-1">
            <div className="px-2 h-8 flex items-center cursor-pointer text-[13px] text-neutral-200 hover:bg-neutral-800 rounded transition-colors" onClick={handlePull}>
              {loading === 'pull' ? (
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 animate-spin" fill="none"><circle cx="8" cy="8" r="6" stroke="#a855f7" strokeWidth="2" opacity="0.2" /><path d="M8 2a6 6 0 0 1 6 6" stroke="#a855f7" strokeWidth="2" strokeLinecap="round" /></svg>
              ) : (
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-purple-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 4v8M5 9l3 3 3-3" strokeLinecap="round" strokeLinejoin="round" /></svg>
              )}
              Pull Changes
            </div>
          </div>
        )}
        {isDeployEnv && status.behind > 0 && (
          <div className="px-3 py-2 text-[11px] text-neutral-500 italic border-t border-neutral-800">
            Use "Deploy now" to pull + run the pipeline atomically.
          </div>
        )}
      </div>

      {/* Discard confirmation dialog */}
      {showDiscardConfirm && (
        <div className="discard-confirm-dialog fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={() => setShowDiscardConfirm(false)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[400px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-3">
              <svg viewBox="0 0 20 20" className="w-5 h-5 text-red-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M10 2L2 18h16L10 2z" strokeLinejoin="round" />
                <path d="M10 8v4M10 14.5v.5" strokeLinecap="round" />
              </svg>
              <div className="text-[15px] font-semibold text-neutral-50">Discard All Changes</div>
            </div>
            <p className="text-[13px] text-neutral-400 mb-1">
              This will permanently discard all uncommitted changes in this environment:
            </p>
            <ul className="text-[13px] text-neutral-400 mb-4 list-disc pl-5 space-y-0.5">
              <li>All modified files will be reverted</li>
              <li>All untracked files will be deleted</li>
              <li>This action <span className="text-red-400 font-medium">cannot be undone</span></li>
            </ul>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDiscardConfirm(false)}
                className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors">
                Keep Changes
              </button>
              <button onClick={handleDiscard} disabled={loading === 'discard'}
                className="h-8 px-4 rounded-lg text-[13px] text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-colors">
                {loading === 'discard' ? 'Discarding...' : 'Discard All Changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function ConnectionDot({ envId }: { envId: string }) {
  const status = useConnectionStore((s) => s.statuses.get(envId))
  const error = useConnectionStore((s) => s.errors.get(envId))
  if (!status || status === 'disconnected') return null
  const colors: Record<string, string> = { connecting: 'bg-yellow-500 animate-pulse', connected: 'bg-emerald-500', error: 'bg-red-500' }
  const labels: Record<string, string> = { connecting: 'Connecting...', connected: 'Connected', error: error || 'Connection failed' }
  return <span className={`w-2 h-2 rounded-full shrink-0 ml-1.5 ${colors[status] || ''}`} title={labels[status] || status} />
}

/* Aggregated open-issue count for the apps hosted by a stack's envs. Uses
 * the shared React Query cache key — 'issues-open-counts' — so Reverb
 * invalidations from sync-store (issue.created / issue.regression /
 * issue-status-changed via invalidate-all-issues) refresh the badge live.
 * The previous implementation used setInterval(30s) and ignored invalidations,
 * which is why resolving or creating an issue didn't update the sidebar. */
function useStackOpenIssueCount(projectId: string, stackId: string): number | null {
  const { data: apps = [] } = useApps(projectId)
  const { data: envs = [] } = useEnvironments(projectId)
  const appIds = useMemo(() => {
    const envIdsInStack = new Set(envs.filter((e) => e.stack_id === stackId).map((e) => e.id))
    return apps
      .filter((a) => a.environment_id && envIdsInStack.has(a.environment_id))
      .map((a) => a.id)
      .sort()
  }, [apps, envs, stackId])
  const { data: counts } = useOpenIssueCounts(appIds)
  if (appIds.length === 0) return 0
  if (!counts) return null
  return Object.values(counts).reduce((a, b) => a + (b || 0), 0)
}

/* ============ Pinned tab shortcuts (sidebar shortcuts to env/stack tabs) ============
 * A pinned tab surfaces in the sidebar under its env/stack. Sessions is
 * default-pinned on every operational env (Terminals on deploy envs);
 * stacks ship with no defaults. Everything below is driven by app-store
 * `pinOrder: Record<containerKey, tabKey[]>` with the `effectivePins` helper
 * overlaying defaults on untouched containers.
 *
 * The meta maps mirror the tabs defined in EnvTabsView / StackTabsView — if
 * a tab is renamed or removed there, update these too. Stale keys render
 * defensively (the row is skipped) so nothing can blow up. */
const ENV_TAB_META: Partial<Record<EnvTabKey, { label: string; icon: React.ReactNode }>> = {
  sessions: { label: 'Sessions', icon: <TerminalIcon size={12} /> },
  files: { label: 'Files', icon: <Folder size={12} /> },
  routines: { label: 'Routines', icon: <TimerIcon size={12} /> },
  github: { label: 'GitHub', icon: <LogoGithub size={12} /> },
  deploy: { label: 'Deploy', icon: <CloudUpload size={12} /> },
  terminals: { label: 'Terminals', icon: <TerminalIcon size={12} /> },
}
const STACK_TAB_META: Partial<Record<StackTabKey, { label: string; icon: React.ReactNode }>> = {
  overview: { label: 'Overview', icon: <DashboardIcon size={12} /> },
  issues: { label: 'Issues', icon: <Debug size={12} /> },
  tasks: { label: 'Tasks', icon: <TaskIconCarbon size={12} /> },
}

/* ---- Pinned row skeleton ----------------------------------------------
 * One row in the sidebar representing a single pinned tab. Handles:
 *   - chevron for expandable pins + collapse state
 *   - label with optional inline rename (double-click)
 *   - right-side badge + always-visible pin (unpin) button
 *   - HTML5 drag-to-reorder within the same container
 *   - right-click context menu (Unpin / Rename / Move / Collapse-Expand)
 * Domain-specific children (agents for Sessions, routines list, etc.) are
 * passed in via the `children` render prop, invoked only when expanded. */
interface PinnedRowProps {
  containerKey: string
  containerId: string
  kind: 'env' | 'stack'
  tabKey: string
  index: number
  siblings: string[]
  defaults: string[]
  label: string
  icon: React.ReactNode
  expandable: boolean
  isActive: boolean
  onActivate: () => void
  badge?: React.ReactNode
  children?: () => React.ReactNode
  setContextMenu: (menu: ContextMenuState) => void
}

function PinnedRow({
  containerKey,
  containerId,
  kind,
  tabKey,
  index,
  siblings,
  defaults,
  label,
  icon,
  expandable,
  isActive,
  onActivate,
  badge,
  children,
  setContextMenu,
}: PinnedRowProps) {
  const pinKey = makePinKey(kind, containerId, tabKey)
  const collapsedPins = useAppStore((s) => s.collapsedPins)
  const togglePinCollapsed = useAppStore((s) => s.togglePinCollapsed)
  const setPinOrder = useAppStore((s) => s.setPinOrder)
  const togglePin = useAppStore((s) => s.togglePin)
  const pinLabels = useAppStore((s) => s.pinLabels)
  const setPinLabel = useAppStore((s) => s.setPinLabel)
  const pushToast = useToastStore((s) => s.push)

  const expanded = expandable && !collapsedPins.has(pinKey)
  const displayLabel = pinLabels[pinKey] ?? label

  const [renaming, setRenaming] = useState(false)
  const [draftLabel, setDraftLabel] = useState(displayLabel)
  const [dragOver, setDragOver] = useState<'above' | 'below' | null>(null)

  const unpin = (): void => {
    const wasDefault = defaults.includes(tabKey)
    const priorOrder = [...siblings]
    togglePin(containerKey, tabKey, defaults)
    if (wasDefault) {
      pushToast({
        message: `Unpinned ${displayLabel} from the sidebar`,
        action: {
          label: 'Undo',
          onClick: () => setPinOrder(containerKey, priorOrder),
        },
      })
    }
  }

  const moveBy = (delta: -1 | 1): void => {
    const j = index + delta
    if (j < 0 || j >= siblings.length) return
    const next = [...siblings]
    ;[next[index], next[j]] = [next[j], next[index]]
    setPinOrder(containerKey, next)
  }

  const openContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuState['items'] = [
      { label: renaming ? 'Cancel rename' : 'Rename', onClick: () => setRenaming((v) => !v) },
      ...(expandable
        ? [{ label: expanded ? 'Collapse' : 'Expand', onClick: () => togglePinCollapsed(pinKey) }]
        : []),
      ...(index > 0 ? [{ label: 'Move up', onClick: () => moveBy(-1) }] : []),
      ...(index < siblings.length - 1 ? [{ label: 'Move down', onClick: () => moveBy(1) }] : []),
      { label: 'Unpin', onClick: unpin },
    ]
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }

  const commitRename = (): void => {
    const next = draftLabel.trim()
    if (next && next !== label) setPinLabel(pinKey, next)
    else if (!next || next === label) setPinLabel(pinKey, null) // back to default
    setRenaming(false)
  }
  const cancelRename = (): void => {
    setDraftLabel(displayLabel)
    setRenaming(false)
  }

  return (
    <>
      <div
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(
            'application/x-alby-pin',
            JSON.stringify({ containerKey, tabKey, index }),
          )
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-alby-pin')) {
            e.preventDefault()
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            const upper = e.clientY - rect.top < rect.height / 2
            setDragOver(upper ? 'above' : 'below')
          }
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData('application/x-alby-pin')
          setDragOver(null)
          if (!raw) return
          let parsed: { containerKey: string; tabKey: string; index: number } | null = null
          try { parsed = JSON.parse(raw) } catch { return }
          if (!parsed || parsed.containerKey !== containerKey) return
          if (parsed.tabKey === tabKey) return // same row
          const next = siblings.filter((k) => k !== parsed!.tabKey)
          // re-anchor insertion index in the filtered array
          const targetIdx = next.indexOf(tabKey)
          const insertAt = dragOver === 'below' ? targetIdx + 1 : targetIdx
          next.splice(insertAt, 0, parsed.tabKey)
          setPinOrder(containerKey, next)
        }}
        onContextMenu={openContextMenu}
        className={`group relative flex items-center rounded-lg transition-colors ${
          // Stack-level pins (Issues / Tasks) live as siblings of the env
          // rows, so they match the env header's height / font size / left
          // inset. Env-level pins (Sessions / Files / Routines) sit inside
          // an expanded env and stay smaller + deeper-indented.
          kind === 'stack'
            ? 'h-9 px-2 text-[13px]'
            : 'h-8 pl-10 pr-2 text-[12px]'
        } ${isActive ? 'bg-neutral-800/60' : 'hover:bg-neutral-800/30'} ${
          renaming ? '' : 'cursor-pointer'
        }`}
        onClick={renaming ? undefined : onActivate}
      >
        {dragOver === 'above' && <div className={`absolute ${kind === 'stack' ? 'left-2' : 'left-8'} right-2 top-0 h-[2px] bg-blue-500 rounded pointer-events-none`} />}
        {dragOver === 'below' && <div className={`absolute ${kind === 'stack' ? 'left-2' : 'left-8'} right-2 bottom-0 h-[2px] bg-blue-500 rounded pointer-events-none`} />}
        {expandable ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              togglePinCollapsed(pinKey)
            }}
            className={`shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-700/60 ${
              kind === 'env' ? '-ml-6 mr-1' : ''
            }`}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <ChevronDownIcon
              size={kind === 'stack' ? 12 : 10}
              className="text-neutral-400"
              style={{
                transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                transition: 'transform 0.15s',
              }}
            />
          </button>
        ) : null}
        {/* For leaf stack pins (Issues, Tasks) the icon takes the chevron
         *  slot so the row lines up with the env header's chevron column.
         *  For env pins the chevron is already in that slot (pulled into
         *  the pl-10 padding via -ml-6), so the icon sits after it. */}
        {kind === 'stack' && !expandable ? (
          <span className="shrink-0 w-5 h-5 flex items-center justify-center text-neutral-400">
            {icon}
          </span>
        ) : (
          <span className="shrink-0 text-neutral-400">{icon}</span>
        )}
        {renaming ? (
          <input
            autoFocus
            type="text"
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
            }}
            onClick={(e) => e.stopPropagation()}
            className="ml-2 flex-1 h-6 bg-neutral-950 text-neutral-50 rounded px-2 border border-neutral-700 focus:outline-none focus:border-blue-500"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation()
              setDraftLabel(displayLabel)
              setRenaming(true)
            }}
            className={`ml-2 truncate flex-1 select-none ${isActive ? 'text-neutral-50 font-medium' : kind === 'stack' ? 'text-neutral-200' : 'text-neutral-300'}`}
            title={`${displayLabel} — double-click to rename, right-click for more`}
          >
            {displayLabel}
          </span>
        )}
        {kind === 'env' && (
          <PinUnreadDot
            envId={containerId}
            pinKey={tabKey as EnvPinKey}
            // When the pin is expanded the user sees the SessionRow /
            // RoutineSidebarRow dots directly — hide the rollup dot so we
            // don't double-up.
            hideWhenExpanded={!!(expandable && expanded)}
          />
        )}
        {kind === 'stack' && <StackPinUnreadDot stackId={containerId} pinKey={tabKey as StackPinKey} />}
        {!expanded && badge && <span className="ml-2 shrink-0">{badge}</span>}
        {/* No always-visible unpin button — too easy to fat-finger. Unpin is
            available via right-click → Unpin + via the pin icon in the tab
            bar itself (EnvTabsView / StackTabsView). */}
      </div>
      {expandable && expanded && children && children()}
    </>
  )
}

/* ---- Subtree renderers (what lives under an expanded pin) ---------------- */

function SessionsSubTree({
  envId,
  agentsByTask,
  filter,
  setContextMenu,
}: {
  envId: string
  agentsByTask: Map<string, Agent[]>
  filter?: 'plain'
  setContextMenu: (menu: ContextMenuState) => void
}) {
  const { data: tasks } = useTasks(envId)
  const selectedTaskId = useAppStore((s) => s.selectedTaskId)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const spawnAgent = useSpawnAgent()
  const envAgents = useEnvAgents(tasks, agentsByTask)
  const reorderAgents = useReorderAgents()
  const deleteAgent = useDeleteAgent()
  const killAgent = useKillAgent()
  const sorted = useMemo(() => {
    const arr = filter === 'plain'
      ? envAgents.filter((a) => (a.tab_name?.split(' ')[0] || 'terminal').toLowerCase() === 'terminal')
      : [...envAgents]
    // Honour sort_order the user set via drag or context-menu Move up/down.
    // Falls back to created_at when two rows somehow share the same
    // sort_order (migration race, concurrent inserts from cloud sync).
    arr.sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      return (a.created_at || '').localeCompare(b.created_at || '')
    })
    return arr
  }, [envAgents, filter])

  const allIds = useMemo(() => sorted.map((a) => a.id), [sorted])

  const handleReorder = useCallback(
    (orderedIds: string[]) => {
      reorderAgents.mutate(orderedIds)
    },
    [reorderAgents],
  )

  const moveBy = useCallback(
    (idx: number, delta: number) => {
      const j = idx + delta
      if (j < 0 || j >= allIds.length) return
      const next = [...allIds]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      handleReorder(next)
    },
    [allIds, handleReorder],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, agent: Agent, index: number, total: number) => {
      e.preventDefault()
      e.stopPropagation()
      const items: ContextMenuState['items'] = []
      if (index > 0) items.push({ label: 'Move up', onClick: () => moveBy(index, -1) })
      if (index < total - 1) items.push({ label: 'Move down', onClick: () => moveBy(index, 1) })
      const isRunning = agent.status === 'running'
      items.push({
        label: isRunning ? 'Kill & delete' : 'Delete',
        onClick: () => {
          if (isRunning) killAgent.mutate(agent.id)
          deleteAgent.mutate(agent.id)
          if (activeAgentId === agent.id) setActiveAgent(null)
        },
      })
      setContextMenu({ x: e.clientX, y: e.clientY, items })
    },
    [moveBy, killAgent, deleteAgent, activeAgentId, setActiveAgent, setContextMenu],
  )
  if (sorted.length === 0) {
    const launchTerminal = async (): Promise<void> => {
      // Resolve (or create) the env's "general" default task, then spawn a
      // plain terminal there. Matches what SessionsTab.launch does inside
      // EnvTabsView so the behaviour is identical whether you launch from
      // the sidebar placeholder or the env page.
      try {
        let list = (await window.electronAPI.tasks.list(envId)) as Array<{
          id: string
          is_default?: 0 | 1
        }>
        let general = list.find((t) => t.is_default === 1)
        if (!general) {
          general = (await window.electronAPI.tasks.create({
            environment_id: envId,
            title: 'general',
          })) as { id: string; is_default?: 0 | 1 }
          list = [...list, general]
        }
        spawnAgent.mutate(
          { taskId: general.id, agentType: 'terminal', autoInstall: false },
          {
            onSuccess: (agent) => {
              selectTask(general!.id, envId)
              setActiveAgent(agent.id)
            },
          },
        )
      } catch (err) {
        console.error('[SessionsSubTree] launch terminal failed', err)
      }
    }
    return (
      <div
        className="pl-14 pr-2 h-7 flex items-center text-[11px] text-neutral-500 hover:text-neutral-300 cursor-pointer"
        onClick={() => { void launchTerminal() }}
        title="Launch a terminal session in this env"
      >
        {spawnAgent.isPending ? 'Launching…' : 'No sessions — launch one'}
      </div>
    )
  }
  return (
    <>
      {sorted.map((agent, i) => (
        <SessionRow
          key={agent.id}
          agent={agent}
          task={tasks?.find((t) => t.id === agent.task_id)}
          envId={envId}
          isSelected={selectedTaskId === agent.task_id && activeAgentId === agent.id}
          index={i}
          total={sorted.length}
          allAgentIds={allIds}
          onReorder={handleReorder}
          onContextMenu={handleContextMenu}
        />
      ))}
    </>
  )
}

const ROUTINE_DND_MIME = 'application/x-alby-routine'

function RoutineSidebarRow({
  routine,
  envId,
  isSelected,
  index,
  total,
  allIds,
  onReorder,
  onContextMenu,
}: {
  routine: Routine
  envId: string
  isSelected: boolean
  index: number
  total: number
  allIds: string[]
  onReorder: (orderedIds: string[]) => void
  onContextMenu: (e: React.MouseEvent, r: Routine, index: number, total: number) => void
}) {
  const selectRoutine = useAppStore((s) => s.selectRoutine)
  const start = useStartRoutine()
  const stop = useStopRoutine()
  const [dragOver, setDragOver] = useState<'above' | 'below' | null>(null)
  const viewers = usePresenceFor('routine', routine.id)
  const running = !!routine.tmux_session_name
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(ROUTINE_DND_MIME, routine.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ROUTINE_DND_MIME)) return
        e.preventDefault()
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const upper = e.clientY - rect.top < rect.height / 2
        setDragOver(upper ? 'above' : 'below')
      }}
      onDragLeave={() => setDragOver(null)}
      onDrop={(e) => {
        const srcId = e.dataTransfer.getData(ROUTINE_DND_MIME)
        const where = dragOver
        setDragOver(null)
        if (!srcId || srcId === routine.id) return
        const next = allIds.filter((id) => id !== srcId)
        const targetIdx = next.indexOf(routine.id)
        if (targetIdx < 0) return
        const insertAt = where === 'below' ? targetIdx + 1 : targetIdx
        next.splice(insertAt, 0, srcId)
        onReorder(next)
      }}
      onContextMenu={(e) => onContextMenu(e, routine, index, total)}
      className={`relative group flex items-center h-8 pl-14 pr-2 rounded-lg cursor-pointer transition-colors ${
        isSelected ? 'bg-neutral-800/60' : 'hover:bg-neutral-800/30'
      }`}
      onClick={() => selectRoutine(routine.id, envId)}
    >
      {dragOver === 'above' && (
        <div className="absolute left-10 right-2 top-0 h-[2px] bg-blue-500 rounded pointer-events-none" />
      )}
      {dragOver === 'below' && (
        <div className="absolute left-10 right-2 bottom-0 h-[2px] bg-blue-500 rounded pointer-events-none" />
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (running) stop.mutate(routine.id)
          else start.mutate(routine.id)
        }}
        className={`shrink-0 w-5 h-5 flex items-center justify-center rounded ${
          running ? 'text-red-400 hover:bg-red-900/30' : 'text-emerald-400 hover:bg-emerald-900/30'
        }`}
        title={running ? 'Stop' : 'Start'}
      >
        {running ? <Stop size={10} /> : <Play size={10} />}
      </button>
      <span className="ml-2 text-[12px] text-neutral-200 truncate flex-1">{routine.name}</span>
      <span className="ml-2 shrink-0 flex items-center">
        <RoutineUnreadDot routineId={routine.id} />
      </span>
      {viewers.length > 0 && (
        <span className="ml-2"><AvatarStack users={viewers} /></span>
      )}
      <span
        className={`ml-2 shrink-0 text-[10px] uppercase tracking-wider ${running ? 'text-emerald-300' : 'text-neutral-500'}`}
      >
        {running ? 'run' : 'idle'}
      </span>
    </div>
  )
}

function RoutinesSubTree({ envId, setContextMenu }: { envId: string; setContextMenu: (menu: ContextMenuState) => void }) {
  const { data: routines = [] } = useRoutines(envId)
  const selectedRoutineId = useAppStore((s) => s.selectedRoutineId)
  const reorder = useReorderRoutines()
  const deleteRoutine = useDeleteRoutine()
  const stop = useStopRoutine()
  const allIds = useMemo(() => routines.map((r) => r.id), [routines])

  const handleReorder = useCallback(
    (orderedIds: string[]) => { reorder.mutate({ envId, orderedIds }) },
    [reorder, envId],
  )

  const moveBy = useCallback(
    (idx: number, delta: number) => {
      const j = idx + delta
      if (j < 0 || j >= allIds.length) return
      const next = [...allIds]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      handleReorder(next)
    },
    [allIds, handleReorder],
  )

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, r: Routine, index: number, total: number) => {
      e.preventDefault()
      e.stopPropagation()
      const items: ContextMenuState['items'] = []
      if (index > 0) items.push({ label: 'Move up', onClick: () => moveBy(index, -1) })
      if (index < total - 1) items.push({ label: 'Move down', onClick: () => moveBy(index, 1) })
      const running = !!r.tmux_session_name
      items.push({
        label: running ? 'Stop & delete' : 'Delete',
        onClick: () => {
          if (running) stop.mutate(r.id)
          deleteRoutine.mutate(r.id)
        },
      })
      setContextMenu({ x: e.clientX, y: e.clientY, items })
    },
    [moveBy, stop, deleteRoutine, setContextMenu],
  )

  if (routines.length === 0) {
    return (
      <div className="pl-14 pr-2 h-7 flex items-center text-[11px] text-neutral-500">
        No routines yet.
      </div>
    )
  }
  return (
    <>
      {routines.map((r, i) => (
        <RoutineSidebarRow
          key={r.id}
          routine={r}
          envId={envId}
          isSelected={selectedRoutineId === r.id}
          index={i}
          total={routines.length}
          allIds={allIds}
          onReorder={handleReorder}
          onContextMenu={handleContextMenu}
        />
      ))}
    </>
  )
}

function FilesSubTree() {
  return (
    <div className="pl-14 pr-2 h-7 flex items-center text-[11px] text-neutral-500">
      File browser — coming soon.
    </div>
  )
}

/* ---- Collapsed-pin badges ---------------------------------------------- */

/** Compact badge for a collapsed Sessions-style pin: count + pulse. */
function SessionBadge({ agents }: { agents: Agent[] }) {
  const activities = useActivityStore((s) => s.activities)
  const running = agents.filter((a) => a.status === 'running')
  const errored = agents.filter((a) => a.status === 'error')
  const working = running.some((a) => activities.get(a.id) === 'working')
  if (running.length === 0 && errored.length === 0) return null
  return (
    <span className="flex items-center gap-1">
      {running.length > 0 && (
        <span className="flex items-center gap-1">
          {working ? (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500/70" />
          )}
          <span className="text-[11px] font-medium text-blue-400 tabular-nums">
            {running.length}
          </span>
        </span>
      )}
      {errored.length > 0 && (
        <span className="text-[11px] font-medium text-red-400 tabular-nums">
          {errored.length}
        </span>
      )}
    </span>
  )
}

function IssuesBadge({ projectId, stackId }: { projectId: string; stackId: string }) {
  const count = useStackOpenIssueCount(projectId, stackId)
  if (count == null || count === 0) return null
  return (
    <span
      className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded bg-red-500/20 text-red-300 text-[10px] font-medium tabular-nums"
      title={`${count} open issue${count === 1 ? '' : 's'}`}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}

function RoutineBadge({ envId }: { envId: string }) {
  const { data: routines = [] } = useRoutines(envId)
  if (routines.length === 0) return null
  const running = routines.filter((r) => !!r.tmux_session_name).length
  return (
    <span className="text-[11px] font-medium text-neutral-400 tabular-nums">
      {running > 0 ? (
        <>
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block mr-1" />
          <span className="text-emerald-300">{running}</span>
          <span className="text-neutral-500">/{routines.length}</span>
        </>
      ) : (
        <>
          <span className="text-neutral-500">{routines.length}</span>
        </>
      )}
    </span>
  )
}

/* Sidebar node for a single environment.
 *
 * Behavior:
 * - Operational env: the row is chevron-expandable. Expanded, it shows the
 *   env's active Sessions (agents) as direct children. Clicking the env
 *   NAME selects the env so MainArea renders EnvTabsView (Overview etc.).
 * - Deploy env: leaf row with a fuchsia square marker. No children — click
 *   selects the env so MainArea renders EnvTabsView (Deploy/Terminals/Settings).
 *
 * Operational envs auto-expand when they have running sessions so the user
 * never has to hunt for what's alive. Manual collapse is persisted in the
 * store. */
function EnvironmentGroup({
  environment,
  agentsByTask,
  search,
  onContextMenu,
  setContextMenu,
  isDragOver,
  onEnvDragStart,
  onEnvDragOver,
  onEnvDrop,
  onEnvDragEnd,
}: {
  environment: Environment
  agentsByTask: Map<string, Agent[]>
  search: string
  onContextMenu: (e: React.MouseEvent, env: Environment) => void
  setContextMenu: (menu: ContextMenuState) => void
  isDragOver?: boolean
  onEnvDragStart?: (e: React.DragEvent) => void
  onEnvDragOver?: (e: React.DragEvent) => void
  onEnvDrop?: (e: React.DragEvent) => void
  onEnvDragEnd?: () => void
}) {
  const envId = environment.id,
    envName = environment.name
  const { data: tasks } = useTasks(envId)
  const selectedTaskId = useAppStore((s) => s.selectedTaskId)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const selectedEnvironmentId = useAppStore((s) => s.selectedEnvironmentId)
  const selectEnvironment = useAppStore((s) => s.selectEnvironment)
  const envExpandedOverride = useAppStore((s) => s.envExpandedOverride)
  const toggleEnvironmentExpanded = useAppStore((s) => s.toggleEnvironmentExpanded)
  const { status: gitStatus, refresh: refreshGit } = useGitStatus(envId)
  const [gitMenu, setGitMenu] = useState<{ x: number; y: number } | null>(null)
  const [repoUrl, setRepoUrl] = useState<string | null>(environment.git_remote_url || null)
  const openGitMenu = (e: React.MouseEvent) => {
    e.stopPropagation()
    // Always open, even when the git status hasn't resolved yet or there's
    // no repo — the menu shows a sensible empty state so the user can still
    // reach "Authenticate GitHub" or "Clone…" without waiting.
    setGitMenu({ x: e.clientX, y: e.clientY })
    if (!repoUrl)
      window.electronAPI.git
        .remoteUrl(envId)
        .then((url: string | null) => {
          if (url) setRepoUrl(url)
        })
        .catch(() => {})
  }
  const isDeployEnv = environment.role === 'deploy'
  const envAgents = useEnvAgents(tasks, agentsByTask)
  const hasRunning = envAgents.some((a) => a.status === 'running')
  const pinOrder = useAppStore((s) => s.pinOrder)
  const envTabs = useAppStore((s) => s.envTabs)
  const setEnvTab = useAppStore((s) => s.setEnvTab)
  const containerKey = containerKeyForEnv(envId)
  const defaults = defaultPinsForEnv(environment)
  const pinned = effectivePins(pinOrder, containerKey, defaults) as EnvTabKey[]

  // Auto-expansion: operational envs with at least one running session are
  // shown expanded by default. The user's explicit override (if present)
  // takes precedence so a manually-collapsed env stays collapsed even when
  // a new session spawns inside it. Search always expands, for discovery.
  const baseExpanded = !isDeployEnv && hasRunning
  const override = envExpandedOverride[envId]
  const isExpanded = (override ?? baseExpanded) || !!search.trim()

  const isSelectedAsEnv = selectedEnvironmentId === envId && !selectedTaskId

  const gitMenuEl = gitMenu ? (
    <GitActionsMenu
      envId={envId}
      status={gitStatus}
      x={gitMenu.x}
      y={gitMenu.y}
      onClose={() => setGitMenu(null)}
      onRefresh={refreshGit}
      repoUrl={repoUrl}
      isDeployEnv={isDeployEnv}
    />
  ) : null

  // Click semantics: chevron toggles the subtree, the NAME area selects the
  // env (MainArea → EnvTabsView). Deploy envs used to be leaves — we now
  // give them the same pinned-tab machinery (they get a Terminals default
  // pin) so the UX is uniform.
  const envHeader = (
    <div
      draggable={!!onEnvDragStart}
      onDragStart={onEnvDragStart}
      onDragOver={onEnvDragOver}
      onDrop={onEnvDrop}
      onDragEnd={onEnvDragEnd}
      className={`group relative flex items-center h-9 px-2 ${onEnvDragStart ? 'cursor-grab active:cursor-grabbing' : ''} rounded-lg transition-colors ${isDragOver ? 'border-t-2 border-blue-500' : ''} ${
        isSelectedAsEnv ? 'bg-neutral-800/60' : 'hover:bg-neutral-800/30'
      }`}
      onContextMenu={(e) => onContextMenu(e, environment)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          toggleEnvironmentExpanded(envId, isExpanded)
        }}
        className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-700/60"
        aria-label={isExpanded ? 'Collapse' : 'Expand'}
      >
        <ChevronDownIcon
          size={12}
          className="text-neutral-400"
          style={{
            transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 0.2s',
          }}
        />
      </button>
      <div
        className="flex items-center min-w-0 flex-1 cursor-pointer"
        onClick={(e) => {
          e.stopPropagation()
          selectEnvironment(envId)
        }}
      >
        <span
          className={`text-[13px] truncate ${isSelectedAsEnv ? 'text-neutral-50 font-medium' : 'text-neutral-200'}`}
        >
          {envName}
        </span>
        <ConnectionDot envId={envId} />
        <EnvUnreadDot envId={envId} hideWhenExpanded={isExpanded} />
        {!isExpanded && <AgentBadge agents={envAgents} />}
      </div>
      {/* Git status icons sit just LEFT of the role badge, with their own
       *  horizontal breathing room. The badge itself is the rightmost element,
       *  so "Operational" / "Deploy" is always flush with the row edge. */}
      <div className="ml-auto pl-2 pr-1 flex items-center">
        <GitBadges status={gitStatus} onAction={openGitMenu} />
      </div>
      <span
        className={`shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
          isDeployEnv
            ? 'text-fuchsia-300 bg-fuchsia-500/10 border-fuchsia-500/25'
            : 'text-blue-300 bg-blue-500/10 border-blue-500/25'
        }`}
        title={isDeployEnv ? 'Deploy target' : 'Operational environment'}
      >
        {isDeployEnv ? 'Deploy' : 'Operational'}
      </span>
    </div>
  )

  // Chevron state is now honored uniformly for both operational + deploy
  // envs. Deploy envs just default to collapsed (no running sessions to
  // surface) and pop open when the user clicks the chevron.
  const showPins = isExpanded

  if (!showPins) {
    return (
      <div className="flex flex-col w-full">
        {envHeader}
        {gitMenuEl}
      </div>
    )
  }

  return (
    <div className="flex flex-col w-full">
      {envHeader}
      {gitMenuEl}
      {pinned.map((tabKey, idx) => {
        const meta = ENV_TAB_META[tabKey]
        if (!meta) return null
        const pKey = makePinKey('env', envId, tabKey)
        const isActive =
          selectedEnvironmentId === envId &&
          !selectedTaskId &&
          envTabs[envId] === tabKey
        const expandable = EXPANDABLE_ENV_TABS.has(tabKey)
        const children = expandable
          ? (): React.ReactNode => {
              if (tabKey === 'sessions') {
                return <SessionsSubTree envId={envId} agentsByTask={agentsByTask} setContextMenu={setContextMenu} />
              }
              if (tabKey === 'terminals') {
                return (
                  <SessionsSubTree envId={envId} agentsByTask={agentsByTask} filter="plain" setContextMenu={setContextMenu} />
                )
              }
              if (tabKey === 'routines') {
                return <RoutinesSubTree envId={envId} setContextMenu={setContextMenu} />
              }
              if (tabKey === 'files') {
                return <FilesSubTree />
              }
              return null
            }
          : undefined
        const badge =
          tabKey === 'sessions' || tabKey === 'terminals' ? (
            <SessionBadge agents={envAgents} />
          ) : tabKey === 'routines' ? (
            <RoutineBadge envId={envId} />
          ) : null
        return (
          <PinnedRow
            key={pKey}
            containerKey={containerKey}
            containerId={envId}
            kind="env"
            tabKey={tabKey}
            index={idx}
            siblings={pinned}
            defaults={defaults}
            label={meta.label}
            icon={meta.icon}
            expandable={expandable}
            isActive={isActive}
            onActivate={() => {
              selectEnvironment(envId)
              setEnvTab(envId, tabKey)
            }}
            badge={badge}
            children={children}
            setContextMenu={setContextMenu}
          />
        )
      })}
    </div>
  )
}

/* Stack group — collapsible sidebar node for a single codebase in a project.
 * Two interactions on the row:
 *   - Chevron button → toggle the subtree (show/hide envs).
 *   - Name area click → selectStack(stack.id), which routes the MainArea to
 *     StackTabsView (Overview · Issues · Tasks · Settings).
 * Inline badges on the row surface the aggregated state of stack-level
 * content: open issue count (red) and open task count (neutral). */
function StackGroup({
  projectId,
  stack,
  environments,
  renderEnv,
  onStackContextMenu,
  onAddEnvironment,
  setContextMenu,
  onEnvDropOnStack,
  onStackDragStart,
  onStackDrop,
}: {
  projectId: string
  stack: Stack
  environments: Environment[]
  renderEnv: (env: Environment) => React.ReactNode
  onStackContextMenu: (e: React.MouseEvent, stack: Stack) => void
  onAddEnvironment: (stackId: string) => void
  setContextMenu: (menu: ContextMenuState) => void
  onEnvDropOnStack: (fromEnvId: string, stackId: string, beforeEnvId: string | null) => void
  /** Start-of-drag — set the dragged stack id on the dataTransfer so other
   *  stack headers can identify a stack-reorder drop and separate it from the
   *  env-drop case (which uses `text/env-id`). */
  onStackDragStart: (e: React.DragEvent, stackId: string) => void
  /** Drop a stack onto this stack header → reorder. Caller decides whether
   *  the source goes above or below based on mouse Y within the target. */
  onStackDrop: (fromStackId: string, targetStackId: string, position: 'above' | 'below') => void
}) {
  const expandedStacks = useAppStore((s) => s.expandedStacks)
  const toggleStackExpanded = useAppStore((s) => s.toggleStackExpanded)
  const selectStack = useAppStore((s) => s.selectStack)
  const selectedStackId = useAppStore((s) => s.selectedStackId)
  const selectedEnvironmentId = useAppStore((s) => s.selectedEnvironmentId)
  const stackTabs = useAppStore((s) => s.stackTabs)
  const setStackTab = useAppStore((s) => s.setStackTab)
  const pinOrder = useAppStore((s) => s.pinOrder)
  const containerKey = containerKeyForStack(stack.id)
  const defaults = defaultPinsForStack()
  const stackPinned = effectivePins(pinOrder, containerKey, defaults) as StackTabKey[]
  const [dropHighlight, setDropHighlight] = useState<'header' | 'add' | null>(null)

  // Default: expanded. The store's Set tracks explicit overrides; if it's
  // empty this stack is treated as expanded.
  const manuallyCollapsed = expandedStacks.has(`c:${stack.id}`)
  const expanded = !manuallyCollapsed
  const isSelected = selectedStackId === stack.id

  const openIssues = useStackOpenIssueCount(projectId, stack.id)
  const openTasks = useStackOpenTaskCount(stack.id)

  const [stackDropPos, setStackDropPos] = useState<'above' | 'below' | null>(null)

  return (
    <div className="w-full flex flex-col">
      <div
        draggable
        onDragStart={(e) => onStackDragStart(e, stack.id)}
        className={`group rounded-lg transition-colors flex items-center w-full h-9 pr-2 relative cursor-grab active:cursor-grabbing ${
          isSelected ? 'bg-neutral-800/60' : 'hover:bg-neutral-800/30'
        } ${dropHighlight === 'header' ? 'ring-1 ring-blue-500/80 bg-blue-500/5' : ''}`}
        onContextMenu={(e) => onStackContextMenu(e, stack)}
        onDragOver={(e) => {
          const types = e.dataTransfer.types
          if (types.includes('text/env-id')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropHighlight('header')
            setStackDropPos(null)
          } else if (types.includes('text/stack-id')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
            const upper = e.clientY - rect.top < rect.height / 2
            setStackDropPos(upper ? 'above' : 'below')
            setDropHighlight(null)
          }
        }}
        onDragLeave={() => {
          setDropHighlight((h) => (h === 'header' ? null : h))
          setStackDropPos(null)
        }}
        onDrop={(e) => {
          const envFrom = e.dataTransfer.getData('text/env-id')
          const stackFrom = e.dataTransfer.getData('text/stack-id')
          setDropHighlight(null)
          const pos = stackDropPos
          setStackDropPos(null)
          if (envFrom) {
            e.preventDefault()
            const firstEnv = environments[0]?.id ?? null
            onEnvDropOnStack(envFrom, stack.id, firstEnv)
          } else if (stackFrom && stackFrom !== stack.id && pos) {
            e.preventDefault()
            onStackDrop(stackFrom, stack.id, pos)
          }
        }}
      >
        {stackDropPos === 'above' && (
          <div className="absolute left-2 right-2 top-0 h-[2px] bg-blue-500 rounded pointer-events-none" />
        )}
        {stackDropPos === 'below' && (
          <div className="absolute left-2 right-2 bottom-0 h-[2px] bg-blue-500 rounded pointer-events-none" />
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            // Toggle via marker: store a collapse sentinel rather than mutate
            // a single boolean, so we can flip the default behaviour later.
            toggleStackExpanded(`c:${stack.id}`)
          }}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded hover:bg-neutral-700/60"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          <ChevronDownIcon
            size={14}
            className="text-neutral-400"
            style={{
              transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.2s',
            }}
          />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            selectStack(stack.id)
          }}
          className="flex-1 min-w-0 flex items-center gap-2 h-8 text-left"
        >
          <span
            className={`text-[14px] font-semibold truncate ${isSelected ? 'text-neutral-50' : 'text-neutral-100'}`}
          >
            {stack.name}
          </span>
          <span className="text-[10px] uppercase tracking-wider text-neutral-500 shrink-0">
            {stack.kind.replace(/_/g, ' ')}
          </span>
          <StackUnreadDot stackId={stack.id} hideWhenExpanded={expanded} />
          {/* Issue / task count pills — only when the stack is collapsed.
           *  When expanded the Issues and Tasks pin rows display their own
           *  IssuesBadge / task-count, so repeating it on the header is
           *  visual double-counting. */}
          {!expanded && openIssues != null && openIssues > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded bg-red-500/20 text-red-300 text-[10px] font-medium tabular-nums shrink-0"
              title={`${openIssues} open issue${openIssues === 1 ? '' : 's'}`}
            >
              {openIssues > 99 ? '99+' : openIssues}
            </span>
          )}
          {!expanded && openTasks > 0 && (
            <span
              className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 rounded bg-neutral-700/60 text-neutral-300 text-[10px] font-medium tabular-nums shrink-0"
              title={`${openTasks} open task${openTasks === 1 ? '' : 's'}`}
            >
              {openTasks > 99 ? '99+' : openTasks}
            </span>
          )}
        </button>
        {/* The "+" hover picker was removed — pinning happens via the tab
            bar's pin icon inside StackTabsView / EnvTabsView instead. */}
      </div>
      {expanded && (
        <>
          {stackPinned.map((tabKey, idx) => {
            const meta = STACK_TAB_META[tabKey]
            if (!meta) return null
            const pKey = makePinKey('stack', stack.id, tabKey)
            const isActive =
              selectedStackId === stack.id &&
              !selectedEnvironmentId &&
              (stackTabs[stack.id] ?? 'overview') === tabKey
            const expandable = EXPANDABLE_STACK_TABS.has(tabKey)
            const badge =
              tabKey === 'issues' ? (
                <IssuesBadge projectId={projectId} stackId={stack.id} />
              ) : null
            return (
              <PinnedRow
                key={pKey}
                containerKey={containerKey}
                containerId={stack.id}
                kind="stack"
                tabKey={tabKey}
                index={idx}
                siblings={stackPinned}
                defaults={defaults}
                label={meta.label}
                icon={meta.icon}
                expandable={expandable}
                isActive={isActive}
                onActivate={() => {
                  selectStack(stack.id)
                  setStackTab(stack.id, tabKey)
                }}
                badge={badge}
                setContextMenu={setContextMenu}
              />
            )
          })}
          {environments.map(renderEnv)}
          <div
            className={`rounded-lg cursor-pointer flex items-center w-full h-8 pl-10 pr-4 py-1 hover:bg-neutral-800/50 transition-colors ${
              dropHighlight === 'add' ? 'ring-1 ring-blue-500/80 bg-blue-500/5' : ''
            }`}
            onClick={(e) => {
              e.stopPropagation()
              onAddEnvironment(stack.id)
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/env-id')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                setDropHighlight('add')
              }
            }}
            onDragLeave={() => setDropHighlight((h) => (h === 'add' ? null : h))}
            onDrop={(e) => {
              const fromId = e.dataTransfer.getData('text/env-id')
              setDropHighlight(null)
              if (!fromId) return
              e.preventDefault()
              onEnvDropOnStack(fromId, stack.id, null) // null → append at end
            }}
          >
            <AddLarge size={12} className="text-neutral-500 shrink-0" />
            <div className="ml-2 text-[12px] text-neutral-500">Add environment</div>
          </div>
        </>
      )}
    </div>
  )
}

/* Count open (non-default) tasks for a stack. Hits the paginated
 * stack-tasks endpoint with per_page=1 and reads the `total` meta — so the
 * payload is O(1) regardless of stack size. Polled every 30 s. */
function useStackOpenTaskCount(stackId: string): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const page = (await window.electronAPI.tasks.listByStack(stackId, {
          status: 'open',
          per_page: 1,
          page: 1,
        })) as { total?: number }
        if (!cancelled) setCount(page.total ?? 0)
      } catch {
        /* ignore */
      }
    }
    run()
    const h = setInterval(run, 30_000)
    return () => {
      cancelled = true
      clearInterval(h)
    }
  }, [stackId])
  return count
}

export function Sidebar() {
  const { data: projects } = useProjects()
  const { data: allAgents } = useAllAgents()
  const [showNewProject, setShowNewProject] = useState(false)
  const openAddEnvironment = useAppStore((s) => s.openAddEnvironment)
  const [search, setSearch] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renamingEnvironment, setRenamingEnvironment] = useState<Environment | null>(null)
  const openEditEnvironment = useAppStore((s) => s.openEditEnvironment)

  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const selectProject = useAppStore((s) => s.selectProject)
  const selectedProject = useMemo(
    () => projects?.find((p) => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )
  const { data: environments } = useEnvironments(selectedProjectId)
  const { data: stacks } = useStacks(selectedProjectId)
  const openAddStack = useAppStore((s) => s.openAddStack)
  const openEditStack = useAppStore((s) => s.openEditStack)
  const connectProject = useConnectionStore((s) => s.connectProject)
  const reorderEnvs = useReorderEnvironments()
  const reorderStacks = useReorderStacks()
  const updateEnv = useUpdateEnvironment()
  const spawnAgent = useSpawnAgent()
  const selectTaskAction = useAppStore((s) => s.selectTask)
  const setActiveAgentAction = useAppStore((s) => s.setActiveAgent)
  const [dragOverEnvId, setDragOverEnvId] = useState<string | null>(null)
  const dragEnvRef = useRef<string | null>(null)
  const dragStackRef = useRef<string | null>(null)

  /** Move an env across stacks (or within the same stack) in one shot.
   *  If stack_id changed we PATCH the env first (and await), then reorder
   *  globally so the project-wide sort_order reflects the new grouping.
   *  `beforeEnvId` is the id of the env the dropped one should sit just
   *  above; null = append at the tail of the target stack. */
  const moveEnvToStack = async (
    fromEnvId: string,
    targetStackId: string,
    beforeEnvId: string | null,
  ): Promise<void> => {
    if (!environments || !selectedProjectId || !stacks) return
    const src = environments.find((e) => e.id === fromEnvId)
    if (!src) return
    try {
      if (src.stack_id !== targetStackId) {
        await updateEnv.mutateAsync({ id: fromEnvId, data: { stack_id: targetStackId } })
      }
      // Rebuild the ordered id list: bucket by stack_id, slot the dragged
      // env into its new home, then flatten in stack display order.
      const bucketed = new Map<string, string[]>()
      for (const s of stacks) bucketed.set(s.id, [])
      for (const e of environments) {
        if (e.id === fromEnvId) continue
        const list = bucketed.get(e.stack_id) ?? []
        list.push(e.id)
        bucketed.set(e.stack_id, list)
      }
      const targetList = bucketed.get(targetStackId) ?? []
      if (beforeEnvId) {
        const idx = targetList.indexOf(beforeEnvId)
        if (idx === -1) targetList.push(fromEnvId)
        else targetList.splice(idx, 0, fromEnvId)
      } else {
        targetList.push(fromEnvId)
      }
      bucketed.set(targetStackId, targetList)
      const orderedIds: string[] = []
      for (const s of stacks) {
        const list = bucketed.get(s.id) ?? []
        orderedIds.push(...list)
      }
      await reorderEnvs.mutateAsync({ projectId: selectedProjectId, orderedIds })
    } catch (err) {
      console.error('[Sidebar] moveEnvToStack failed', err)
    }
  }

  const handleStackContextMenu = (e: React.MouseEvent, stack: Stack) => {
    e.preventDefault(); e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, items: [
      { label: 'Stack Settings', onClick: () => openEditStack(stack.id) },
    ]})
  }

  /** Drop a stack onto another stack's row → reorder. `dropBefore` is the id
   *  the moved stack should sit just above; null = append at the tail. Mirrors
   *  the env reorder path but at the project → stacks level. */
  const moveStack = async (
    fromStackId: string,
    dropBefore: string | null,
  ): Promise<void> => {
    if (!selectedProjectId || !stacks) return
    const current = stacks.map((s) => s.id)
    const withoutSrc = current.filter((id) => id !== fromStackId)
    let nextOrder: string[]
    if (dropBefore) {
      const idx = withoutSrc.indexOf(dropBefore)
      if (idx === -1) nextOrder = [...withoutSrc, fromStackId]
      else {
        nextOrder = [...withoutSrc]
        nextOrder.splice(idx, 0, fromStackId)
      }
    } else {
      nextOrder = [...withoutSrc, fromStackId]
    }
    // No-op guard: same order as before, skip the backend round-trip.
    if (nextOrder.every((id, i) => id === current[i])) return
    try {
      await reorderStacks.mutateAsync({ projectId: selectedProjectId, orderedIds: nextOrder })
    } catch (err) {
      console.error('[Sidebar] moveStack failed', err)
    }
  }

  // Default to the first project when nothing is selected (e.g. fresh install).
  useEffect(() => {
    if (!selectedProjectId && projects && projects.length > 0) {
      selectProject(projects[0].id)
    }
  }, [selectedProjectId, projects, selectProject])

  // Pre-warm SSH connections for the currently selected project.
  useEffect(() => {
    if (selectedProjectId) connectProject(selectedProjectId)
  }, [selectedProjectId, connectProject])

  const agentsByTask = useMemo(() => { const map = new Map<string, Agent[]>(); if (allAgents) { for (const agent of allAgents) { const list = map.get(agent.task_id); if (list) list.push(agent); else map.set(agent.task_id, [agent]) } }; return map }, [allAgents])

  /** Spawn a terminal in the env's general task and type the launch_command
   *  into it. We resolve-or-create the general task the same way the
   *  SessionsSubTree placeholder does, then schedule a writeStdin with a
   *  small delay so the shell has finished its rc files before we type.
   */
  const runLaunchCommand = async (env: Environment): Promise<void> => {
    if (!env.launch_command) return
    try {
      let list = (await window.electronAPI.tasks.list(env.id)) as Array<{ id: string; is_default?: 0 | 1 }>
      let general = list.find((t) => t.is_default === 1)
      if (!general) {
        general = (await window.electronAPI.tasks.create({
          environment_id: env.id,
          title: 'general',
        })) as { id: string; is_default?: 0 | 1 }
        list = [...list, general]
      }
      spawnAgent.mutate(
        { taskId: general.id, agentType: 'terminal', autoInstall: false },
        {
          onSuccess: (agent) => {
            selectTaskAction(general!.id, env.id)
            setActiveAgentAction(agent.id)
            // Give the shell its rc-file time then type the command. 600ms is
            // empirically enough for a login zsh to settle after `-l -i`.
            setTimeout(() => {
              window.electronAPI.agents.writeStdin(agent.id, `${env.launch_command}\n`)
                .catch(() => { /* best-effort — user can retype manually */ })
            }, 600)
          },
        },
      )
    } catch (err) {
      console.error('[Sidebar] runLaunchCommand failed', err)
    }
  }

  const handleEnvContextMenu = (e: React.MouseEvent, env: Environment) => {
    e.preventDefault(); e.stopPropagation()
    const items: ContextMenuState['items'] = []
    // Show "Open Website" if the environment label looks like a domain
    if (env.label && env.label.includes('.')) {
      const url = env.label.startsWith('http') ? env.label : `https://${env.label}`
      items.push({ label: 'Open Website', onClick: () => window.open(url, '_blank') })
    }
    if (env.role !== 'deploy' && env.launch_command) {
      items.push({
        label: 'Run locally',
        onClick: () => { void runLaunchCommand(env) },
      })
    }
    items.push({ label: 'Rename', onClick: () => setRenamingEnvironment(env) })
    items.push({ label: 'Environment Settings', onClick: () => openEditEnvironment(env.id) })
    setContextMenu({ x: e.clientX, y: e.clientY, items })
  }

  // Task/routine context menus were sidebar-level; now those live in the
  // env's Tabs view (Sessions/Routines). Kept here as a no-op placeholder
  // in case any child still references it during the transition.

  return (
    <>
      <div className="flex flex-row h-full" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <aside className="bg-black flex flex-col gap-3 items-start p-4 w-80 border-r border-neutral-800 overflow-hidden" style={{ transitionTimingFunction: ease }}>
          <div className="relative shrink-0 w-full">
            <div className="flex items-center p-1 w-full gap-2">
              <div className="h-10 w-10 flex items-center justify-center shrink-0">
                {selectedProject ? (
                  <FaviconOrIdenticon
                    url={selectedProject.favicon_url}
                    seed={selectedProject.id}
                    size={24}
                  />
                ) : (
                  <Folder size={20} className="text-neutral-400" />
                )}
              </div>
              <div className="px-1 py-1 min-w-0 flex-1">
                <div className="text-[16px] font-semibold text-neutral-50 truncate">
                  {selectedProject?.name ?? 'No project selected'}
                </div>
              </div>
              {selectedProject?.url && (
                <button
                  type="button"
                  title={`Open ${selectedProject.url}`}
                  aria-label="Open project link"
                  onClick={() => window.open(selectedProject.url!, '_blank')}
                  className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors shrink-0"
                >
                  <Launch size={16} />
                </button>
              )}
            </div>
          </div>
          <div className="relative shrink-0 transition-all duration-500 w-full" style={{ transitionTimingFunction: ease }}><div className="bg-black h-10 relative rounded-lg flex items-center transition-all duration-500 w-full" style={{ transitionTimingFunction: ease }}><div className="flex items-center justify-center shrink-0 transition-all duration-500 px-1" style={{ transitionTimingFunction: ease }}><div className="size-8 flex items-center justify-center"><SearchIcon size={16} className="text-neutral-50" /></div></div><div className="flex-1 relative transition-opacity duration-500 overflow-hidden opacity-100" style={{ transitionTimingFunction: ease }}><div className="flex flex-col justify-center size-full"><div className="flex flex-col gap-2 items-start justify-center pr-2 py-1 w-full"><input placeholder="Search environments & tasks..." className="w-full bg-transparent border-none outline-none text-[14px] text-neutral-50 placeholder:text-neutral-400 leading-[20px]" type="text" value={search} onChange={(e) => setSearch(e.target.value)} /></div></div></div><div aria-hidden="true" className="absolute inset-0 rounded-lg border border-neutral-800 pointer-events-none" /></div></div>
          <div className="flex flex-col w-full overflow-y-auto flex-1 min-h-0 gap-2">
            {!selectedProjectId && (!projects || projects.length === 0) && (
              <div className="px-4 py-4 text-[14px] text-neutral-500 text-center">No projects yet</div>
            )}
            {!selectedProjectId && projects && projects.length > 0 && (
              <div className="px-4 py-4 text-[14px] text-neutral-500 text-center">Select a project from the left sidebar</div>
            )}
            {/* Issues live exclusively inside each StackGroup below. No
                project-wide Issues row — issues belong to a stack (via their
                env's stack_id) and should be navigated that way. */}
            {selectedProjectId && environments && (() => {
              const renderEnv = (env: Environment) => (
                <EnvironmentGroup
                  key={env.id}
                  environment={env}
                  agentsByTask={agentsByTask}
                  search={search}
                  onContextMenu={handleEnvContextMenu}
                  setContextMenu={setContextMenu}
                  isDragOver={dragOverEnvId === env.id}
                  onEnvDragStart={(e) => {
                    e.stopPropagation()
                    // Custom MIME so we can distinguish env drags from pin drags
                    // on the various drop targets (stack header, pin rows).
                    e.dataTransfer.setData('text/env-id', env.id)
                    e.dataTransfer.effectAllowed = 'move'
                    dragEnvRef.current = env.id
                  }}
                  onEnvDragOver={(e) => {
                    if (!e.dataTransfer.types.includes('text/env-id')) return
                    e.preventDefault()
                    e.stopPropagation()
                    e.dataTransfer.dropEffect = 'move'
                    if (dragEnvRef.current && dragEnvRef.current !== env.id) {
                      setDragOverEnvId(env.id)
                    }
                  }}
                  onEnvDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    const fromId = e.dataTransfer.getData('text/env-id')
                    if (fromId && fromId !== env.id) {
                      // Drop onto an env row — move into that env's stack,
                      // inserted just before it.
                      moveEnvToStack(fromId, env.stack_id, env.id)
                    }
                    setDragOverEnvId(null)
                    dragEnvRef.current = null
                  }}
                  onEnvDragEnd={() => { setDragOverEnvId(null); dragEnvRef.current = null }}
                />
              )

              const stackList = (stacks ?? []).filter(Boolean)
              if (stackList.length === 0) {
                return (
                  <div className="px-4 py-4 text-[14px] text-neutral-500 text-center">No stacks yet</div>
                )
              }
              // Always render the stack level — even for projects with a
              // single Default stack. The Issues row lives inside each stack
              // group, and the user gets a consistent hierarchy to navigate.
              return (
                <>
                  {stackList.map((stack) => {
                    const stackEnvs = environments.filter((e) => e.stack_id === stack.id)
                    return (
                      <StackGroup
                        key={stack.id}
                        projectId={stack.project_id}
                        stack={stack}
                        environments={stackEnvs}
                        renderEnv={renderEnv}
                        onStackContextMenu={handleStackContextMenu}
                        onAddEnvironment={(sid) => openAddEnvironment(stack.project_id, sid)}
                        setContextMenu={setContextMenu}
                        onEnvDropOnStack={moveEnvToStack}
                        onStackDragStart={(e, sid) => {
                          dragStackRef.current = sid
                          e.dataTransfer.setData('text/stack-id', sid)
                          e.dataTransfer.effectAllowed = 'move'
                        }}
                        onStackDrop={(fromId, targetId, pos) => {
                          dragStackRef.current = null
                          // Translate the (target, position) pair into the
                          // "dropBefore" id moveStack expects. "above" → drop
                          // before the target; "below" → drop before the stack
                          // immediately AFTER the target (or append if none).
                          const list = (stacks ?? []).map((s) => s.id)
                          const tIdx = list.indexOf(targetId)
                          const dropBefore =
                            pos === 'above'
                              ? targetId
                              : list[tIdx + 1] ?? null
                          void moveStack(fromId, dropBefore)
                        }}
                      />
                    )
                  })}
                </>
              )
            })()}
          </div>
          <div className="w-full pt-2 border-t border-neutral-800 shrink-0">
            <div className="w-full flex flex-col">
              <div className="relative shrink-0 transition-all duration-500 w-full" style={{ transitionTimingFunction: ease }}>
                <div
                  className="rounded-lg cursor-pointer transition-all duration-500 flex items-center relative w-full h-10 px-4 py-2 hover:bg-neutral-800"
                  style={{ transitionTimingFunction: ease }}
                  onClick={() => selectedProjectId ? openAddStack(selectedProjectId) : setShowNewProject(true)}
                >
                  <div className="flex items-center justify-center shrink-0"><AddLarge size={16} className="text-neutral-400" /></div>
                  <div className="flex-1 relative transition-opacity duration-500 overflow-hidden opacity-100 ml-3" style={{ transitionTimingFunction: ease }}>
                    <div className="text-[14px] text-neutral-400 leading-[20px]">{selectedProjectId ? 'Add Stack' : 'New Project'}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
      {showNewProject && <NewProjectDialog onClose={() => setShowNewProject(false)} />}
      {contextMenu && <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />}
      {renamingEnvironment && <RenameEnvironmentDialog environment={renamingEnvironment} onClose={() => setRenamingEnvironment(null)} />}
    </>
  )
}

export function RenameProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [name, setName] = useState(project.name)
  const handleSubmit = async () => { const trimmed = name.trim(); if (!trimmed || trimmed === project.name) { onClose(); return }; await window.electronAPI.projects.update(project.id, { name: trimmed }); onClose() }
  return (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}><div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[360px] shadow-2xl" onClick={(e) => e.stopPropagation()}><div className="text-[15px] font-semibold text-neutral-50 mb-4">Rename Project</div><input autoFocus type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose() }} className="w-full h-10 rounded-lg bg-black border border-neutral-700 px-3 text-[14px] text-neutral-50 outline-none focus:border-neutral-500 transition-colors" placeholder="Project name" /><div className="flex justify-end gap-2 mt-4"><button onClick={onClose} className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors">Cancel</button><button onClick={handleSubmit} className="h-8 px-4 rounded-lg text-[13px] text-neutral-50 bg-neutral-700 hover:bg-neutral-600 transition-colors">Rename</button></div></div></div>)
}

function RenameEnvironmentDialog({ environment, onClose }: { environment: Environment; onClose: () => void }) {
  const [name, setName] = useState(environment.name)
  const handleSubmit = async () => { const trimmed = name.trim(); if (!trimmed || trimmed === environment.name) { onClose(); return }; await window.electronAPI.environments.update(environment.id, { name: trimmed }); onClose() }
  return (<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}><div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[360px] shadow-2xl" onClick={(e) => e.stopPropagation()}><div className="text-[15px] font-semibold text-neutral-50 mb-4">Rename Environment</div><input autoFocus type="text" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose() }} className="w-full h-10 rounded-lg bg-black border border-neutral-700 px-3 text-[14px] text-neutral-50 outline-none focus:border-neutral-500 transition-colors" placeholder="Environment name" /><div className="flex justify-end gap-2 mt-4"><button onClick={onClose} className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors">Cancel</button><button onClick={handleSubmit} className="h-8 px-4 rounded-lg text-[13px] text-neutral-50 bg-neutral-700 hover:bg-neutral-600 transition-colors">Rename</button></div></div></div>)
}
