import { create } from 'zustand'
import Pusher, { type Channel } from 'pusher-js'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useAuthStore } from './auth-store'
import { useUnreadStore } from './unread-store'
import { useAppStore } from './app-store'

/** Extract the projectId from a private-project.<id> Reverb channel name.
 *  Returns null for user/team channels so the unread tracker stays project-scoped. */
function projectIdFromChannelName(channelName: string): string | null {
  const m = /^private-project\.(.+)$/.exec(channelName)
  return m ? m[1] : null
}

type UnreadReason =
  | 'issue.created'
  | 'issue.regression'
  | 'agent.finished'
  | 'agent.activity'
  | 'chat.reply'
  | 'task.updated'
  | 'routine.finished'

/** Mark unread for `projectId` UNLESS the user is currently on that project —
 *  no point nagging them about something they're already looking at. */
function markUnreadIfAway(projectId: string | null, reason: UnreadReason): void {
  if (!projectId) return
  const currentProject = useAppStore.getState().selectedProjectId
  if (currentProject === projectId) return
  useUnreadStore.getState().mark(projectId, reason)
}
import {
  REVERB_KEY,
  REVERB_HOST,
  REVERB_PORT,
  REVERB_SCHEME,
  BROADCASTING_AUTH_URL,
} from '../../shared/cloud-constants'

type EntityType = 'project' | 'environment' | 'task' | 'agent' | 'routine' | 'team' | 'member' | 'issue'
type Action = 'created' | 'updated' | 'deleted'

interface EntityChangedPayload {
  entity: EntityType
  action: Action
  id: string
  payload?: Record<string, unknown>
}

interface SyncState {
  connected: boolean
  _pusher: Pusher | null
  _channels: Map<string, Channel>
  _qc: QueryClient | null
  attach: (qc: QueryClient) => void
  subscribeUser: (userId: number) => void
  subscribeTeams: (teamIds: string[]) => void
  subscribeProjects: (projectIds: string[]) => void
  disconnect: () => void
}

export const useSyncStore = create<SyncState>((set, get) => ({
  connected: false,
  _pusher: null,
  _channels: new Map(),
  _qc: null,

  attach: (qc) => set({ _qc: qc }),

  subscribeUser: (userId: number) => {
    const state = get()

    // Grab the current Sanctum token so the authorizer can sign channel auth.
    window.electronAPI.auth.current().then((data) => {
      if (!data?.token) return

      let pusher = state._pusher
      if (!pusher) {
        pusher = new Pusher(REVERB_KEY, {
          wsHost: REVERB_HOST,
          wssPort: REVERB_PORT,
          wsPort: REVERB_PORT,
          forceTLS: REVERB_SCHEME === 'https',
          enabledTransports: ['ws', 'wss'],
          cluster: 'mt1', // required by pusher-js but ignored by Reverb
          authorizer: (channel) => ({
            authorize: (socketId, callback) => {
              fetch(BROADCASTING_AUTH_URL, {
                method: 'POST',
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/x-www-form-urlencoded',
                  Authorization: `Bearer ${data.token}`,
                },
                body: new URLSearchParams({ socket_id: socketId, channel_name: channel.name }).toString(),
              })
                .then(async (res) => {
                  if (!res.ok) throw new Error(`auth ${res.status}`)
                  const authData = await res.json()
                  callback(null, authData)
                })
                .catch((err) => callback(err as Error, null as unknown as { auth: string }))
            },
          }),
        })

        pusher.connection.bind('connected', () => { set({ connected: true }); console.log('[sync] connected') })
        pusher.connection.bind('disconnected', () => { set({ connected: false }); console.log('[sync] disconnected') })
        pusher.connection.bind('error', (err: unknown) => { console.warn('[sync] error:', err) })

        set({ _pusher: pusher })
      }

      subscribeOnce(get, set, pusher, `private-user.${userId}`)
    })
  },

  subscribeTeams: (teamIds) => {
    const pusher = get()._pusher
    if (!pusher) return
    teamIds.forEach((id) => subscribeOnce(get, set, pusher, `private-team.${id}`))
  },

  subscribeProjects: (projectIds) => {
    const pusher = get()._pusher
    if (!pusher) return
    projectIds.forEach((id) => subscribeOnce(get, set, pusher, `private-project.${id}`))
  },

  disconnect: () => {
    const { _pusher, _channels } = get()
    _channels.forEach((c) => { try { c.unbind_all(); _pusher?.unsubscribe(c.name) } catch { /* ignore */ } })
    _pusher?.disconnect()
    set({ _pusher: null, _channels: new Map(), connected: false })
  },
}))

