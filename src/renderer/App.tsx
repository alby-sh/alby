import { useEffect, useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Sidebar } from './components/layout/Sidebar'
import { IconNavSidebar } from './components/layout/IconNavSidebar'
import { TopBar } from './components/layout/TopBar'
import { MainArea } from './components/layout/MainArea'
import { LoginScreen } from './components/auth/LoginScreen'
import { ToastStack } from './components/ui/ToastStack'
import { useAppStore } from './stores/app-store'
import { useActivityStore } from './stores/activity-store'
import { useConnectionStore } from './stores/connection-store'
import { useAuthStore } from './stores/auth-store'
import { subscribeToProject, useSyncBootstrap } from './stores/sync-store'
import { usePresenceSubscriptions } from './stores/presence-store'
import { useOnlineBootstrap, useOnlineStore } from './stores/online-store'
import { useAllProjects } from './hooks/useProjects'
import { useAgentHeartbeats } from './hooks/useAgentHeartbeats'
import { useMyNotificationSubs } from './hooks/useIssues'
import type { Agent } from '../shared/types'

let _audioCtx: AudioContext | null = null
function getAudioContext(): AudioContext {
  if (!_audioCtx) _audioCtx = new AudioContext()
  return _audioCtx
}

function playCompletionSound() {
  try {
    const ctx = getAudioContext()
    const now = ctx.currentTime
    const notes = [880, 1174.66]
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.15, now + i * 0.15)
      gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.15 + 0.4)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.15)
      osc.stop(now + i * 0.15 + 0.4)
    })
  } catch { /* ignore */ }
}

function showNotification(title: string, body: string, onClick?: () => void) {
  try {
    const send = () => {
      const n = new Notification(title, { body })
      if (onClick) n.onclick = onClick
    }
    if (Notification.permission === 'granted') {
      send()
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') send()
      })
    }
  } catch { /* ignore */ }
}

/**
 * Resolve an issue UUID into the project it belongs to and navigate the UI
 * to its detail view. Used by the `alby://issues/<uuid>` deep-link flow.
 * The issue→project lookup goes through `issues:get`, which the backend
 * echoes `app.project_id` on specifically for this use case.
 */
async function openIssueById(issueId: string): Promise<void> {
  try {
    const detail = await window.electronAPI.issues.get(issueId)
    const projectId = detail?.app?.project_id ?? null
    const store = useAppStore.getState()
    if (projectId) {
      if (!store.expandedProjects.has(projectId)) {
        store.toggleProjectExpanded(projectId)
      }
      store.selectProject(projectId)
      store.openIssues(projectId)
    }
    store.openIssueDetail(issueId)
  } catch (err) {
    console.error('[deep-link] Failed to open issue:', err)
  }
}

