import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Terminal as TerminalIcon,
  Folder as FolderIcon,
  Timer as TimerIcon,
  Settings as SettingsIcon,
  CloudUpload,
  ChevronRight,
  Add as AddIcon,
  Play,
  Stop,
  Edit as EditIcon,
  Pin,
  PinFilled,
  LogoGithub,
} from '@carbon/icons-react'
import { useAppStore, type EnvTabKey } from '../../stores/app-store'
import { useToastStore } from '../../stores/toast-store'
import {
  containerKeyForEnv,
  defaultPinsForEnv,
  effectivePins,
} from '../../lib/pins'
import { useEnvironment, useTasks } from '../../hooks/useProjects'
import { useAllAgents, useSpawnAgent, useKillAgent } from '../../hooks/useAgents'
import { useRoutines, useStartRoutine, useStopRoutine, useDeleteRoutine } from '../../hooks/useRoutines'
import { useActivityStore } from '../../stores/activity-store'
import { NewRoutineDialog } from '../dialogs/NewRoutineDialog'
import { DeployView } from './DeployView'
import { GitHubTabView } from './GitHubTabView'
import type { Agent, Environment, Routine, Task, AgentSettings } from '../../../shared/types'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/types'
import { useWorkspaceRole } from '../../hooks/useWorkspaceRole'

/** Full-page view shown when the user clicks an env row in the sidebar.
 * Tabs depend on env role:
 * - operational: Sessions · Files · Routines · Settings
 * - deploy:      Deploy   · Terminals · Settings
 *
 * A "Session" is what used to be called an "agent" — we keep the DB/IPC
 * naming (agent/tasks) for backward compatibility, but surface it to the user
 * as "Session" because a deploy env can only run plain terminals, not AI
 * agents, and users think in terms of "a terminal/session open on this env".
 */
