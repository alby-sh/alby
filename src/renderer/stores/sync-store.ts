import { create } from 'zustand'
import Pusher, { type Channel } from 'pusher-js'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useAuthStore } from './auth-store'
import { useUnreadStore, type UnreadScope, type UnreadReason, type EnvPinKey } from './unread-store'
import { useAppStore } from './app-store'
import type { Agent, Environment, ReportingApp, Routine, Task } from '../../shared/types'

/** Extract the projectId from a private-project.<id> Reverb channel name.
 *  Returns null for user/team channels so the unread tracker stays project-scoped. */
function projectIdFromChannelName(channelName: string): string | null {
  const m = /^private-project\.(.+)$/.exec(channelName)
  return m ? m[1] : null
}

/**
 * Mark unread across every level a sync event touches.
 *
 * Each event carries a projectId (from the channel name) and optionally an
 * entity id (agent/routine/issue). We resolve the full parent chain via the
 * React Query cache to light up the stack + env + pin dots too — that way a
 * user in project X but on the "Sessions" pin of env A still sees a dot on
 * env B's "Routines" pin when a routine there finishes.
 *
 * The `entityView` param tells the function where the event is coming from
 * so we can skip clearing paths the user is already looking at (e.g. don't
 * mark the env dot when the user is standing on the env page).
 */
function markUnreadIfAway(
  qc: QueryClient | null,
  projectId: string | null,
  reason: UnreadReason,
  resolve?: (qc: QueryClient) => Partial<UnreadScope>,
): void {
  if (!projectId) return
  const scope: UnreadScope = { projectId }
  if (qc && resolve) Object.assign(scope, resolve(qc))
  // Drop levels the user is currently looking at — no point pinging them
  // about something that's already on screen.
  const app = useAppStore.getState()
  if (scope.projectId && app.selectedProjectId === scope.projectId) delete scope.projectId
  if (scope.environmentId && app.selectedEnvironmentId === scope.environmentId) {
    delete scope.environmentId
    // When the user is on the env, also skip pin dots inside it.
    delete scope.envPin
  }
  if (Object.keys(scope).length === 0) return
  useUnreadStore.getState().mark(scope, reason)
}

/** Walk the TanStack cache to find the env + stack an entity belongs to. */
function resolveAgentScope(qc: QueryClient, agentId: string): Partial<UnreadScope> {
  const all = qc.getQueryData<Agent[]>(['agents-all'])
  const agent = all?.find((a) => a.id === agentId)
  if (!agent) return {}
  // agents-all already carries project_id via JOIN, so use that directly.
  const projectId = agent.project_id
  const taskCaches = findTaskCachesByProject(qc, projectId)
  let envId: string | undefined
  for (const { tasks } of taskCaches) {
    const t = tasks.find((x) => x.id === agent.task_id)
    if (t) { envId = t.environment_id; break }
  }
  return envBoundScope(qc, projectId, envId)
}

function resolveRoutineScope(qc: QueryClient, routineId: string): Partial<UnreadScope> {
  // routines-all is our one-shot "all routines for this user" cache.
  const all = qc.getQueryData<Routine[]>(['routines-all'])
  const routine = all?.find((r) => r.id === routineId)
  if (!routine) return {}
  const envId = routine.environment_id
  // Project id comes from walking envs for each known project.
  const env = findEnv(qc, envId)
  if (!env) return { environmentId: envId }
  return envBoundScope(qc, env.project_id, envId, env)
}

function resolveIssueScope(qc: QueryClient, appId: string, projectId: string): Partial<UnreadScope> {
  // Issues are stack-level in the UI (the "Issues" pin lives alongside
  // Overview / Tasks under each stack header), so we deliberately do NOT
  // mark the environment dot — it would give the user a false signal that
  // the env itself has something to look at (e.g. an agent finished),
  // which isn't the case. We do mark the stack (for the collapsed-header
  // rollup) and the `stackPin` for the Issues row itself.
  const scope: Partial<UnreadScope> = { projectId }
  const apps = qc.getQueryData<ReportingApp[]>(['apps', projectId])
  const app = apps?.find((a) => a.id === appId)
  const envId = app?.environment_id ?? undefined
  if (envId) {
    const env = findEnv(qc, envId)
    if (env?.stack_id) {
      scope.stackId = env.stack_id
      scope.stackPin = { stackId: env.stack_id, pinKey: 'issues' }
    }
  }
  return scope
}

