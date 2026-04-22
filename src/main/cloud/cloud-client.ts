// Thin HTTP wrapper for the Laravel API at alby.sh.
// Used by the IPC handlers as the data source instead of local SQLite.

import { loadToken } from '../auth/keychain'
import { ALBY_BASE_URL } from '../../shared/cloud-constants'
import type {
  Project,
  Environment,
  Task,
  Agent,
  Routine,
  AuditEntry,
  CreateProjectDTO,
  CreateEnvironmentDTO,
  CreateTaskDTO,
  UpdateProjectDTO,
  UpdateEnvironmentDTO,
  UpdateTaskDTO,
  ReportingApp,
  Issue,
  IssueEvent,
  IssueListFilters,
  UpdateIssueDTO,
  CreateAppDTO,
  UpdateAppDTO,
  Release,
  CreateReleaseDTO,
  WebhookConfig,
  CreateWebhookDTO,
  UpdateWebhookDTO,
  NotificationSubscription,
  UpsertNotificationSubDTO,
  UserSlackWebhook,
  Stack,
  CreateStackDTO,
  UpdateStackDTO
} from '../../shared/types'

const BASE = ALBY_BASE_URL

/** Laravel pagination envelope the backend now returns for task lists. */
export interface ProjectTaskPage {
  data: Array<
    Task & {
      environment: { id: string; name: string; label: string | null }
    }
  >
  current_page: number
  last_page: number
  per_page: number
  total: number
}

function buildQuery(params?: Record<string, string | number | undefined | null>): string {
  if (!params) return ''
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    search.set(k, String(v))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await loadToken()
  if (!token) throw new HttpError(401, 'Not authenticated')

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: body !== undefined ? JSON.stringify(body) : undefined
  })

  if (res.status === 204) return undefined as T

  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    const msg = (data as { message?: string; error?: string })?.message
      || (data as { error?: string })?.error
      || `${method} ${path} failed (${res.status})`
    throw new HttpError(res.status, msg)
  }

  return data as T
}

