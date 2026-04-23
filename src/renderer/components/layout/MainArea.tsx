import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useAppStore } from '../../stores/app-store'
import { useActivityStore } from '../../stores/activity-store'
import { useAgents, useAllAgents, useSpawnAgent, useKillAgent, useDeleteAgent, useAgentStdout } from '../../hooks/useAgents'
import { useEnvironment } from '../../hooks/useProjects'
import { TerminalTabs } from '../terminal/TerminalTabs'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { ChatPanel } from '../terminal/ChatPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { RoutineView } from './RoutineView'
import { ProjectSettingsView } from './ProjectSettingsView'
import { TaskSettingsView } from './TaskSettingsView'
import { RoutineSettingsView } from './RoutineSettingsView'
import { TeamSettingsView } from './TeamSettingsView'
import { AllProjectsView } from './AllProjectsView'
import { ActivityView } from './ActivityView'
import { IssuesListView } from './IssuesListView'
import { IssueDetailView } from './IssueDetailView'
import { AppsSettingsView } from './AppsSettingsView'
import { AddEnvironmentView } from './AddEnvironmentView'
import { EditEnvironmentView } from './EditEnvironmentView'
import { EditStackView } from './EditStackView'
import { AddStackView } from './AddStackView'
import { StackTabsView } from './StackTabsView'
import { EnvTabsView } from './EnvTabsView'
import { useWorkspaceRole } from '../../hooks/useWorkspaceRole'
import type { AgentSettings } from '../../../shared/types'
import { DEFAULT_AGENT_SETTINGS } from '../../../shared/types'

const LAUNCHER_TAB_ID = '__launcher__'
const MAX_PANES = 4
const MIN_PANE_PCT = 10

/* ======================== Agent Launch Grid ======================== */