/** Common rollup: given projectId + optional envId, resolve stack via envs. */
function envBoundScope(
  qc: QueryClient,
  projectId: string | undefined,
  envId: string | undefined,
  envPreResolved?: Environment,
  pinKey?: EnvPinKey,
): Partial<UnreadScope> {
  const scope: Partial<UnreadScope> = {}
  if (projectId) scope.projectId = projectId
  if (!envId) return scope
  scope.environmentId = envId
  const env = envPreResolved ?? findEnv(qc, envId)
  if (env?.stack_id) scope.stackId = env.stack_id
  if (pinKey) scope.envPin = { environmentId: envId, pinKey }
  return scope
}

function findEnv(qc: QueryClient, envId: string): Environment | undefined {
  // Iterate every `['environments', projectId]` cache entry looking for the
  // requested id. Caches not populated yet → miss, which means we'll mark
  // project only. That's OK; it'll converge on the next navigation.
  const entries = qc.getQueriesData<Environment[]>({ queryKey: ['environments'] })
  for (const [, list] of entries) {
    const e = list?.find((x) => x.id === envId)
    if (e) return e
  }
  return undefined
}

function findTaskCachesByProject(qc: QueryClient, _projectId: string | undefined): Array<{ envId: string; tasks: Task[] }> {
  const out: Array<{ envId: string; tasks: Task[] }> = []
  const entries = qc.getQueriesData<Task[]>({ queryKey: ['tasks'] })
  for (const [key, list] of entries) {
    if (!Array.isArray(list)) continue
    const envId = Array.isArray(key) ? String(key[1] ?? '') : ''
    out.push({ envId, tasks: list })
  }
  return out
}
import {
  REVERB_KEY,
  REVERB_HOST,
  REVERB_PORT,
  REVERB_SCHEME,
} from '../../shared/cloud-constants'

type EntityType = 'project' | 'environment' | 'task' | 'agent' | 'routine' | 'team' | 'member' | 'issue'
type Action = 'created' | 'updated' | 'deleted' | 'reordered' | 'idle'

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
  /** Project / team IDs the renderer asked to subscribe to BEFORE pusher had
   *  finished handshake. Drained as soon as `_pusher` is created. Without
   *  this queue, the subscribe() call silently no-ops and the user stops
   *  receiving issue / agent events on a page reload where `useAllProjects`
   *  resolves before `useSyncBootstrap`'s auth.current() completes. */
  _pendingProjects: Set<string>
  _pendingTeams: Set<string>
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
  _pendingProjects: new Set(),
  _pendingTeams: new Set(),

  attach: (qc) => set({ _qc: qc }),

  subscribeUser: (userId: number) => {
    // Grab the current Sanctum token so the authorizer can sign channel auth.
    window.electronAPI.auth.current().then((data) => {
      if (!data?.token) return

      let pusher = get()._pusher
      if (!pusher) {
        pusher = new Pusher(REVERB_KEY, {
          wsHost: REVERB_HOST,
          wssPort: REVERB_PORT,
          wsPort: REVERB_PORT,
          forceTLS: REVERB_SCHEME === 'https',
          enabledTransports: ['ws', 'wss'],
          cluster: 'mt1', // required by pusher-js but ignored by Reverb
          authorizer: (channel) => ({
            // Route every Pusher channel-auth POST through the main process
            // so Chromium's CORS check on the dev origin (http://localhost:5173)
            // doesn't strangle the handshake — Laravel's /broadcasting/auth
            // only whitelists the packaged app's origin. In packaged builds
            // this is an IPC hop we could skip, but routing through main is
            // free (main uses Node fetch) and keeps one code path for both.
            authorize: (socketId, callback) => {
              window.electronAPI.broadcast
                .authorize(data.token, socketId, channel.name)
                .then((authData) => callback(null, authData as unknown as { auth: string }))
                .catch((err) => callback(err as Error, null as unknown as { auth: string }))
            },
          }),
        })

        pusher.connection.bind('connected', () => { set({ connected: true }); console.log('[sync] connected') })
        pusher.connection.bind('disconnected', () => { set({ connected: false }); console.log('[sync] disconnected') })
        pusher.connection.bind('error', (err: unknown) => { console.warn('[sync] error:', err) })

        set({ _pusher: pusher })

        // Drain any subscribe calls that arrived before pusher existed.
        const pending = get()
        pending._pendingTeams.forEach((id) => subscribeOnce(get, set, pusher!, `private-team.${id}`))
        pending._pendingProjects.forEach((id) => subscribeOnce(get, set, pusher!, `private-project.${id}`))
        set({ _pendingTeams: new Set(), _pendingProjects: new Set() })
      }

      subscribeOnce(get, set, pusher, `private-user.${userId}`)
    })
  },

  subscribeTeams: (teamIds) => {
    const pusher = get()._pusher
    if (!pusher) {
      // Queue for the drain that happens once subscribeUser creates pusher.
      const next = new Set(get()._pendingTeams)
      teamIds.forEach((id) => next.add(id))
      set({ _pendingTeams: next })
      return
    }
    teamIds.forEach((id) => subscribeOnce(get, set, pusher, `private-team.${id}`))
  },

  subscribeProjects: (projectIds) => {
    const pusher = get()._pusher
    if (!pusher) {
      const next = new Set(get()._pendingProjects)
      projectIds.forEach((id) => next.add(id))
      set({ _pendingProjects: next })
      return
    }
    projectIds.forEach((id) => subscribeOnce(get, set, pusher, `private-project.${id}`))
  },

  disconnect: () => {
    const { _pusher, _channels } = get()
    _channels.forEach((c) => { try { c.unbind_all(); _pusher?.unsubscribe(c.name) } catch { /* ignore */ } })
    _pusher?.disconnect()
    set({
      _pusher: null,
      _channels: new Map(),
      _pendingTeams: new Set(),
      _pendingProjects: new Set(),
      connected: false,
    })
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

  // Desktop notification + unread-marker. We act on three event kinds:
  //  - issue.created    → trigger 'new_issue'
  //  - issue.regression → trigger 'regression'
  //  - issue.new_event  → trigger 'every_event' (per-occurrence, opt-in)
  // The push gate reads the user's per-app `channels.push` AND requires the
  // matching trigger to be enabled — a user subscribed only to 'new_issue'
  // won't get a push for every subsequent occurrence.
  if (
    name === 'issue.created' ||
    name === 'issue.regression' ||
    name === 'issue.new_event'
  ) {
    const pushEnabled = isPushEnabledForApp(qc, payload.app_id, name)
    if (pushEnabled) notifyIssue(name, payload)
    markUnreadIfAway(
      qc,
      projectId,
      name === 'issue.regression' ? 'issue.regression' : 'issue.created',
      (qc) => (projectId ? resolveIssueScope(qc, payload.app_id, projectId) : {}),
    )
  }
}