export const cloudClient = {
  // Identity helper used by the migration to set owner_id on personal projects.
  async me(): Promise<{ user: { id: number } }> {
    return request('GET', '/api/me')
  },

  // ---------- Projects ----------
  listProjects(): Promise<Project[]> {
    return request('GET', '/api/projects')
  },
  getProject(id: string): Promise<Project> {
    return request('GET', `/api/projects/${id}`)
  },
  createProject(data: CreateProjectDTO & { id?: string; owner_type: 'user' | 'team'; owner_id: string }): Promise<Project> {
    return request('POST', '/api/projects', data)
  },
  updateProject(id: string, data: UpdateProjectDTO): Promise<Project> {
    return request('PUT', `/api/projects/${id}`, data)
  },
  deleteProject(id: string): Promise<void> {
    return request('DELETE', `/api/projects/${id}`)
  },
  reorderProjects(orderedIds: string[]): Promise<{ ok: boolean }> {
    return request('POST', '/api/projects/reorder', { ordered_ids: orderedIds })
  },
  transferProject(id: string, ownerType: 'user' | 'team', ownerId: string): Promise<Project> {
    return request('POST', `/api/projects/${id}/transfer`, { owner_type: ownerType, owner_id: ownerId })
  },

  // ---------- Stacks ----------
  listStacks(projectId: string): Promise<Stack[]> {
    return request('GET', `/api/projects/${projectId}/stacks`)
  },
  getStack(id: string): Promise<Stack> {
    return request('GET', `/api/stacks/${id}`)
  },
  createStack(projectId: string, data: Omit<CreateStackDTO, 'project_id'> & { id?: string }): Promise<Stack> {
    return request('POST', `/api/projects/${projectId}/stacks`, data)
  },
  updateStack(id: string, data: UpdateStackDTO): Promise<Stack> {
    return request('PUT', `/api/stacks/${id}`, data)
  },
  deleteStack(id: string): Promise<void> {
    return request('DELETE', `/api/stacks/${id}`)
  },

  // ---------- Environments ----------
  listEnvironments(projectId: string): Promise<Environment[]> {
    return request('GET', `/api/projects/${projectId}/environments`)
  },
  getEnvironment(id: string): Promise<Environment> {
    return request('GET', `/api/environments/${id}`)
  },
  createEnvironment(projectId: string, data: Omit<CreateEnvironmentDTO, 'project_id'> & { id?: string }): Promise<Environment> {
    return request('POST', `/api/projects/${projectId}/environments`, data)
  },
  updateEnvironment(id: string, data: UpdateEnvironmentDTO): Promise<Environment> {
    return request('PUT', `/api/environments/${id}`, data)
  },
  deleteEnvironment(id: string): Promise<void> {
    return request('DELETE', `/api/environments/${id}`)
  },
  enableEnvironmentMonitoring(id: string): Promise<ReportingApp> {
    return request('POST', `/api/environments/${id}/enable-monitoring`)
  },
  /** Fetch the plaintext credentials the user opted to sync for this env.
   * The server audits every call. Callers must treat the returned values as
   * sensitive — write private keys to disk with chmod 600, never log them. */
  getEnvironmentCredentials(id: string): Promise<{ ssh_password: string | null; ssh_private_key: string | null }> {
    return request('GET', `/api/environments/${id}/credentials`)
  },
  disableEnvironmentMonitoring(id: string): Promise<void> {
    return request('POST', `/api/environments/${id}/disable-monitoring`)
  },

  // ---------- Tasks ----------
  listTasks(environmentId: string): Promise<Task[]> {
    return request('GET', `/api/environments/${environmentId}/tasks`)
  },
  createTask(environmentId: string, data: Omit<CreateTaskDTO, 'environment_id'> & { id?: string }): Promise<Task> {
    return request('POST', `/api/environments/${environmentId}/tasks`, data)
  },
  updateTask(id: string, data: UpdateTaskDTO): Promise<Task> {
    return request('PUT', `/api/tasks/${id}`, data)
  },
  deleteTask(id: string): Promise<void> {
    return request('DELETE', `/api/tasks/${id}`)
  },

  // ---------- Agents (cloud metadata; runtime stays local) ----------
  listAgents(taskId: string): Promise<Agent[]> {
    return request('GET', `/api/tasks/${taskId}/agents`)
  },
  // Returns every running agent the current user can see, pre-joined with
  // task + environment so the desktop can reconnect without issuing N+1
  // lookups. Used by the main process on boot to reattach tmux sessions.
  listAllRunningAgents(): Promise<Array<Agent & {
    task?: { id: string; environment_id: string; title: string; environment?: {
      id: string; project_id: string; name: string; label: string | null;
      execution_mode: 'remote' | 'local'; ssh_host: string; ssh_user: string | null;
      ssh_port: number; remote_path: string;
    } }
  }>> {
    return request('GET', '/api/agents/running')
  },
  createAgent(taskId: string, data: { id?: string; tab_name?: string; agent_type: string; prompt?: string; status?: string }): Promise<Agent> {
    return request('POST', `/api/tasks/${taskId}/agents`, data)
  },
  updateAgent(id: string, data: Partial<Pick<Agent, 'tab_name' | 'status' | 'exit_code' | 'started_at' | 'finished_at'>> & { chat_session_id?: string | null }): Promise<Agent> {
    return request('PUT', `/api/agents/${id}`, data)
  },
  heartbeatAgent(id: string, deltas: { working_delta?: number; viewed_delta?: number }): Promise<void> {
    return request('POST', `/api/agents/${id}/heartbeat`, deltas)
  },
  deleteAgent(id: string): Promise<void> {
    return request('DELETE', `/api/agents/${id}`)
  },
  /** Fire a broadcast-only reorder: every device on the project channel picks
   *  it up via `entity.changed` / action=reordered and applies the order to
   *  its own SQLite. The cloud doesn't store agent sort_order (would collide
   *  across collaborators). */
  reorderAgents(projectId: string, orderedIds: string[]): Promise<void> {
    return request('POST', '/api/agents/reorder', { project_id: projectId, ordered_ids: orderedIds })
  },
  /**
   * Batch-append chat-style transcript events to the cloud. The backend
   * has a UNIQUE (agent_id, seq) index, so retries with overlapping seqs
   * are silently ignored. Fire-and-forget in the hot path.
   */
  appendChatEvents(id: string, events: Array<{ seq: number; event_json: string }>): Promise<void> {
    return request('POST', `/api/agents/${id}/chat-events`, { events })
  },
  /** Fetch the cloud-persisted chat transcript, optionally starting after
   *  a given seq so a device with partial history can pull only what it's
   *  missing. */
  listChatEvents(id: string, since = -1, limit = 10000): Promise<Array<{ seq: number; event_json: string }>> {
    return request('GET', `/api/agents/${id}/chat-events${buildQuery({ since, limit })}`)
  },

  // ---------- Teams ----------
  listTeams(): Promise<Array<{ id: string; name: string; slug: string; avatar_url: string | null; role: string }>> {
    return request('GET', '/api/teams')
  },
  getTeam(id: string): Promise<{ id: string; name: string; slug: string; avatar_url: string | null; members: Array<{ id: number; name: string; email: string; avatar_url: string | null; pivot: { role: string } }>; invites: Array<{ id: number; email: string | null; role: string; token: string; expires_at: string; accepted_at: string | null }> }> {
    return request('GET', `/api/teams/${id}`)
  },
  createTeam(data: { name: string; avatar_url?: string }): Promise<{ id: string }> {
    return request('POST', '/api/teams', data)
  },
  updateTeam(id: string, data: { name?: string; avatar_url?: string | null }): Promise<unknown> {
    return request('PUT', `/api/teams/${id}`, data)
  },
  deleteTeam(id: string): Promise<void> {
    return request('DELETE', `/api/teams/${id}`)
  },
  inviteTeamMember(teamId: string, data: { email?: string; role: 'admin' | 'developer' | 'viewer' | 'analyst' }): Promise<{ invite: unknown; url: string }> {
    return request('POST', `/api/teams/${teamId}/invite`, data)
  },
  removeTeamMember(teamId: string, userId: number): Promise<void> {
    return request('DELETE', `/api/teams/${teamId}/members/${userId}`)
  },
  updateTeamMemberRole(teamId: string, userId: number, role: 'admin' | 'developer' | 'viewer' | 'analyst'): Promise<void> {
    return request('PUT', `/api/teams/${teamId}/members/${userId}/role`, { role })
  },

  // ---------- Audit / project history ----------
  listProjectAudit(projectId: string): Promise<Array<AuditEntry>> {
    return request('GET', `/api/projects/${projectId}/audit`)
  },
  recordAudit(payload: {
    project_id: string
    entity_type: string
    entity_id: string
    action: string
    summary?: string
    diff?: unknown
  }): Promise<void> {
    return request('POST', '/api/audit/record', payload)
  },

  // All tasks across every environment of a project. Backend now returns a
  // Laravel paginator ({ data, current_page, last_page, total, per_page }).
  // Callers pass filters/pagination via the optional params bag.
  listProjectTasks(
    projectId: string,
    params?: {
      q?: string
      status?: 'open' | 'done' | 'all'
      stack_id?: string
      env_id?: string
      include_default?: 0 | 1
      per_page?: number
      page?: number
    },
  ): Promise<ProjectTaskPage> {
    const qs = buildQuery(params)
    return request('GET', `/api/projects/${projectId}/tasks${qs}`)
  },

  // Same shape as listProjectTasks but scoped to a single stack. Backed by
  // GET /api/stacks/{id}/tasks.
  listStackTasks(
    stackId: string,
    params?: {
      q?: string
      status?: 'open' | 'done' | 'all'
      env_id?: string
      include_default?: 0 | 1
      per_page?: number
      page?: number
    },
  ): Promise<ProjectTaskPage> {
    const qs = buildQuery(params)
    return request('GET', `/api/stacks/${stackId}/tasks${qs}`)
  },

  // ---------- Routines ----------
  listRoutines(environmentId: string): Promise<Routine[]> {
    return request('GET', `/api/environments/${environmentId}/routines`)
  },
  createRoutine(environmentId: string, data: { id?: string; name: string; cron_expression: string; interval_seconds: number; agent_type: string; prompt: string; enabled?: boolean }): Promise<Routine> {
    return request('POST', `/api/environments/${environmentId}/routines`, data)
  },
  updateRoutine(id: string, data: Partial<Routine>): Promise<Routine> {
    return request('PUT', `/api/routines/${id}`, data)
  },
  deleteRoutine(id: string): Promise<void> {
    return request('DELETE', `/api/routines/${id}`)
  },
  /** Persist sort_order server-side and broadcast. Devices on the project
   *  channel pick up the `entity.changed` / routine / reordered event and
   *  replay the same order into their local cache. */
  reorderRoutines(environmentId: string, orderedIds: string[]): Promise<void> {
    return request('POST', `/api/environments/${environmentId}/routines/reorder`, { ordered_ids: orderedIds })
  },

  // ---------- Error tracking: Apps ----------
  listApps(projectId: string): Promise<ReportingApp[]> {
    return request('GET', `/api/projects/${projectId}/apps`)
  },
  getApp(id: string): Promise<ReportingApp> {
    return request('GET', `/api/apps/${id}`)
  },
  createApp(projectId: string, data: CreateAppDTO): Promise<ReportingApp> {
    return request('POST', `/api/projects/${projectId}/apps`, data)
  },
  updateApp(id: string, data: UpdateAppDTO): Promise<ReportingApp> {
    return request('PUT', `/api/apps/${id}`, data)
  },
  deleteApp(id: string): Promise<void> {
    return request('DELETE', `/api/apps/${id}`)
  },
  rotateAppKey(id: string): Promise<ReportingApp> {
    return request('POST', `/api/apps/${id}/rotate-key`)
  },

  // ---------- Error tracking: Issues ----------
  listIssues(appId: string, filters?: IssueListFilters): Promise<{ data: Issue[]; current_page: number; last_page: number; total: number }> {
    const qs = new URLSearchParams()
    if (filters) {
      if (filters.status) qs.set('status', Array.isArray(filters.status) ? filters.status.join(',') : filters.status)
      if (filters.level) qs.set('level', Array.isArray(filters.level) ? filters.level.join(',') : filters.level)
      if (filters.q) qs.set('q', filters.q)
      if (filters.sort) qs.set('sort', filters.sort)
      if (filters.dir) qs.set('dir', filters.dir)
      if (filters.per_page) qs.set('per_page', String(filters.per_page))
      if (filters.page) qs.set('page', String(filters.page))
    }
    const suffix = qs.toString() ? `?${qs}` : ''
    return request('GET', `/api/apps/${appId}/issues${suffix}`)
  },
  getIssue(id: string): Promise<{ issue: Issue; app: Pick<ReportingApp, 'id' | 'name' | 'platform'>; latest_event: IssueEvent | null }> {
    return request('GET', `/api/issues/${id}`)
  },
  listIssueEvents(id: string, page = 1, perPage = 25): Promise<{ data: IssueEvent[]; current_page: number; last_page: number; total: number }> {
    return request('GET', `/api/issues/${id}/events?page=${page}&per_page=${perPage}`)
  },
  updateIssue(id: string, data: UpdateIssueDTO): Promise<Issue> {
    return request('PATCH', `/api/issues/${id}`, data)
  },

  // ---------- Error tracking: Releases ----------
  listReleases(appId: string): Promise<Release[]> {
    return request('GET', `/api/apps/${appId}/releases`)
  },
  createRelease(appId: string, data: CreateReleaseDTO): Promise<Release> {
    return request('POST', `/api/apps/${appId}/releases`, data)
  },

  // ---------- Error tracking: Webhooks ----------
  listWebhooks(appId: string): Promise<WebhookConfig[]> {
    return request('GET', `/api/apps/${appId}/webhooks`)
  },
  createWebhook(appId: string, data: CreateWebhookDTO): Promise<WebhookConfig> {
    return request('POST', `/api/apps/${appId}/webhooks`, data)
  },
  updateWebhook(id: string, data: UpdateWebhookDTO): Promise<WebhookConfig> {
    return request('PUT', `/api/webhooks/${id}`, data)
  },
  deleteWebhook(id: string): Promise<void> {
    return request('DELETE', `/api/webhooks/${id}`)
  },
  rotateWebhookSecret(id: string): Promise<WebhookConfig> {
    return request('POST', `/api/webhooks/${id}/rotate-secret`)
  },

  // ---------- Error tracking: Notification subscriptions ----------
  listNotifSubs(appId: string): Promise<NotificationSubscription[]> {
    return request('GET', `/api/apps/${appId}/notification-subscriptions`)
  },
  upsertNotifSub(appId: string, data: UpsertNotificationSubDTO): Promise<NotificationSubscription> {
    return request('POST', `/api/apps/${appId}/notification-subscriptions`, data)
  },
  deleteNotifSub(appId: string, userId: number): Promise<void> {
    return request('DELETE', `/api/apps/${appId}/notification-subscriptions/${userId}`)
  },
  /** Return the current user's notification subs across every app they can
   *  see. Used by the renderer's sync-store on boot to decide whether to
   *  fire a native desktop notification when an issue event lands. */
  listMyNotifSubs(): Promise<Array<Pick<NotificationSubscription, 'app_id' | 'triggers' | 'channels'>>> {
    return request('GET', '/api/me/notification-subscriptions')
  },

  // ---------- Per-user Slack webhook ----------
  getSlackWebhook(): Promise<UserSlackWebhook | null> {
    return request('GET', '/api/users/me/slack-webhook')
  },
  setSlackWebhook(webhookUrl: string): Promise<UserSlackWebhook> {
    return request('PUT', '/api/users/me/slack-webhook', { webhook_url: webhookUrl })
  },
  deleteSlackWebhook(): Promise<void> {
    return request('DELETE', '/api/users/me/slack-webhook')
  },
  /** Map user_id → true for members who have a webhook configured, so the
   *  alerts list can show a presence dot. */
  slackWebhookPresence(userIds: number[]): Promise<Record<number, true>> {
    const qs = userIds.map((id) => `user_ids[]=${id}`).join('&')
    return request('GET', `/api/slack-webhooks/presence${qs ? '?' + qs : ''}`)
  },
}

export type CloudClient = typeof cloudClient