const AGENT_META: Record<string, { name: string; icon: React.ReactNode; color: string; gradient: string }> = {
  terminal: {
    name: 'Terminal', color: '#a3a3a3', gradient: 'from-neutral-800 to-neutral-900',
    icon: (<svg viewBox="0 0 24 24" className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 17l6-5-6-5M12 19h8" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  },
  chat: {
    name: 'Chat', color: '#c084fc', gradient: 'from-purple-950 to-neutral-900',
    icon: (<svg viewBox="0 0 24 24" className="w-8 h-8" fill="none" stroke="#c084fc" strokeWidth="1.5"><path d="M21 12a8 8 0 0 1-11.8 7l-4.2 1 1-3.8A8 8 0 1 1 21 12Z" strokeLinecap="round" strokeLinejoin="round"/><path d="M8 11h.01M12 11h.01M16 11h.01" strokeLinecap="round"/></svg>),
  },
  claude: {
    name: 'Claude', color: '#d4a27a', gradient: 'from-orange-950 to-neutral-900',
    icon: (<svg viewBox="0 0 24 24" className="w-8 h-8" fill="none"><path d="M16.5 3.5L13 7l3.5 3.5M7.5 3.5L11 7 7.5 10.5M7 17h10M9 21h6" stroke="#d4a27a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  },
  gemini: {
    name: 'Gemini', color: '#60a5fa', gradient: 'from-blue-950 to-neutral-900',
    icon: (<svg viewBox="0 0 24 24" className="w-8 h-8" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" stroke="#60a5fa" strokeWidth="1.5" /><path d="M12 2c-3 3.6-3 14.4 0 20M12 2c3 3.6 3 14.4 0 20M2 12h20" stroke="#60a5fa" strokeWidth="1.5" strokeLinecap="round" /></svg>),
  },
  codex: {
    name: 'Codex', color: '#34d399', gradient: 'from-emerald-950 to-neutral-900',
    icon: (<svg viewBox="0 0 24 24" className="w-8 h-8" fill="none"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /><path d="M9 10l2 2-2 2M15 10l-2 2 2 2" stroke="#34d399" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>),
  },
}

function LaunchingOverlay({ agentType }: { agentType: string }) {
  const meta = AGENT_META[agentType] || AGENT_META.terminal
  const label = meta.name
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-sm pointer-events-auto">
      <div className="flex flex-col items-center gap-4">
        <div className="relative w-16 h-16 flex items-center justify-center">
          <svg viewBox="0 0 24 24" className="absolute inset-0 w-full h-full animate-spin" fill="none">
            <circle cx="12" cy="12" r="10" stroke={meta.color} strokeWidth="2" opacity="0.2" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke={meta.color} strokeWidth="2" strokeLinecap="round" />
          </svg>
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${meta.color}20` }}>
            {meta.icon}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[14px] font-medium text-neutral-100">Launching {label}…</div>
          <div className="text-[12px] text-neutral-400 mt-1">
            Connecting to the environment and starting the session.
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentLaunchGrid({ agentSettings, onLaunch, isSpawning, canLaunch }: {
  agentSettings: AgentSettings | null; onLaunch: (t: string) => void; isSpawning: boolean; canLaunch: boolean
}) {
  const settings = agentSettings || DEFAULT_AGENT_SETTINGS
  const options: { key: string; meta: (typeof AGENT_META)[string] }[] = [
    { key: 'terminal', meta: AGENT_META.terminal },
    { key: 'chat', meta: AGENT_META.chat },
  ]
  for (const [key, config] of Object.entries(settings)) {
    if (config.enabled && AGENT_META[key]) options.push({ key, meta: AGENT_META[key] })
  }
  if (!canLaunch) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--bg-primary)]">
        <div className="text-center text-neutral-400 max-w-[420px]">
          <p className="text-[15px]">You can browse this workspace but not launch sessions.</p>
          <p className="text-[12px] text-neutral-500 mt-1">Ask an admin to upgrade your role from <span className="text-neutral-300">viewer</span> to <span className="text-neutral-300">developer</span> if you need to spawn agents.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-center h-full bg-[var(--bg-primary)]">
      <div className="flex flex-col items-center gap-6 max-w-[560px]">
        <div className="text-center mb-2"><p className="text-[15px] text-neutral-400">Launch a session</p></div>
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(options.length, 3)}, 1fr)` }}>
          {options.map(({ key, meta }) => (
            <button key={key} onClick={() => onLaunch(key)} disabled={isSpawning}
              className={`group relative flex flex-col items-center justify-center gap-3 w-[156px] h-[124px] rounded-xl border border-neutral-800 bg-gradient-to-b ${meta.gradient} hover:border-neutral-600 hover:scale-[1.03] active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none transition-all duration-200 cursor-pointer`}>
              <div className="flex items-center justify-center w-12 h-12 rounded-lg" style={{ backgroundColor: `${meta.color}15` }}>{meta.icon}</div>
              <span className="text-[13px] font-medium text-neutral-200 group-hover:text-white transition-colors">{meta.name}</span>
              <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none" style={{ boxShadow: `inset 0 0 0 1px ${meta.color}30, 0 0 20px ${meta.color}08` }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ======================== Main Area ======================== */

export function MainArea() {
  const selectedTaskId = useAppStore((s) => s.selectedTaskId)
  const selectedRoutineId = useAppStore((s) => s.selectedRoutineId)
  const selectedEnvironmentId = useAppStore((s) => s.selectedEnvironmentId)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const [error, setError] = useState<string | null>(null)
  const [launcherOpen, setLauncherOpen] = useState(false)
  const [launchingType, setLaunchingType] = useState<string | null>(null)
  const activities = useActivityStore((s) => s.activities)

  // Current view: what's displayed in the content area
  const [panes, setPanes] = useState<string[]>([])
  const [activePaneIndex, setActivePaneIndex] = useState(0)
  const [paneSizes, setPaneSizes] = useState<number[]>([100])

  // Persisted split layouts — survive navigation and app restarts
  const savePaneLayout = useAppStore((s) => s.savePaneLayout)
  const getPaneLayout = useAppStore((s) => s.getPaneLayout)
  const pinnedTabs = useAppStore((s) => s.pinnedTabs)

  const [tabOrder, setTabOrder] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const [dragTargetPane, setDragTargetPane] = useState<number | null>(null)
  const [dragTargetSide, setDragTargetSide] = useState<'left' | 'right' | 'center' | null>(null)

  // Track IDs of agents we just spawned (to prevent sync effect from overwriting)
  const pendingSpawnRef = useRef<string | null>(null)

  const { data: agents } = useAgents(selectedTaskId)
  const { data: allAgents } = useAllAgents()
  const { data: environment } = useEnvironment(selectedEnvironmentId)

  // Launch agents (spawned by the sidebar Play/Stop toggle on the env
  // row) are kept hidden from the tab bar by default — they're background
  // processes, not regular sessions. They become "visible" (i.e. join the
  // tab bar) only when the user explicitly surfaces one via the sidebar's
  // right-click → "View launch terminal" action, which adds the agent to
  // tabOrder. Once surfaced, the agent behaves like any other tab: closing
  // the X kills it (same as any other session); the Play/Stop button on
  // the env row stays authoritative for starting/stopping the process.
  const visibleAgents = useMemo(
    () =>
      (agents ?? []).filter(
        (a) => !a.tab_name?.startsWith('▶ ') || tabOrder.includes(a.id),
      ),
    [agents, tabOrder],
  )
  const spawnAgent = useSpawnAgent()
  const killAgent = useKillAgent()
  const deleteAgent = useDeleteAgent()
  const selectTask = useAppStore((s) => s.selectTask)

  const writersRef = useRef<Map<string, (data: string) => void>>(new Map())
  // Buffer stdout that arrives before a writer is registered — happens on
  // fresh spawn where pty output starts before TerminalPanel has mounted and
  // called registerWriter(). Previously those first bytes were silently
  // dropped, leaving local terminals stuck at a blank pane (especially bad
  // for short-output commands like `bash -l` whose prompt is the ONLY thing
  // that ever shows up). On registerWriter we flush anything we've queued.
  const pendingStdoutRef = useRef<Map<string, string[]>>(new Map())
  const registerWriter = useCallback((agentId: string, writer: (data: string) => void) => {
    writersRef.current.set(agentId, writer)
    const queued = pendingStdoutRef.current.get(agentId)
    if (queued && queued.length > 0) {
      for (const chunk of queued) writer(chunk)
      pendingStdoutRef.current.delete(agentId)
    }
  }, [])
  const handleStdout = useCallback((data: { agentId: string; data: string }) => {
    const writer = writersRef.current.get(data.agentId)
    if (writer) {
      writer(data.data)
    } else {
      const arr = pendingStdoutRef.current.get(data.agentId) ?? []
      arr.push(data.data)
      pendingStdoutRef.current.set(data.agentId, arr)
    }
  }, [])
  useAgentStdout(handleStdout)

  // Sync tabOrder with agents; fix panes only to remove deleted agents
  // IMPORTANT: Do NOT depend on activeAgentId — that changes on every click and would cause render storms
  useEffect(() => {
    if (!agents) return
    const ids = new Set(agents.map((a) => a.id))

    // A hidden launch agent should join the tab bar only when the user
    // explicitly revealed it via "View launch terminal" (which sets
    // activeAgentId to the launch id). We read activeAgentId at effect
    // time — adding it as a dep would trigger a render storm on every
    // click, and the deliberate "surface on reveal" path always lands
    // here via a task-change refetch anyway.
    const activeAtRun = useAppStore.getState().activeAgentId
    setTabOrder((prev) => {
      const kept = prev.filter((id) => ids.has(id))
      const added = agents
        .filter((a) => {
          if (prev.includes(a.id)) return false
          if (!a.tab_name?.startsWith('▶ ')) return true
          return a.id === activeAtRun
        })
        .map((a) => a.id)
      const next = [...kept, ...added]
      // Only update if actually changed
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev
      return next
    })

    // If we have a pending spawn and it's now in the agent list, show it
    if (pendingSpawnRef.current && ids.has(pendingSpawnRef.current)) {
      const spawnedId = pendingSpawnRef.current
      pendingSpawnRef.current = null
      setPanes([spawnedId])
      setPaneSizes([100])
      setActivePaneIndex(0)
      setActiveAgent(spawnedId)
      return
    }

    // Clean up panes that no longer exist, or restore saved layout for this task
    // NB: the fallback-to-first-agent logic must pick the first *visible*
    // agent, not agents[0] — a hidden launch agent spawned by the sidebar
    // play button would otherwise become the active pane when the user
    // simply selects the task.
    const firstVisible = agents.find((a) => !a.tab_name?.startsWith('▶ '))
    setPanes((prev) => {
      // No (visible) agents for this task — clear panes so launcher shows.
      if (!firstVisible) return []

      if (prev.length === 0 || !prev.some((id) => ids.has(id))) {
        // No valid panes — if the user has an activeAgentId that belongs to
        // the new task list, show THAT agent. This matters when they click
        // a session in the sidebar: selectedTaskId changes, agents refetches,
        // and without this fallback we'd drop them onto agents[0] instead
        // of the session they actually clicked. We read via getState() to
        // avoid adding activeAgentId as a dep (render-storm risk).
        const currentActive = useAppStore.getState().activeAgentId
        if (currentActive && ids.has(currentActive)) {
          return [currentActive]
        }

        // No valid panes — check if we have a saved layout for this task
        const taskId = firstVisible.task_id
        if (taskId) {
          const saved = getPaneLayout(taskId)
          if (saved) {
            const validPanes = saved.panes.filter((id) => ids.has(id))
            if (validPanes.length > 1) {
              setPaneSizes(validPanes.map(() => 100 / validPanes.length))
              return validPanes
            }
          }
        }
        // No saved layout — show the first visible agent
        return [firstVisible.id]
      }
      if (prev.every((id) => ids.has(id))) return prev // nothing to clean
      const cleaned = prev.filter((id) => ids.has(id))
      if (cleaned.length > 0) return cleaned
      return [firstVisible.id]
    })
  }, [agents, setActiveAgent, getPaneLayout])

  // Clicking a session in the *sidebar* only sets activeAgentId — it doesn't
  // go through handleSelectAgent (which lives in the tab bar). Without this
  // effect, activeAgentId would change but the visible pane would stay on
  // whatever it was before, so the user keeps seeing the wrong terminal.
  // The guard (`panes.length === 0 || !panes.includes(activeAgentId)`) makes
  // the effect idempotent — it only fires when the active agent isn't
  // already in the current pane group, so it doesn't fight with manual
  // split selections or create a render loop.
  useEffect(() => {
    if (!activeAgentId || !agents) return
    if (activeAgentId === LAUNCHER_TAB_ID) return
    if (!agents.some((a) => a.id === activeAgentId)) return
    if (panes.includes(activeAgentId)) return
    if (panes.length > 1 && selectedTaskId) {
      savePaneLayout(selectedTaskId, { panes: [...panes], sizes: [...paneSizes] })
    }
    setPanes([activeAgentId])
    setPaneSizes([100])
    setActivePaneIndex(0)
  }, [activeAgentId, agents, panes, paneSizes, selectedTaskId, savePaneLayout])

  // Keep paneSizes in sync with panes count — only update when count actually changes
  const panesCount = panes.length
  useEffect(() => {
    setPaneSizes((prev) => {
      if (prev.length === panesCount) return prev
      return Array.from({ length: panesCount }, () => 100 / panesCount)
    })
  }, [panesCount])

  useEffect(() => {
    if (activePaneIndex >= panesCount && panesCount > 0) setActivePaneIndex(panesCount - 1)
  }, [panesCount, activePaneIndex])

  useEffect(() => { setLauncherOpen(false) }, [selectedTaskId])

  // Listen for global keyboard shortcut events
  useEffect(() => {
    const onNewTab = () => { setLauncherOpen(true); setActiveAgent(LAUNCHER_TAB_ID) }
    const onCloseTab = () => {
      if (isLauncherActive) {
        setLauncherOpen(false)
        if (panes.length > 0) setActiveAgent(panes[Math.min(activePaneIndex, panes.length - 1)])
        else if (visibleAgents.length) setActiveAgent(visibleAgents[visibleAgents.length - 1].id)
        else setActiveAgent(null)
      } else if (activeAgentId && agents) {
        // Don't close pinned tabs with Cmd+W
        if (pinnedTabs.has(activeAgentId)) return
        const agent = agents.find((a) => a.id === activeAgentId)
        if (agent) {
          // handleCloseAgent handles both running (kill tmux) and stopped agents
          handleCloseAgent(agent.id)
        }
      }
    }
    const onEqualize = () => {
      if (panes.length > 1) {
        const equal = panes.map(() => 100 / panes.length)
        setPaneSizes(equal)
        if (selectedTaskId) savePaneLayout(selectedTaskId, { panes: [...panes], sizes: equal })
      }
    }
    window.addEventListener('app:new-tab', onNewTab)
    window.addEventListener('app:close-tab', onCloseTab)
    window.addEventListener('app:equalize-splits', onEqualize)
    return () => {
      window.removeEventListener('app:new-tab', onNewTab)
      window.removeEventListener('app:close-tab', onCloseTab)
      window.removeEventListener('app:equalize-splits', onEqualize)
    }
  })

  const isLauncherActive = launcherOpen && activeAgentId === LAUNCHER_TAB_ID
  // Launcher placeholder should appear when no *visible* sessions exist —
  // a running launch agent behind the scenes shouldn't block it.
  const hasNoAgents = visibleAgents.length === 0
  const showPanes = panes.length > 0 && !isLauncherActive

  // Auto-close tabs when agent exits cleanly (tmux is already dead on the server).
  // We do NOT auto-close on 'error' anymore — otherwise a quick failure (claude
  // not in PATH, missing dep, etc.) makes the tab vanish before the user can
  // read the error output. They can close it manually after reading.
  const autoClosedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!agents) return
    const toClose: string[] = []
    for (const agent of agents) {
      // Chat agents are "paused" when they complete — we keep the tab + DB
      // record around so the user can click back in, see the transcript, and
      // resume the session with --resume. Auto-deleting them would throw away
      // both the history and the session_id.
      const isChat = !!agent.tab_name?.toLowerCase().startsWith('chat')
      if (isChat) continue
      if (agent.status === 'completed' && !autoClosedRef.current.has(agent.id) && !pinnedTabs.has(agent.id)) {
        autoClosedRef.current.add(agent.id)
        toClose.push(agent.id)
      }
    }
    if (toClose.length === 0) return
    const closeSet = new Set(toClose)
    setPanes((prev) => {
      const next = prev.filter((id) => !closeSet.has(id))
      if (next.length === prev.length) return prev // nothing changed
      // If all panes were closed, pick the first remaining *visible*
      // agent — picking a hidden launch agent here would surface it as
      // the focused tab, defeating the whole "run in background" idea.
      if (next.length === 0 && agents.length > toClose.length) {
        const remaining = visibleAgents.find((a) => !closeSet.has(a.id))
        if (remaining) {
          setActiveAgent(remaining.id)
          return [remaining.id]
        }
      }
      // Update active agent to first remaining pane
      if (next.length > 0) setActiveAgent(next[0])
      return next
    })
    for (const id of toClose) {
      deleteAgent.mutate(id)
    }
  }, [agents, deleteAgent])

  /* ---- handlers ---- */

  const handleSelectAgent = (id: string) => {
    setActiveAgent(id)

    // If clicking an agent that's already in the current panes, just focus it
    const idx = panes.indexOf(id)
    if (idx !== -1) {
      setActivePaneIndex(idx)
      return
    }

    // Check if this agent is part of a saved split layout for the current task
    if (selectedTaskId) {
      const saved = getPaneLayout(selectedTaskId)
      if (saved && saved.panes.includes(id)) {
        const agentIds = new Set(agents?.map((a) => a.id) || [])
        const validPanes = saved.panes.filter((pid) => agentIds.has(pid))
        if (validPanes.length > 1 && validPanes.includes(id)) {
          setPanes(validPanes)
          setPaneSizes(saved.sizes.length === validPanes.length ? saved.sizes : validPanes.map(() => 100 / validPanes.length))
          setActivePaneIndex(validPanes.indexOf(id))
          return
        }
      }
    }

    // Switching to a solo tab — save current split if we have one
    if (panes.length > 1 && selectedTaskId) {
      savePaneLayout(selectedTaskId, { panes: [...panes], sizes: [...paneSizes] })
    }

    // Show this agent solo
    setPanes([id])
    setPaneSizes([100])
    setActivePaneIndex(0)
  }

  // Called from TerminalTabs to select the split group tab
  const handleSelectSplitGroup = useCallback(() => {
    if (!selectedTaskId) return
    const saved = getPaneLayout(selectedTaskId)
    if (!saved) return
    const agentIds = new Set(agents?.map((a) => a.id) || [])
    const validPanes = saved.panes.filter((id) => agentIds.has(id))
    if (validPanes.length > 1) {
      setPanes(validPanes)
      setPaneSizes(saved.sizes.length === validPanes.length ? saved.sizes : validPanes.map(() => 100 / validPanes.length))
      setActivePaneIndex(0)
      setActiveAgent(validPanes[0])
    }
  }, [setActiveAgent, selectedTaskId, getPaneLayout, agents])

  // Break a split back into individual tabs
  const handleUnsplit = useCallback(() => {
    if (selectedTaskId) savePaneLayout(selectedTaskId, null)
    if (panes.length > 1) {
      const activeId = panes[activePaneIndex] || panes[0]
      setPanes([activeId])
      setPaneSizes([100])
      setActivePaneIndex(0)
      setActiveAgent(activeId)
    }
  }, [panes, activePaneIndex, setActiveAgent, selectedTaskId, savePaneLayout])

  const [installDialog, setInstallDialog] = useState<{ agentType: string } | null>(null)

  const spawnOnTask = (taskId: string, agentType: string, autoInstall: boolean) => {
    spawnAgent.mutate({ taskId, agentType, autoInstall }, {
      onSuccess: (agent) => {
        // Save current split before switching
        if (panes.length > 1 && selectedTaskId) {
          savePaneLayout(selectedTaskId, { panes: [...panes], sizes: [...paneSizes] })
        }
        pendingSpawnRef.current = agent.id
        setActiveAgent(agent.id)
        setLauncherOpen(false)
        setPanes([agent.id])
        setPaneSizes([100])
        setActivePaneIndex(0)
      },
      onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      onSettled: () => setLaunchingType(null),
    })
  }

  const doSpawn = (agentType: string, autoInstall: boolean = false) => {
    setError(null)
    // If no task is selected but we have an environment, fall back to the
    // protected "general" task (auto-created per env) so the user can launch
    // without an explicit task.
    if (!selectedTaskId) {
      if (!selectedEnvironmentId) { setError('Select an environment first.'); return }
      window.electronAPI.tasks.list(selectedEnvironmentId).then((list) => {
        const tasks = list as Array<{ id: string; is_default?: 0 | 1 }>
        const general = tasks.find((t) => t.is_default === 1)
        if (!general) {
          setError('Missing general task — try recreating the environment.')
          return
        }
        selectTask(general.id, selectedEnvironmentId)
        spawnOnTask(general.id, agentType, autoInstall)
      }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
      return
    }
    spawnOnTask(selectedTaskId, agentType, autoInstall)
  }

  const handleLaunch = async (agentType: string) => {
    if (!selectedTaskId && !selectedEnvironmentId) { setError('Select an environment first.'); return }
    setLaunchingType(agentType)
    if (agentType === 'terminal') { doSpawn(agentType); return }

    // Chat uses the same `claude` binary under the hood but in --print mode —
    // still check it exists so we can suggest the install dialog up-front.
    const binaryToCheck = agentType === 'chat' ? 'claude' : agentType
    if (selectedEnvironmentId) {
      try {
        const { exists } = await window.electronAPI.ssh.checkCommand(selectedEnvironmentId, binaryToCheck) as { exists: boolean }
        if (!exists) {
          setLaunchingType(null)
          setInstallDialog({ agentType })
          return
        }
      } catch { /* try anyway */ }
    }
    doSpawn(agentType)
  }

  const handleNewTab = () => { setLauncherOpen(true); setActiveAgent(LAUNCHER_TAB_ID) }

  const handleCloseLauncher = () => {
    setLauncherOpen(false)
    if (panes.length > 0) setActiveAgent(panes[Math.min(activePaneIndex, panes.length - 1)])
    else if (visibleAgents.length) setActiveAgent(visibleAgents[visibleAgents.length - 1].id)
    else setActiveAgent(null)
  }

  const handleReorderTabs = (fromId: string, toId: string) => {
    setTabOrder((prev) => {
      const next = [...prev]; const fi = next.indexOf(fromId); const ti = next.indexOf(toId)
      if (fi === -1 || ti === -1) return prev; next.splice(fi, 1); next.splice(ti, 0, fromId); return next
    })
  }

  const handleCloseAgent = (id: string) => {
    // Chat sessions carry a persisted transcript + a claude --resume session_id
    // that we'd be throwing away. Ask explicitly so the user doesn't lose a
    // conversation by fat-fingering the x, and — because they confirmed —
    // wipe the server-side record + transcript too (chatDelete does both).
    const agent = agents?.find((a) => a.id === id)
    const isChat = !!agent?.tab_name?.toLowerCase().startsWith('chat')
    if (isChat) {
      const ok = window.confirm(
        'Close this chat and delete its transcript?\n\nYou will NOT be able to resume this conversation — the session ID and every message will be removed from Alby. Open a new chat if you want to start fresh.',
      )
      if (!ok) return
    }

    setPanes((prev) => {
      const idx = prev.indexOf(id)
      if (idx === -1) return prev
      const next = prev.filter((p) => p !== id)
      if (next.length > 0) {
        // Select the nearest remaining pane
        const newIdx = Math.min(activePaneIndex, next.length - 1)
        setActivePaneIndex(newIdx)
        setActiveAgent(next[newIdx])
      } else {
        // No panes left — pick another agent or show launcher
        const remaining = agents?.filter((a) => a.id !== id)
        if (remaining && remaining.length > 0) {
          setActiveAgent(remaining[0].id)
        } else {
          setActiveAgent(null)
        }
      }
      return next
    })
    // Also remove from saved split layout
    if (selectedTaskId) {
      const saved = getPaneLayout(selectedTaskId)
      if (saved) {
        const remaining = saved.panes.filter((p) => p !== id)
        savePaneLayout(selectedTaskId, remaining.length > 1 ? { panes: remaining, sizes: remaining.map(() => 100 / remaining.length) } : null)
      }
    }

    if (isChat) {
      // Chat path: chatDelete wipes transcript + record on server; no tmux
      // session to kill so skip the regular path.
      window.electronAPI.agents.chatDelete(id).catch(() => { /* best effort */ })
    } else {
      // Kill the tmux session on the remote server first, then delete the record
      killAgent.mutate(id)
    }
  }

  const handleClosePane = (paneIdx: number) => {
    setPanes((prev) => {
      if (prev.length <= 1) return prev
      const next = prev.filter((_, i) => i !== paneIdx)
      if (activePaneIndex >= next.length) setActivePaneIndex(next.length - 1)
      return next
    })
  }

  /* ---- drag into content area (split panes) ---- */

  const handlePaneDragOver = (e: React.DragEvent, paneIdx: number) => {
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'
    setDragTargetPane(paneIdx)
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    if (panes.length < MAX_PANES && x < 0.25) setDragTargetSide('left')
    else if (panes.length < MAX_PANES && x > 0.75) setDragTargetSide('right')
    else setDragTargetSide('center')
  }

  const handlePaneDrop = (e: React.DragEvent, paneIdx: number) => {
    e.preventDefault(); e.stopPropagation()
    const agentId = e.dataTransfer.getData('text/plain')
    if (!agentId) return

    // Compute new panes
    const without = panes.filter((p) => p !== agentId)
    const adj = Math.min(paneIdx, Math.max(0, without.length - 1))
    let newPanes: string[]
    let newActiveIdx: number

    if (dragTargetSide === 'left') {
      newPanes = [...without]; newPanes.splice(Math.max(0, adj), 0, agentId)
      newActiveIdx = Math.max(0, adj)
    } else if (dragTargetSide === 'right') {
      newPanes = [...without]; const ins = adj + 1; newPanes.splice(ins, 0, agentId)
      newActiveIdx = ins
    } else {
      newPanes = without.length > 0 ? [...without] : []
      if (adj >= 0 && adj < newPanes.length) newPanes[adj] = agentId; else newPanes.push(agentId)
      newActiveIdx = adj >= 0 ? adj : 0
    }
    newPanes = newPanes.slice(0, MAX_PANES)
    const newSizes = Array(newPanes.length).fill(100 / newPanes.length)

    setPanes(newPanes)
    setPaneSizes(newSizes)
    setActivePaneIndex(newActiveIdx)
    setActiveAgent(agentId)

    // Persist the split layout
    if (selectedTaskId && newPanes.length > 1) {
      savePaneLayout(selectedTaskId, { panes: newPanes, sizes: newSizes })
    }

    // CRITICAL: reset drag state here — the dragged tab may be removed from DOM by the
    // split grouping re-render, which prevents dragEnd from firing and leaves isDragging=true.
    setIsDragging(false); setDragTargetPane(null); setDragTargetSide(null)
  }

  const handlePaneDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragTargetPane(null); setDragTargetSide(null)
  }

  /* ---- resizable dividers ---- */

  const contentRef = useRef<HTMLDivElement>(null)
  const paneSizesRef = useRef(paneSizes)
  paneSizesRef.current = paneSizes

  const handleDividerMouseDown = useCallback((e: React.MouseEvent, dividerIdx: number) => {
    e.preventDefault()
    const startX = e.clientX
    const startSizes = [...paneSizesRef.current]

    const handleMouseMove = (ev: MouseEvent) => {
      if (!contentRef.current) return
      const containerWidth = contentRef.current.getBoundingClientRect().width
      const deltaPct = ((ev.clientX - startX) / containerWidth) * 100

      const leftNew = startSizes[dividerIdx] + deltaPct
      const rightNew = startSizes[dividerIdx + 1] - deltaPct

      if (leftNew >= MIN_PANE_PCT && rightNew >= MIN_PANE_PCT) {
        const newSizes = [...startSizes]
        newSizes[dividerIdx] = leftNew
        newSizes[dividerIdx + 1] = rightNew
        setPaneSizes(newSizes)
      }
    }

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // Persist the new sizes
      const taskId = useAppStore.getState().selectedTaskId
      if (taskId) {
        const currentPanes = paneSizesRef.current
        savePaneLayout(taskId, { panes: [...panes], sizes: [...currentPanes] })
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  // Compute cumulative left offsets and widths from paneSizes
  const paneLayouts = useMemo(() => {
    const layouts: { left: number; width: number }[] = []
    let cumulative = 0
    for (const size of paneSizes) {
      layouts.push({ left: cumulative, width: size })
      cumulative += size
    }
    return layouts
  }, [paneSizes])

  /* ---- render ---- */

  // Settings views take precedence over everything: they are modal-like views
  // that replace the main content until the user closes them.
  const editingProjectSettingsId = useAppStore((s) => s.editingProjectSettingsId)
  const editingTaskSettingsId = useAppStore((s) => s.editingTaskSettingsId)
  const editingRoutineSettingsId = useAppStore((s) => s.editingRoutineSettingsId)
  const editingTeamSettingsId = useAppStore((s) => s.editingTeamSettingsId)
  const addingEnvironmentForProjectId = useAppStore((s) => s.addingEnvironmentForProjectId)
  const editingEnvironmentId = useAppStore((s) => s.editingEnvironmentId)
  const editingStackId = useAppStore((s) => s.editingStackId)
  const addingStackForProjectId = useAppStore((s) => s.addingStackForProjectId)
  const activityProjectId = useAppStore((s) => s.activityProjectId)
  const issuesProjectId = useAppStore((s) => s.issuesProjectId)
  const issuesStackId = useAppStore((s) => s.issuesStackId)
  const appsProjectId = useAppStore((s) => s.appsProjectId)
  const selectedIssueId = useAppStore((s) => s.selectedIssueId)
  const showAllProjects = useAppStore((s) => s.showAllProjects)
  const selectedStackId = useAppStore((s) => s.selectedStackId)
  const perms = useWorkspaceRole()
  const settingsFallback = (
    <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-400 text-sm p-4 text-center">
      Something went wrong opening these settings. Close and try again.
    </div>
  )
  // Settings views take precedence over the All Projects panel — clicking the
  // gear from inside All Projects opens the settings on top, and closing the
  // settings drops the user back into All Projects (which stays mounted in
  // store state).
  // Settings views always take precedence over the All Projects / All Workspaces
  // panels — clicking the gear from inside one of them opens the corresponding
  // settings on top, and closing them drops the user back into the panel
  // (which stays mounted in store state).
  if (addingEnvironmentForProjectId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <AddEnvironmentView projectId={addingEnvironmentForProjectId} />
      </ErrorBoundary>
    )
  }
  if (editingEnvironmentId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <EditEnvironmentView environmentId={editingEnvironmentId} />
      </ErrorBoundary>
    )
  }
  if (addingStackForProjectId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <AddStackView projectId={addingStackForProjectId} />
      </ErrorBoundary>
    )
  }
  if (editingStackId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <EditStackView stackId={editingStackId} />
      </ErrorBoundary>
    )
  }
  if (editingProjectSettingsId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <ProjectSettingsView projectId={editingProjectSettingsId} />
      </ErrorBoundary>
    )
  }
  if (editingTeamSettingsId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <TeamSettingsView teamId={editingTeamSettingsId} />
      </ErrorBoundary>
    )
  }
  if (editingTaskSettingsId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <TaskSettingsView taskId={editingTaskSettingsId} />
      </ErrorBoundary>
    )
  }
  if (editingRoutineSettingsId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <RoutineSettingsView routineId={editingRoutineSettingsId} />
      </ErrorBoundary>
    )
  }
  if (activityProjectId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <ActivityView projectId={activityProjectId} />
      </ErrorBoundary>
    )
  }
  if (selectedIssueId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <IssueDetailView issueId={selectedIssueId} />
      </ErrorBoundary>
    )
  }
  if (issuesProjectId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <IssuesListView projectId={issuesProjectId} stackId={issuesStackId} />
      </ErrorBoundary>
    )
  }
  if (appsProjectId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <AppsSettingsView projectId={appsProjectId} />
      </ErrorBoundary>
    )
  }
  if (showAllProjects) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <AllProjectsView />
      </ErrorBoundary>
    )
  }

  // Stack focus (no env/task/routine): show the per-stack tab view
  // (Overview · Issues · Tasks · Settings). Clicking any env/session in the
  // sidebar or an env card on the Overview drops this selection.
  if (selectedStackId && !selectedEnvironmentId && !selectedTaskId && !selectedRoutineId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <StackTabsView stackId={selectedStackId} />
      </ErrorBoundary>
    )
  }

  // Env focus (no task selected): full-page env tabs. For deploy envs this
  // shows Deploy/Terminals/Settings; operational envs get Overview/Sessions/
  // Files/Routines/Settings. The Deploy tab embeds the legacy DeployView.
  if (selectedEnvironmentId && !selectedTaskId && !selectedRoutineId) {
    return (
      <ErrorBoundary fallback={settingsFallback}>
        <EnvTabsView environmentId={selectedEnvironmentId} />
      </ErrorBoundary>
    )
  }

  // Routines take precedence over tasks — rendered in a dedicated view that
  // manages its own lifecycle (start/stop tmux session) without touching the
  // agent pane machinery below.
  if (selectedRoutineId) {
    return <RoutineView routineId={selectedRoutineId} />
  }

  if (!selectedTaskId) {
    // Nothing selected — guide the user back to the sidebar.
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
        <div className="text-center">
          <p className="text-lg mb-2">Select a stack or environment</p>
          <p className="text-sm">Click a stack or environment from the sidebar to get started</p>
        </div>
      </div>
    )
  }

  // Expose saved split info to TerminalTabs
  const savedSplit = selectedTaskId ? getPaneLayout(selectedTaskId) : null

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
      {error && (
        <div className="px-4 py-2 bg-red-900/50 border-b border-red-700 text-red-200 text-sm flex items-center justify-between">
          <span>Error: {error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200 ml-2">x</button>
        </div>
      )}

      <TerminalTabs
        agents={visibleAgents} tabOrder={tabOrder} panes={panes} activePaneIndex={activePaneIndex}
        agentActivities={activities} onSelectAgent={handleSelectAgent}
        onKillAgent={(id) => killAgent.mutate(id)} onCloseAgent={handleCloseAgent}
        onNewAgent={handleNewTab} onReorderTabs={handleReorderTabs}
        onDragStart={() => setIsDragging(true)} onDragEnd={() => { setIsDragging(false); setDragTargetPane(null); setDragTargetSide(null) }}
        isSpawning={spawnAgent.isPending} launcherOpen={launcherOpen} isLauncherActive={isLauncherActive}
        onSelectLauncher={() => setActiveAgent(LAUNCHER_TAB_ID)} onCloseLauncher={handleCloseLauncher}
        savedSplit={savedSplit} onSelectSplitGroup={handleSelectSplitGroup} onUnsplit={handleUnsplit}
      />

      <div ref={contentRef} style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        {allAgents?.map((agent) => {
          const paneIdx = showPanes ? panes.indexOf(agent.id) : -1
          const isVisible = paneIdx !== -1

          const style: React.CSSProperties = isVisible
            ? { left: `${paneLayouts[paneIdx]?.left ?? 0}%`, width: `${paneLayouts[paneIdx]?.width ?? 100}%`, zIndex: 2 }
            : { left: 0, width: '100%', zIndex: -1, pointerEvents: 'none' }

          return (
            <div
              key={agent.id}
              className="absolute top-0 bottom-0 overflow-hidden"
              style={style}
              onClick={isVisible ? () => { setActivePaneIndex(paneIdx); setActiveAgent(agent.id) } : undefined}
            >
              <ErrorBoundary>
                {agent.tab_name?.toLowerCase().startsWith('chat') ? (
                  <ChatPanel agentId={agent.id} visible={isVisible} />
                ) : (
                  <TerminalPanel agentId={agent.id} registerWriter={registerWriter} visible={isVisible} />
                )}
              </ErrorBoundary>
            </div>
          )
        })}

        {/* Pane decorators */}
        {showPanes && panes.length > 1 && panes.map((_, idx) => (
          <div key={`decor-${idx}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${paneLayouts[idx]?.left ?? 0}%`, width: `${paneLayouts[idx]?.width ?? 0}%`, zIndex: 5 }}>
            <div className={`absolute top-0 left-0 right-0 h-[2px] ${idx === activePaneIndex ? 'bg-blue-500' : 'bg-transparent'}`} />
            <div className="absolute top-0 right-0 p-1 pointer-events-auto">
              <button onClick={() => handleClosePane(idx)}
                className="w-5 h-5 flex items-center justify-center rounded text-[10px] text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800 transition-colors" title="Close split">x</button>
            </div>
          </div>
        ))}

        {/* Resizable dividers between panes */}
        {showPanes && panes.length > 1 && panes.slice(1).map((_, idx) => {
          const dividerLeft = paneLayouts[idx + 1]?.left ?? 0
          return (
            <div
              key={`divider-${idx}`}
              className="absolute top-0 bottom-0 pointer-events-auto cursor-col-resize group"
              style={{ left: `calc(${dividerLeft}% - 3px)`, width: '7px', zIndex: 8 }}
              onMouseDown={(e) => handleDividerMouseDown(e, idx)}
            >
              <div className="absolute left-[3px] top-0 bottom-0 w-px bg-[var(--border-color)] group-hover:bg-blue-500 transition-colors" />
            </div>
          )
        })}

        {/* Drop zones — only during drag */}
        {isDragging && showPanes && panes.map((_, idx) => (
          <div key={`drop-${idx}`} className="absolute top-0 bottom-0" style={{ left: `${paneLayouts[idx]?.left ?? 0}%`, width: `${paneLayouts[idx]?.width ?? 0}%`, zIndex: 15 }}
            onDragOver={(e) => handlePaneDragOver(e, idx)} onDrop={(e) => handlePaneDrop(e, idx)} onDragLeave={handlePaneDragLeave}>
            {dragTargetPane === idx && dragTargetSide && (
              <div className="absolute inset-0 pointer-events-none">
                {dragTargetSide === 'left' && <div className="absolute inset-y-0 left-0 w-1/2 bg-blue-500/10 border-2 border-blue-500/40 rounded-l" />}
                {dragTargetSide === 'right' && <div className="absolute inset-y-0 right-0 w-1/2 bg-blue-500/10 border-2 border-blue-500/40 rounded-r" />}
                {dragTargetSide === 'center' && <div className="absolute inset-0 bg-neutral-500/10 border-2 border-neutral-400/30 rounded" />}
              </div>
            )}
          </div>
        ))}

        {(isLauncherActive || (hasNoAgents && panes.length === 0)) && (
          <div className="absolute inset-0" style={{ zIndex: 10 }}>
            <AgentLaunchGrid agentSettings={environment?.agent_settings ?? null} onLaunch={handleLaunch} isSpawning={spawnAgent.isPending} canLaunch={perms.canLaunchAgents} />
          </div>
        )}

        {panes.length === 0 && !hasNoAgents && !isLauncherActive && (
          <div className="absolute inset-0 flex items-center justify-center text-neutral-500 text-sm" style={{ zIndex: 10 }}>Click a tab to view</div>
        )}

        {launchingType && <LaunchingOverlay agentType={launchingType} />}
      </div>

      {installDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={() => setInstallDialog(null)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[420px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 mb-3">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: (AGENT_META[installDialog.agentType]?.color || '#888') + '20' }}>
                {AGENT_META[installDialog.agentType]?.icon || null}
              </div>
              <div className="text-[15px] font-semibold text-neutral-50">
                {AGENT_META[installDialog.agentType]?.name || installDialog.agentType} not installed
              </div>
            </div>
            <p className="text-[13px] text-neutral-400 mb-4">
              <span className="text-neutral-200 font-medium">{installDialog.agentType}</span>{' '}
              {environment?.execution_mode === 'remote'
                ? 'was not found on the remote server.'
                : 'was not found on this Mac.'}
              {' '}Would you like to install it automatically?
            </p>
            <div className="bg-neutral-950 rounded-lg px-3 py-2 mb-4 text-[12px] font-mono text-neutral-500">
              $ npm install -g {installDialog.agentType === 'claude' || installDialog.agentType === 'chat' ? '@anthropic-ai/claude-code' : installDialog.agentType === 'gemini' ? '@google/gemini-cli' : installDialog.agentType === 'codex' ? '@openai/codex' : installDialog.agentType}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setInstallDialog(null)}
                className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors">
                Cancel
              </button>
              <button onClick={() => { doSpawn(installDialog.agentType, true); setInstallDialog(null) }}
                className="h-8 px-4 rounded-lg text-[13px] text-white bg-blue-600 hover:bg-blue-500 transition-colors">
                Install & Launch
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