/** Look up the current user's push preference for a given app + event name.
 *  Returns false if we don't have the sub cache yet (safe default — we'd
 *  rather miss a notification than spam the user on boot). */
function isPushEnabledForApp(qc: QueryClient, appId: string, eventName: string): boolean {
  const mine = qc.getQueryData<Array<{
    app_id: string
    triggers: Array<'new_issue' | 'regression' | 'every_event'>
    channels?: { push?: boolean }
  }>>(['notification-subs-mine'])
  if (!mine) return false
  const sub = mine.find((s) => s.app_id === appId)
  if (!sub?.channels?.push) return false
  const trigger: 'new_issue' | 'regression' | 'every_event' =
    eventName === 'issue.regression' ? 'regression'
      : eventName === 'issue.new_event' ? 'every_event'
        : 'new_issue'
  return sub.triggers.includes(trigger)
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
    name === 'issue.regression' ? 'Alby · Issue regressed'
      : name === 'issue.new_event' ? 'Alby · New occurrence'
        : 'Alby · New issue'
  const levelTag =
    payload.level && payload.level !== 'error' ? ` [${payload.level.toUpperCase()}]` : ''
  const body = (payload.title ?? 'Unknown issue') + levelTag
  // A per-occurrence push should replace the previous one for the same
  // issue (so Notification Center doesn't stack hundreds of them from a
  // noisy prod deploy), but for new_issue / regression we use a stable
  // tag so they collapse per issue too.
  const tag =
    name === 'issue.new_event'
      ? `alby-issue-${payload.issue_id}-events`
      : `alby-issue-${payload.issue_id}`
  try {
    // Include the issueId so clicking the notification navigates the renderer
    // to the issue detail view (same path as the alby:// deep link).
    window.electronAPI.notifications.issue({ title, body, tag, issueId: payload.issue_id })
  } catch (err) {
    console.warn('[sync] notification failed:', err)
  }
}

/** Cross-device agent finish / idle notification. Fires only when the user
 *  is NOT already on the env (same predicate as markUnreadIfAway uses) —
 *  no point pinging them about a terminal they're watching. Clicking the
 *  banner deep-links into that specific session. */