function subscribeOnce(
  get: () => SyncState,
  set: (partial: Partial<SyncState>) => void,
  pusher: Pusher,
  channelName: string
): void {
  const existing = get()._channels.get(channelName)
  if (existing) return

  const channel = pusher.subscribe(channelName)
  const projectId = projectIdFromChannelName(channelName)
  channel.bind('entity.changed', (payload: EntityChangedPayload) => {
    handleEntityChanged(get()._qc, payload, projectId)
  })

  // Error-tracking live events. Only project channels fire these; user channels ignore them.
  if (channelName.startsWith('private-project.')) {
    channel.bind('issue.created',   (p: IssueLivePayload) => handleIssueLive(get()._qc, 'issue.created', p, projectId))
    channel.bind('issue.regression',(p: IssueLivePayload) => handleIssueLive(get()._qc, 'issue.regression', p, projectId))
    channel.bind('issue.new_event', (p: IssueLivePayload) => handleIssueLive(get()._qc, 'issue.new_event', p, projectId))
    channel.bind('issue.auto_fix_requested', (p: AutoFixPayload) => handleAutoFixRequested(p))
  }

  const next = new Map(get()._channels)
  next.set(channelName, channel)
  set({ _channels: next })
}

interface IssueLivePayload {
  issue_id: string
  app_id: string
  event_id: string
  title?: string
  level?: string
  status?: string
  occurrences_count?: number
  last_seen_at?: string | null
}

interface AutoFixPayload {
  project_id: string
  task_id: string
  environment_id: string
  issue_id: string
  agent_type: 'claude' | 'gemini' | 'codex'
}

function handleIssueLive(
  qc: QueryClient | null,
  name: string,
  payload: IssueLivePayload,
  projectId: string | null,
): void {
  if (!qc) return
  console.log('[sync] issue event:', name, payload.issue_id)
  // Invalidate issue lists for the affected app + detail for this specific issue.
  qc.invalidateQueries({ queryKey: ['issues', payload.app_id] })
  qc.invalidateQueries({ queryKey: ['issue', payload.issue_id] })
  qc.invalidateQueries({ queryKey: ['issues-open-counts'] })

  // Desktop notification for NEW issues + regressions — not for every follow-up
  // event of the same issue, which would be noisy on a broken prod deploy.
  if (name === 'issue.created' || name === 'issue.regression') {
    notifyIssue(name, payload)
    markUnreadIfAway(
      projectId,
      name === 'issue.regression' ? 'issue.regression' : 'issue.created',
    )
  }
}

// Native desktop notification via the main-process Electron Notification
// API (exposed through preload as electronAPI.notifications.issue). We
// delegate instead of using the DOM `new Notification(...)` because:
//   - DOM needs a permission grant; the very first event triggers the dialog
//     and gets swallowed in the process (permission !== 'granted' at that
//     instant), so the user's first test shows nothing.
//   - DOM-side silently no-ops in Electron when devtools aren't open in some
//     specific minor versions.
//   - We'd have to focus-gate to avoid spam, but the focus-gate itself hides
//     the alert when the user is sitting in front of the app testing.
// The main-process Notification is unconditional, permission-free for
// signed/notarized apps, and always hits Notification Center even when the
// user is looking at Alby.
function notifyIssue(name: string, payload: IssueLivePayload): void {
  const title =
    name === 'issue.regression'
      ? 'Alby · Issue regressed'
      : 'Alby · New issue'
  const levelTag =
    payload.level && payload.level !== 'error' ? ` [${payload.level.toUpperCase()}]` : ''
  const body = (payload.title ?? 'Unknown issue') + levelTag
  try {
    const api = (window as unknown as {
      electronAPI?: { notifications?: { issue?: (p: { title: string; body: string; tag?: string }) => void } }
    }).electronAPI
    api?.notifications?.issue?.({ title, body, tag: `alby-issue-${payload.issue_id}` })
  } catch (err) {
    console.warn('[sync] notification failed:', err)
  }
}