export function EnvTabsView({ environmentId }: { environmentId: string }) {
  const { data: env } = useEnvironment(environmentId)
  const envTabs = useAppStore((s) => s.envTabs)
  const setEnvTab = useAppStore((s) => s.setEnvTab)
  const openEditEnvironment = useAppStore((s) => s.openEditEnvironment)
  const pinOrder = useAppStore((s) => s.pinOrder)
  const togglePin = useAppStore((s) => s.togglePin)
  const setPinOrder = useAppStore((s) => s.setPinOrder)
  const pushToast = useToastStore((s) => s.push)

  if (!env) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Loading environment…
      </div>
    )
  }

  const isDeploy = env.role === 'deploy'
  const defaultTab: EnvTabKey = isDeploy ? 'deploy' : 'sessions'
  // Old state could have persisted 'overview' for some envs; coerce any
  // unknown/legacy key to the default so the removed tab can't linger.
  const storedTab = envTabs[environmentId] as EnvTabKey | 'overview' | undefined
  const activeTab: EnvTabKey =
    storedTab && storedTab !== 'overview' ? storedTab : defaultTab

  const tabs: { key: EnvTabKey; label: string; icon: React.ReactNode }[] = isDeploy
    ? [
        { key: 'deploy', label: 'Deploy', icon: <CloudUpload size={14} /> },
        { key: 'terminals', label: 'Terminals', icon: <TerminalIcon size={14} /> },
        { key: 'settings', label: 'Settings', icon: <SettingsIcon size={14} /> },
      ]
    : [
        { key: 'sessions', label: 'Sessions', icon: <TerminalIcon size={14} /> },
        { key: 'files', label: 'Files', icon: <FolderIcon size={14} /> },
        { key: 'routines', label: 'Routines', icon: <TimerIcon size={14} /> },
        { key: 'github', label: 'GitHub', icon: <LogoGithub size={14} /> },
        { key: 'settings', label: 'Settings', icon: <SettingsIcon size={14} /> },
      ]

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] min-h-0">
      <div className="shrink-0 border-b border-neutral-800">
        <div className="px-6 pt-4 pb-2">
          <div className="flex items-center gap-2 text-[12px] text-neutral-500">
            <span>Environment</span>
            <ChevronRight size={12} />
            <span className="text-neutral-300 truncate">{env.name}</span>
            <span className="text-neutral-600">·</span>
            <span
              className={`uppercase tracking-wider ${isDeploy ? 'text-fuchsia-300' : 'text-neutral-500'}`}
            >
              {isDeploy ? 'Deploy target' : env.execution_mode === 'remote' ? 'Remote' : 'Local'}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="text-[22px] font-semibold text-neutral-50 truncate">{env.name}</div>
            {env.label && <div className="text-[13px] text-neutral-500 truncate">{env.label}</div>}
          </div>
        </div>
        <div className="px-4 flex items-center gap-1">
          {tabs.map((t) => {
            const selected = activeTab === t.key
            const pinnable = t.key !== 'settings'
            const containerKey = containerKeyForEnv(environmentId)
            const defaults = defaultPinsForEnv(env)
            const currentPins = effectivePins(pinOrder, containerKey, defaults)
            const isPinned = pinnable && currentPins.includes(t.key)
            const handlePin = (): void => {
              if (!pinnable) return
              const wasDefault = defaults.includes(t.key as EnvTabKey) && isPinned
              const priorOrder = [...currentPins]
              togglePin(containerKey, t.key, defaults)
              // Undo toast: only for default pins (Sessions on operational,
              // Terminals on deploy) since those are the ones the user didn't
              // deliberately add — losing them by accident is a papercut.
              if (wasDefault) {
                pushToast({
                  message: `Unpinned ${t.label} from the sidebar`,
                  action: {
                    label: 'Undo',
                    onClick: () => setPinOrder(containerKey, priorOrder),
                  },
                })
              }
            }
            return (
              <button
                key={t.key}
                onClick={() => {
                  if (t.key === 'settings') {
                    openEditEnvironment(env.id)
                    return
                  }
                  setEnvTab(environmentId, t.key)
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
                      handlePin()
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        e.stopPropagation()
                        handlePin()
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

      <div className="flex-1 min-h-0 overflow-hidden">
        {/* deploy-env tabs */}
        {activeTab === 'deploy' && <DeployView environmentId={env.id} />}
        {activeTab === 'terminals' && <SessionsTab env={env} plainOnly />}
        {/* operational-env tabs */}
        {activeTab === 'sessions' && <SessionsTab env={env} />}
        {activeTab === 'files' && <FilesTab env={env} />}
        {activeTab === 'routines' && <RoutinesTab env={env} />}
        {activeTab === 'github' && <GitHubTabView env={env} />}
      </div>
    </div>
  )
}

/* ───────────────────────── Sessions tab ───────────────────────── */

const AGENT_META_MINI: Record<string, { name: string; color: string }> = {
  terminal: { name: 'Terminal', color: '#a3a3a3' },
  claude: { name: 'Claude', color: '#d4a27a' },
  gemini: { name: 'Gemini', color: '#60a5fa' },
  codex: { name: 'Codex', color: '#34d399' },
}

function SessionsTab({ env, plainOnly }: { env: Environment; plainOnly?: boolean }) {
  const { data: tasks = [] } = useTasks(env.id)
  const { data: allAgents = [] } = useAllAgents()
  const taskIds = useMemo(() => new Set(tasks.map((t) => t.id)), [tasks])
  const agents = useMemo(
    () => (allAgents || []).filter((a) => taskIds.has(a.task_id)),
    [allAgents, taskIds],
  )

  const perms = useWorkspaceRole()
  const spawnAgent = useSpawnAgent()
  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const qc = useQueryClient()
  const [launchError, setLaunchError] = useState<string | null>(null)

  const defaultTask = tasks.find((t) => t.is_default === 1) ?? null

  const settings: AgentSettings = env.agent_settings ?? DEFAULT_AGENT_SETTINGS
  const kinds: { key: string; label: string; color: string }[] = [
    { key: 'terminal', label: 'Terminal', color: AGENT_META_MINI.terminal.color },
  ]
  if (!plainOnly) {
    if (settings.claude?.enabled) kinds.push({ key: 'claude', label: 'Claude', color: AGENT_META_MINI.claude.color })
    if (settings.gemini?.enabled) kinds.push({ key: 'gemini', label: 'Gemini', color: AGENT_META_MINI.gemini.color })
    if (settings.codex?.enabled) kinds.push({ key: 'codex', label: 'Codex', color: AGENT_META_MINI.codex.color })
  }

  // Resolve the env's "general" task, falling back to a live fetch + create
  // if the cached tasks query hasn't populated yet (or the env is old enough
  // to predate the auto-created general task).
  const resolveGeneralTaskId = async (): Promise<string | null> => {
    if (defaultTask) return defaultTask.id
    try {
      const list = (await window.electronAPI.tasks.list(env.id)) as Array<{
        id: string
        is_default?: 0 | 1
      }>
      const existing = list.find((t) => t.is_default === 1)
      if (existing) return existing.id
      const created = (await window.electronAPI.tasks.create({
        environment_id: env.id,
        title: 'general',
      })) as { id: string }
      await qc.invalidateQueries({ queryKey: ['tasks', env.id] })
      return created.id
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  const launch = async (agentType: string): Promise<void> => {
    setLaunchError(null)
    const taskId = await resolveGeneralTaskId()
    if (!taskId) return
    spawnAgent.mutate(
      { taskId, agentType, autoInstall: false },
      {
        onSuccess: (agent) => {
          selectTask(taskId, env.id)
          setActiveAgent(agent.id)
        },
        onError: (err) => setLaunchError(err instanceof Error ? err.message : String(err)),
      },
    )
  }

  const visibleAgents = useMemo(() => {
    const arr = [...agents].sort((a, b) => {
      // running first, then by created_at desc
      const ra = a.status === 'running' ? 0 : 1
      const rb = b.status === 'running' ? 0 : 1
      if (ra !== rb) return ra - rb
      return (b.created_at || '').localeCompare(a.created_at || '')
    })
    return arr
  }, [agents])

  return (
    <div className="h-full overflow-y-auto px-6 py-5 space-y-5">
      {perms.canLaunchAgents && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Launch new session</div>
          <div className="flex flex-wrap gap-2">
            {kinds.map((k) => (
              <button
                key={k.key}
                disabled={spawnAgent.isPending}
                onClick={() => { void launch(k.key) }}
                className="flex items-center gap-2 h-9 px-3 rounded-md border border-neutral-800 bg-neutral-900/40 hover:bg-neutral-900/80 disabled:opacity-40 disabled:pointer-events-none text-[13px] text-neutral-100 transition-colors"
              >
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: k.color }}
                />
                {k.label}
                <AddIcon size={12} className="text-neutral-400" />
              </button>
            ))}
          </div>
          {launchError && (
            <div className="mt-2 text-[11px] text-red-300">{launchError}</div>
          )}
        </div>
      )}

      <div>
        <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
          {plainOnly ? 'Terminals' : 'Sessions'}
        </div>
        {visibleAgents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-[13px] text-neutral-500">
            No active sessions.
          </div>
        ) : (
          <div className="rounded-lg border border-neutral-800 divide-y divide-neutral-900 bg-neutral-900/30">
            {visibleAgents.map((a) => (
              <SessionRow key={a.id} agent={a} task={tasks.find((t) => t.id === a.task_id)} env={env} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SessionRow({ agent, task, env }: { agent: Agent; task?: Task; env: Environment }) {
  const activity = useActivityStore((s) => s.activities.get(agent.id))
  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const killAgent = useKillAgent()

  // tab_name is a display string like "Claude" or "Terminal"; strip down
  // to the lowercase kind so we can look up colour + label in AGENT_META_MINI.
  const kind = (agent.tab_name?.split(' ')[0] || 'terminal').toLowerCase()
  const kindMeta = AGENT_META_MINI[kind] ?? AGENT_META_MINI.terminal
  const dot =
    agent.status === 'running'
      ? activity === 'working'
        ? 'bg-blue-400'
        : 'bg-blue-500/60'
      : agent.status === 'error'
        ? 'bg-red-500'
        : agent.status === 'completed'
          ? 'bg-neutral-600'
          : 'bg-neutral-500'

  const title = task?.is_default ? 'Session' : task?.title ?? 'Session'

  return (
    <div
      className="flex items-center h-10 px-3 hover:bg-neutral-900/70 cursor-pointer group"
      onClick={() => {
        selectTask(agent.task_id, env.id)
        setActiveAgent(agent.id)
      }}
    >
      <span className={`size-2 rounded-full shrink-0 ${dot}`} />
      <span
        className="ml-3 text-[11px] font-medium uppercase tracking-wider shrink-0"
        style={{ color: kindMeta.color }}
      >
        {kindMeta.name}
      </span>
      <span className="ml-3 text-[13px] text-neutral-100 truncate flex-1">{title}</span>
      <span className="ml-3 text-[11px] text-neutral-500 tabular-nums shrink-0">
        {formatStart(agent.started_at || agent.created_at)}
      </span>
      {agent.status === 'running' && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            killAgent.mutate(agent.id)
          }}
          className="ml-2 w-6 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800 opacity-0 group-hover:opacity-100 transition-opacity"
          title="Kill session"
        >
          <Stop size={12} />
        </button>
      )}
    </div>
  )
}

function formatStart(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  return `${days}d`
}

/* ───────────────────────── Files tab (placeholder) ───────────────────────── */

function FilesTab({ env }: { env: Environment }) {
  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      <div className="max-w-xl mx-auto rounded-lg border border-dashed border-neutral-800 px-6 py-10 text-center">
        <FolderIcon size={32} className="text-neutral-600 mx-auto" />
        <div className="mt-3 text-[14px] text-neutral-200 font-medium">File browser</div>
        <div className="mt-1 text-[12px] text-neutral-500">
          {env.execution_mode === 'remote' ? env.remote_path : 'Local folder'} — coming soon.
        </div>
      </div>
    </div>
  )
}

/* ───────────────────────── Routines tab ───────────────────────── */

function RoutinesTab({ env }: { env: Environment }) {
  const { data: routines = [] } = useRoutines(env.id)
  const [showNew, setShowNew] = useState(false)
  const selectRoutine = useAppStore((s) => s.selectRoutine)
  const openRoutineSettings = useAppStore((s) => s.openRoutineSettings)

  return (
    <div className="h-full overflow-y-auto px-6 py-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-neutral-500">Routines</div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 h-8 px-3 rounded-md bg-neutral-900/60 border border-neutral-800 hover:bg-neutral-900 text-[13px] text-neutral-100 transition-colors"
        >
          <AddIcon size={12} /> New routine
        </button>
      </div>
      {routines.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-[13px] text-neutral-500">
          No routines yet.
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-800 divide-y divide-neutral-900 bg-neutral-900/30">
          {routines.map((r) => (
            <RoutineCard
              key={r.id}
              routine={r}
              onOpen={() => selectRoutine(r.id, env.id)}
              onSettings={() => openRoutineSettings(r.id)}
            />
          ))}
        </div>
      )}
      {showNew && <NewRoutineDialog environmentId={env.id} onClose={() => setShowNew(false)} />}
    </div>
  )
}

function RoutineCard({
  routine,
  onOpen,
  onSettings,
}: {
  routine: Routine
  onOpen: () => void
  onSettings: () => void
}) {
  const start = useStartRoutine()
  const stop = useStopRoutine()
  const del = useDeleteRoutine()
  const running = !!routine.tmux_session_name
  return (
    <div className="flex items-center h-11 px-3 hover:bg-neutral-900/70 group">
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (running) stop.mutate(routine.id)
          else start.mutate(routine.id)
        }}
        className={`shrink-0 w-6 h-6 flex items-center justify-center rounded ${
          running ? 'text-red-400 hover:bg-red-900/30' : 'text-emerald-400 hover:bg-emerald-900/30'
        }`}
        title={running ? 'Stop' : 'Start'}
      >
        {running ? <Stop size={12} /> : <Play size={12} />}
      </button>
      <button onClick={onOpen} className="flex-1 ml-3 flex flex-col items-start min-w-0 text-left">
        <div className="text-[13px] text-neutral-100 truncate">{routine.name}</div>
        <div className="text-[11px] text-neutral-500 truncate">
          {routine.cron_expression} · {routine.agent_type}
        </div>
      </button>
      <span
        className={`ml-3 shrink-0 text-[10px] uppercase tracking-wider ${running ? 'text-emerald-300' : 'text-neutral-500'}`}
      >
        {running ? 'running' : 'idle'}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onSettings()
        }}
        className="ml-2 shrink-0 w-6 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Routine settings"
      >
        <EditIcon size={12} />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation()
          if (confirm(`Delete routine "${routine.name}"?`)) del.mutate(routine.id)
        }}
        className="ml-1 shrink-0 w-6 h-6 flex items-center justify-center rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800 opacity-0 group-hover:opacity-100 transition-opacity"
        title="Delete"
      >
        <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