function notifyAgentFinish(
  qc: QueryClient,
  agentId: string,
  reason: 'completed' | 'error' | 'idle',
): void {
  const all = qc.getQueryData<Agent[]>(['agents-all'])
  const agent = all?.find((a) => a.id === agentId)
  if (!agent?.project_id) return
  const appStore = useAppStore.getState()
  if (appStore.activeAgentId === agentId) return // user is on the tab already
  const envId = resolveAgentScope(qc, agentId).environmentId
  if (envId && appStore.selectedEnvironmentId === envId && !appStore.activeAgentId) return
  const label = agent.tab_name ?? 'Session'
  const title = reason === 'error' ? 'Alby · Agent crashed'
    : reason === 'completed' ? 'Alby · Agent finished'
      : 'Alby · Agent idle'
  const body = `${label} — ${reason === 'error' ? 'exited with error' : reason === 'completed' ? 'completed' : 'ready for next input'}`
  try {
    window.electronAPI.notifications.agent({
      title,
      body,
      tag: `alby-agent-${agentId}-${reason}`,
      agentId,
      projectId: agent.project_id,
    })
  } catch (err) {
    console.warn('[sync] agent notification failed:', err)
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
  // Reorder events carry the new order in payload.ordered_ids. We apply them
  // through the same IPC the originating device used — that keeps local
  // SQLite in sync and the TanStack invalidation below picks up the new
  // ordering on the next fetch. Idempotent, so re-firing on the sender too
  // is harmless.
  if (payload.action === 'reordered') {
    const ids = (payload.payload as { ordered_ids?: string[] } | undefined)?.ordered_ids
    if (payload.entity === 'agent' && Array.isArray(ids)) {
      window.electronAPI.agents.reorder(ids).catch(() => { /* ignore */ })
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
      return
    }
    if (payload.entity === 'routine' && Array.isArray(ids)) {
      const envId = (payload.payload as { environment_id?: string } | undefined)?.environment_id
      if (envId) {
        window.electronAPI.routines.reorder(envId, ids).catch(() => { /* ignore */ })
      }
      qc.invalidateQueries({ queryKey: ['routines'] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
      return
    }
  }
  // Fire unread-marker for "interesting" changes in a project you're not
  // currently looking at. Issues have their own dedicated events; here we
  // catch agent completions, new chat replies (synthesized by the backend
  // as agent updates during chat sessions), and routine finishes.
  if (payload.entity === 'agent' && payload.action === 'updated') {
    const status = (payload.payload as { status?: string } | undefined)?.status
    if (status === 'completed' || status === 'error') {
      markUnreadIfAway(qc, projectId, 'agent.finished', (qc) => {
        const base = resolveAgentScope(qc, payload.id)
        // Agent events roll up to the Sessions pin inside the env AND mark
        // the specific session (byAgent leaf) — the sidebar renders the leaf
        // dot on the session row and gates each parent's dot on collapsed
        // state, so you only see one dot per visible level.
        if (base.environmentId) {
          base.envPin = { environmentId: base.environmentId, pinKey: 'sessions' }
        }
        base.agentId = payload.id
        return base
      })
      // Native desktop ping so the user knows without hunting in the sidebar.
      notifyAgentFinish(qc, payload.id, status as 'completed' | 'error')
    }
  }
  // Cross-device "agent just finished a turn" signal. The pty-owning device
  // POSTs to /api/agents/{id}/idle when Claude / Gemini / Codex flips
  // working→idle; every other device receives it here and drops a dot in
  // the sidebar so the user knows output is waiting without having to
  // check the active machine. The originating device also receives its
  // own broadcast but `markUnreadIfAway` skips the env dot if the user is
  // already looking at the env, so no false positive.
  if (payload.entity === 'agent' && payload.action === 'idle') {
    markUnreadIfAway(qc, projectId, 'agent.activity', (qc) => {
      const base = resolveAgentScope(qc, payload.id)
      if (base.environmentId) {
        base.envPin = { environmentId: base.environmentId, pinKey: 'sessions' }
      }
      base.agentId = payload.id
      return base
    })
    notifyAgentFinish(qc, payload.id, 'idle')
  }
  if (payload.entity === 'routine' && payload.action === 'updated') {
    markUnreadIfAway(qc, projectId, 'routine.finished', (qc) => {
      const base = resolveRoutineScope(qc, payload.id)
      if (base.environmentId) {
        base.envPin = { environmentId: base.environmentId, pinKey: 'routines' }
      }
      base.routineId = payload.id
      return base
    })
  }
  if (payload.entity === 'task' && payload.action === 'updated') {
    markUnreadIfAway(qc, projectId, 'task.updated')
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