/**
 * Auto-fix arrival: the backend has pre-created a Task tied to the user's
 * configured environment. We immediately ask the main process to spawn the
 * configured agent against it. If the user is offline or has the app closed,
 * the Task survives in the backend — they can spawn manually later.
 */
function handleAutoFixRequested(payload: AutoFixPayload): void {
  console.log('[sync] auto-fix requested for issue', payload.issue_id, '-> task', payload.task_id)
  try {
    // The renderer already has the agents:spawn IPC at window.electronAPI.agents.spawn;
    // it only takes (taskId, agentType) and does the rest (builds prompt from task
    // description + context_notes, pushes to AgentManager in main).
    type AgentsAPI = { spawn: (taskId: string, agentType?: string) => Promise<unknown> }
    const api = (window as unknown as { electronAPI?: { agents?: AgentsAPI } }).electronAPI
    void api?.agents?.spawn?.(payload.task_id, payload.agent_type)
  } catch (err) {
    console.warn('[sync] auto-fix spawn failed:', err)
  }
}

function handleEntityChanged(
  qc: QueryClient | null,
  payload: EntityChangedPayload,
  projectId: string | null,
): void {
  if (!qc) return
  console.log('[sync] event:', payload)
  // Fire unread-marker for "interesting" changes in a project you're not
  // currently looking at. Issues have their own dedicated events; here we
  // catch agent completions, new chat replies (synthesized by the backend
  // as agent updates during chat sessions), and routine finishes.
  if (payload.entity === 'agent' && payload.action === 'updated') {
    const status = (payload.payload as { status?: string } | undefined)?.status
    if (status === 'completed' || status === 'error') {
      markUnreadIfAway(projectId, 'agent.finished')
    }
  }
  if (payload.entity === 'routine' && payload.action === 'updated') {
    markUnreadIfAway(projectId, 'routine.finished')
  }
  if (payload.entity === 'task' && payload.action === 'updated') {
    markUnreadIfAway(projectId, 'task.updated')
  }
  // Map entity types → query keys the renderer listens on, and invalidate them.
  switch (payload.entity) {
    case 'project':
      qc.invalidateQueries({ queryKey: ['projects'] })
      break
    case 'environment':
      qc.invalidateQueries({ queryKey: ['environments'] })
      qc.invalidateQueries({ queryKey: ['environment'] })
      break
    case 'task':
      qc.invalidateQueries({ queryKey: ['tasks'] })
      break
    case 'agent':
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
      break
    case 'routine':
      qc.invalidateQueries({ queryKey: ['routines'] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
      break
    case 'team':
    case 'member':
      qc.invalidateQueries({ queryKey: ['teams'] })
      break
    case 'issue':
      // Cross-device issue edits (resolve, reopen, title change) fire this.
      // The issue.created / issue.regression events already handle count
      // invalidation; here we cover the "another device resolved it" case.
      qc.invalidateQueries({ queryKey: ['issues'] })
      qc.invalidateQueries({ queryKey: ['issue', payload.id] })
      qc.invalidateQueries({ queryKey: ['issues-open-counts'] })
      break
  }
}

/**
 * React hook: starts/stops the Reverb connection based on auth state, and
 * (re)subscribes to the channels relevant for the logged-in user.
 */
export function useSyncBootstrap(): void {
  const qc = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const teams = useAuthStore((s) => s.teams)
  const attach = useSyncStore((s) => s.attach)
  const subscribeUser = useSyncStore((s) => s.subscribeUser)
  const subscribeTeams = useSyncStore((s) => s.subscribeTeams)
  const disconnect = useSyncStore((s) => s.disconnect)

  useEffect(() => { attach(qc) }, [qc, attach])

  useEffect(() => {
    if (!user) { disconnect(); return }
    subscribeUser(user.id)
  }, [user, subscribeUser, disconnect])

  useEffect(() => {
    if (!user || teams.length === 0) return
    subscribeTeams(teams.map((t) => t.id))
  }, [user, teams, subscribeTeams])
}

// Re-export so other hooks (e.g. per-project visibility) can subscribe lazily.
export function subscribeToProject(projectId: string): void {
  useSyncStore.getState().subscribeProjects([projectId])
}