export default function App() {
  const initialized = useAppStore((s) => s.initialized)
  const init = useAppStore((s) => s.init)
  const authInitialized = useAuthStore((s) => s.initialized)
  const authUser = useAuthStore((s) => s.user)
  const authInit = useAuthStore((s) => s.init)
  // Holds a deep-link issue id that arrived while the user wasn't logged in,
  // so we can replay it after login. A single slot is enough — only the
  // latest click matters.
  const pendingDeepLinkIssue = useRef<string | null>(null)
  const showAllProjects = useAppStore((s) => s.showAllProjects)
  useEffect(() => { authInit() }, [authInit])

  // Wire up Reverb WebSocket: connect when logged in, subscribe to user + team
  // channels automatically. Project channels are added lazily below.
  useSyncBootstrap()
  // Join presence channels for the currently-viewed agent / routine so the
  // sidebar can show who else is looking at the same thing in real time.
  usePresenceSubscriptions()
  // Track online/offline state for the offline-mode banner.
  useOnlineBootstrap()
  // Send working/viewed time deltas to the cloud every 30 s for reporting.
  useAgentHeartbeats()
  // Keep the user's "which apps should push-notify me" preferences in cache
  // — sync-store reads this on every incoming issue event to decide whether
  // to fire a native desktop notification.
  useMyNotificationSubs()
  const online = useOnlineStore((s) => s.online)
  const { data: projects } = useAllProjects()
  useEffect(() => {
    if (!projects || !authUser) return
    for (const p of projects) subscribeToProject(p.id)
  }, [projects, authUser])
  const setActivity = useActivityStore((s) => s.setActivity)
  const removeActivity = useActivityStore((s) => s.removeActivity)
  const queryClient = useQueryClient()

  // Track previous activity per agent to detect working→idle transitions
  const prevActivities = useRef<Map<string, string>>(new Map())

  // Global keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey
      if (!meta) return

      // Cmd+T → new tab (launch session)
      if (e.key === 't' && !e.shiftKey) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('app:new-tab'))
      }
      // Cmd+W → close active tab
      if (e.key === 'w' && !e.shiftKey) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('app:close-tab'))
      }
      // Cmd+Shift+0 → equalize splits
      if (e.key === '0' && e.shiftKey) {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('app:equalize-splits'))
      }
      // Cmd+K → open All Projects (search)
      if (e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault()
        useAppStore.getState().openAllProjects()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => { init() }, [init])

  // Deep-link plumbing for `alby://issues/<uuid>`. The main process queues
  // URLs that arrive before the renderer is listening (cold-start argv on
  // Win/Linux, pre-load open-url on macOS) — we drain that queue once on
  // mount, then subscribe for URLs that arrive while the app is running.
  // When the user isn't logged in we stash the issue id and replay it from
  // a second effect below once auth resolves.
  useEffect(() => {
    const route = (issueId: string) => {
      if (!useAuthStore.getState().user) {
        pendingDeepLinkIssue.current = issueId
      } else {
        openIssueById(issueId)
      }
    }
    const unsub = window.electronAPI.deepLink.onIssueOpen(({ issueId }) => route(issueId))
    window.electronAPI.deepLink.consumePending()
      .then((pending) => {
        // Only the last click matters — if the user queued multiple, they
        // meant the most recent one. Drop the rest silently.
        if (pending.length > 0) route(pending[pending.length - 1].issueId)
      })
      .catch(() => { /* ignore */ })
    // Agent-finish notification clicks: same navigation shape as issue deep
    // links, but anchored on an agent id. Select the project (which opens
    // the secondary sidebar) then the specific session so the user lands
    // on the output they were notified about.
    const unsubAgent = window.electronAPI.notifications.onAgentClick(({ agentId, projectId }) => {
      const store = useAppStore.getState()
      if (!store.expandedProjects.has(projectId)) {
        store.toggleProjectExpanded(projectId)
      }
      store.selectProject(projectId)
      store.setActiveAgent(agentId)
    })
    return () => { unsub(); unsubAgent() }
  }, [])

  useEffect(() => {
    if (authUser && pendingDeepLinkIssue.current) {
      const id = pendingDeepLinkIssue.current
      pendingDeepLinkIssue.current = null
      openIssueById(id)
    }
  }, [authUser])

  const selectTask = useAppStore((s) => s.selectTask)
  const setActiveAgentStore = useAppStore((s) => s.setActiveAgent)
  const toggleProjectExpanded = useAppStore((s) => s.toggleProjectExpanded)

  // Listen for agent activity changes — sound + notification on working→idle
  useEffect(() => {
    const unsub = window.electronAPI.agents.onActivity(
      (data: { agentId: string; activity: string }) => {
        const prev = prevActivities.current.get(data.agentId)
        prevActivities.current.set(data.agentId, data.activity)

        setActivity(data.agentId, data.activity as 'idle' | 'working')

        // Agent finished working (working → idle)
        if (prev === 'working' && data.activity === 'idle') {
          playCompletionSound()

          // Fetch full context (project, environment, agent name) for the notification
          window.electronAPI.agents.getContext(data.agentId).then((ctx: { agentName: string; taskId: string; environmentId: string; environmentName: string; projectId: string; projectName: string } | null) => {
            const name = ctx?.agentName || 'Agent'
            const project = ctx?.projectName || ''
            const env = ctx?.environmentName || ''
            const subtitle = [project, env].filter(Boolean).join(' / ')

            showNotification(
              `${name} has finished`,
              subtitle
                ? `${subtitle} — ${name} is ready for your next instruction.`
                : `${name} is ready for your next instruction.`,
              () => {
                if (ctx) {
                  // Expand the project if collapsed
                  if (!useAppStore.getState().expandedProjects.has(ctx.projectId)) {
                    toggleProjectExpanded(ctx.projectId)
                  }
                  selectTask(ctx.taskId, ctx.environmentId)
                  setActiveAgentStore(data.agentId)
                }
                window.focus()
              }
            )
          }).catch(() => {
            showNotification('Agent has finished', 'An agent is ready for your next instruction.')
          })
        }
      }
    )
    return unsub
  }, [setActivity, selectTask, setActiveAgentStore, toggleProjectExpanded])

  // Listen for agent status changes (process exit — just update queries, no sound)
  const handleStatusChange = useCallback(
    (data: { agentId: string; status: string; exitCode?: number }) => {
      if (data.status === 'completed' || data.status === 'error') {
        removeActivity(data.agentId)
        prevActivities.current.delete(data.agentId)
      }
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents-all'] })
    },
    [removeActivity, queryClient]
  )

  useEffect(() => {
    const unsub = window.electronAPI.agents.onStatusChange(handleStatusChange)
    return unsub
  }, [handleStatusChange])

  useEffect(() => {
    const unsub = window.electronAPI.agents.onDeleted(() => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['agents-all'] })
    })
    return unsub
  }, [queryClient])

  // Auto-reconnect SSH when network comes back or laptop wakes from sleep
  const setConnectionStatus = useConnectionStore((s) => s.setStatus)

  useEffect(() => {
    // Listen for SSH connection status changes from main process
    const unsub = window.electronAPI.ssh.onConnectionStatusChanged((data) => {
      setConnectionStatus(data.envId, data.connected ? 'connected' : 'disconnected')
    })
    return unsub
  }, [setConnectionStatus])

  useEffect(() => {
    // When browser goes back online, tell main process to reconnect all SSH
    const handleOnline = () => {
      console.log('[App] Network online — triggering SSH reconnect')
      window.electronAPI.ssh.reconnectAll()
    }
    // When app becomes visible again (e.g. after sleep/lid close), trigger reconnect
    let lastHidden = 0
    const handleVisibility = () => {
      if (document.hidden) {
        lastHidden = Date.now()
      } else if (lastHidden > 0 && Date.now() - lastHidden > 30000) {
        // Was hidden for >30 seconds — connections are likely dead
        console.log('[App] App visible after long sleep — triggering SSH reconnect')
        window.electronAPI.ssh.reconnectAll()
      }
    }
    window.addEventListener('online', handleOnline)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  if (!initialized || !authInitialized) {
    return (
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="bg-[var(--bg-primary)] text-[var(--text-secondary)]">
        Loading...
      </div>
    )
  }

  if (!authUser) {
    return <LoginScreen />
  }

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column' }} className="bg-[var(--bg-primary)]">
      <TopBar />
      {!online && (
        <div className="h-7 shrink-0 flex items-center justify-center gap-2 text-[11px] bg-amber-900/40 border-b border-amber-900/60 text-amber-200">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          Offline — cloud projects are read-only. Local environments keep working.
        </div>
      )}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <IconNavSidebar />
        {!showAllProjects && <Sidebar />}
        <MainArea />
      </div>
      <ToastStack />
    </div>
  )
}
