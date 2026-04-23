export interface ProjectMember {
  id: number
  name: string
  email: string
  avatar_url: string | null
}

export interface AuditEntry {
  id: number
  actor: { id: number; name: string; email: string; avatar_url: string | null } | null
  entity_type: string
  entity_id: string
  action: string
  summary: string | null
  diff: unknown
  created_at: string
  ref?: {
    type: string
    id: string
    tab_name?: string | null
    agent_type?: string | null
    task_title?: string | null
    task_status?: string | null
    environment?: string | null
    started_at?: string | null
    finished_at?: string | null
    duration_seconds?: number | null
    working_seconds?: number | null
    viewed_seconds?: number | null
    name?: string | null
  }
}

export interface Project {
  id: string
  name: string
  execution_mode: 'remote' | 'local'
  favicon_url: string | null
  url: string | null
  created_at: string
  sort_order: number
  pinned: 0 | 1
  owner_type?: 'user' | 'team'
  owner_id?: string
  members?: ProjectMember[]
  // Error-tracking auto-fix settings (populated on GET /api/projects/{id})
  auto_fix_enabled?: boolean
  auto_fix_environment_id?: string | null
  auto_fix_agent_type?: 'claude' | 'gemini' | 'codex'
  auto_fix_max_per_day?: number
}

export type ExecutionMode = 'remote' | 'local'
export type EnvironmentRole = 'operational' | 'deploy'
export type EnvironmentPlatform = 'linux' | 'windows'

/** What kind of thing a Stack is, surfaced through a card picker on creation.
 * Mostly used for default icon/color and a lighter filter on issues/audit. */
export type StackKind =
  | 'website'
  | 'webapp'
  | 'api'
  | 'frontend'
  | 'backend'
  | 'fullstack'
  | 'script'
  | 'mobile_app'
  | 'desktop_app'
  | 'library'
  | 'custom'

export type AutoFixAgentType = 'claude' | 'gemini' | 'codex'

/** A Stack is a single codebase/repo inside a project. One project can have
 * many stacks (e.g. website, api, mobile) and each stack owns a tree of
 * environments (dev/staging/prod). Auto-fix config lives here because 1 stack
 * = 1 repo = 1 place where fix commits land. */
export interface Stack {
  id: string
  project_id: string
  name: string
  slug: string | null
  kind: StackKind
  favicon_url: string | null
  git_remote_url: string | null
  default_branch: string
  auto_fix_enabled: boolean
  auto_fix_agent_type: AutoFixAgentType
  auto_fix_target_env_id: string | null
  auto_fix_max_per_day: number
  sort_order: number
  created_at?: string
  updated_at?: string
}

export interface CreateStackDTO {
  project_id: string
  name: string
  kind?: StackKind
  slug?: string
  favicon_url?: string | null
  git_remote_url?: string | null
  default_branch?: string
}

export interface UpdateStackDTO {
  name?: string
  slug?: string | null
  kind?: StackKind
  favicon_url?: string | null
  git_remote_url?: string | null
  default_branch?: string
  auto_fix_enabled?: boolean
  auto_fix_agent_type?: AutoFixAgentType
  auto_fix_target_env_id?: string | null
  auto_fix_max_per_day?: number
  sort_order?: number
}

export interface DeployConfig {
  branch: string
  pre_commands: string[]
  post_commands: string[]
}

export const DEFAULT_DEPLOY_CONFIG: DeployConfig = {
  branch: 'main',
  pre_commands: [],
  post_commands: [],
}

export type SSHAuthMethod = 'key' | 'password'

export interface Environment {
  id: string
  project_id: string
  /** The stack (codebase) this env belongs to. Every env has a stack; legacy
   * projects get a Default stack auto-created server-side and all their envs
   * are reparented to it. */
  stack_id: string
  name: string
  label: string | null
  execution_mode: ExecutionMode
  role: EnvironmentRole
  platform: EnvironmentPlatform
  ssh_host: string
  ssh_user: string | null
  ssh_port: number
  ssh_key_path: string | null
  ssh_auth_method: SSHAuthMethod
  ssh_password: string | null
  /** Backend-side flags indicating whether an envelope-encrypted copy of the
   * password / private key is stored on alby.sh and can be materialized on
   * this device. The raw ciphertext is never sent to the client — only the
   * boolean. When true and no local credential is present, the main process
   * calls GET /api/environments/{id}/credentials to unseal it. */
  has_synced_password?: boolean
  has_synced_private_key?: boolean
  remote_path: string
  /** Optional shell command to start this app / site / service locally.
   *  Consumed by the sidebar right-click → "Run locally" action. Null means
   *  "no launch command configured". */
  launch_command: string | null
  agent_settings: AgentSettings | null
  deploy_config: DeployConfig | null
  /** Env-level override. When null the stack-level git_remote_url / default_branch apply. */
  git_remote_url: string | null
  /** Eager-loaded by /api/environments and /api/environments/{id}. Null when
   * monitoring isn't enabled on this env. */
  app?: ReportingApp | null
  /** Eager-loaded by /api/environments and /api/environments/{id}. */
  stack?: Stack | null
  created_at: string
  sort_order: number
}

export interface Task {
  id: string
  environment_id: string
  title: string
  description: string | null
  context_notes: string | null
  status: 'open' | 'in_progress' | 'done'
  is_default: 0 | 1
  created_at: string
  sort_order: number
}

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error'

export interface Agent {
  id: string
  task_id: string
  tab_name: string | null
  status: AgentStatus
  prompt: string | null
  exit_code: number | null
  started_at: string | null
  finished_at: string | null
  created_at: string
  sort_order: number
  // Populated only by agents.listAll() via JOIN; undefined from per-task queries.
  project_id?: string
}

export interface SSHHost {
  alias: string
  hostname: string
  user: string
  port: number
  identityFile: string | null
  isCustom: boolean
}

/** A port that the user's launch_command opened on the remote server, which
 *  Alby has tunneled to a port on the local machine via SSH local-forward.
 *
 *  Lifecycle:
 *   - Created when the launch agent's stdout matches a `http://localhost:N`
 *     URL pattern (no polling — see main/ssh/port-detector.ts).
 *   - Local port equals `remote_port` when free; falls back to a random
 *     available port otherwise. The renderer should always show `local_port`
 *     to the user, never assume parity with `remote_port`.
 *   - Disposed when the spawning launch agent exits / is killed / SSH dies. */
export interface ForwardedPort {
  agent_id: string
  environment_id: string
  remote_port: number
  local_port: number
  opened_at: string
}

export interface CreateProjectDTO {
  name: string
  execution_mode?: 'remote' | 'local'
  owner_type?: 'user' | 'team'
  owner_id?: string
}

export interface CreateEnvironmentDTO {
  project_id: string
  /** When omitted, the backend auto-assigns the env to the project's first
   * (sort-order-wise) Stack — matches the "Default" stack created by the
   * migration. Surfaced explicitly by the new-env UI once a project has more
   * than one stack. */
  stack_id?: string
  name: string
  label?: string
  execution_mode?: ExecutionMode
  role?: EnvironmentRole
  platform?: EnvironmentPlatform
  ssh_host?: string
  ssh_user?: string
  ssh_port?: number
  ssh_key_path?: string
  ssh_auth_method?: SSHAuthMethod
  ssh_password?: string
  /** When true, the backend encrypts `ssh_password` with the user's vault key
   * and keeps it available for materialization on other devices. When false
   * (or omitted) the password stays on this device only. */
  ssh_password_sync_enabled?: boolean
  /** Plaintext content of the private key file at `ssh_key_path`. The client
   * reads the file once, passes the content here, and never uploads the path
   * itself. Only used together with `ssh_private_key_sync_enabled: true`. */
  ssh_private_key_content?: string
  ssh_private_key_sync_enabled?: boolean
  remote_path: string
  launch_command?: string | null
  deploy_config?: DeployConfig | null
}

export interface CreateTaskDTO {
  environment_id: string
  title: string
  description?: string
  context_notes?: string
}

export interface UpdateProjectDTO {
  name?: string
  execution_mode?: 'remote' | 'local'
  favicon_url?: string | null
  url?: string | null
  pinned?: 0 | 1
  auto_fix_enabled?: boolean
  auto_fix_environment_id?: string | null
  auto_fix_agent_type?: 'claude' | 'gemini' | 'codex'
  auto_fix_max_per_day?: number
}

export interface UpdateEnvironmentDTO {
  name?: string
  label?: string
  execution_mode?: ExecutionMode
  role?: EnvironmentRole
  platform?: EnvironmentPlatform
  ssh_host?: string
  ssh_user?: string
  ssh_port?: number
  ssh_key_path?: string
  ssh_auth_method?: SSHAuthMethod
  ssh_password?: string | null
  ssh_password_sync_enabled?: boolean
  ssh_private_key_content?: string | null
  ssh_private_key_sync_enabled?: boolean
  remote_path?: string
  launch_command?: string | null
  agent_settings?: AgentSettings | null
  deploy_config?: DeployConfig | null
  git_remote_url?: string | null
  sort_order?: number
}

export interface UpdateTaskDTO {
  title?: string
  description?: string
  context_notes?: string
  status?: 'open' | 'in_progress' | 'done'
}

/* ======================== Routines ======================== */

export type RoutineAgentType = 'claude' | 'gemini' | 'codex'

export interface Routine {
  id: string
  environment_id: string
  name: string
  /** Null on both schedule fields → manual-only (no automatic ticks). User
   *  clicks Start in the sidebar when they want to run it. */
  cron_expression: string | null
  interval_seconds: number | null
  agent_type: RoutineAgentType
  prompt: string
  enabled: 0 | 1
  tmux_session_name: string | null
  last_run_at: string | null
  last_exit_code: number | null
  sort_order: number
  created_at: string
}

export interface CreateRoutineDTO {
  environment_id: string
  name: string
  cron_expression: string | null
  interval_seconds: number | null
  agent_type: RoutineAgentType
  prompt: string
}

export interface UpdateRoutineDTO {
  name?: string
  cron_expression?: string | null
  interval_seconds?: number | null
  agent_type?: RoutineAgentType
  prompt?: string
  enabled?: 0 | 1
}

export interface CustomSSHHost {
  id: string
  alias: string
  hostname: string
  user: string
  port: number
  identity_file: string | null
}

/* ================= SSH Preflight / Test Connection ================= */

export interface SSHPreflightParams {
  role: EnvironmentRole
  platform: EnvironmentPlatform
  ssh_host: string
  ssh_user?: string
  ssh_port?: number
  ssh_key_path?: string
  ssh_auth_method?: SSHAuthMethod
  ssh_password?: string
  remote_path: string
}

export type SSHPreflightStage =
  | 'dns'
  | 'tcp'
  | 'handshake'
  | 'auth'
  | 'shell'
  | 'path'
  | 'git'

export interface SSHPreflightResult {
  ok: boolean
  stage?: SSHPreflightStage
  code?: string
  message?: string
  hint?: string
  details?: Record<string, string | number | boolean>
}

/* ======================== Agent Settings ======================== */

export interface AgentInstanceSettings {
  enabled: boolean
  skip_permissions: boolean
  use_chrome: boolean
}

export interface AgentSettings {
  claude: AgentInstanceSettings
  gemini: AgentInstanceSettings
  codex: AgentInstanceSettings
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  claude: { enabled: true, skip_permissions: true, use_chrome: true },
  gemini: { enabled: false, skip_permissions: false, use_chrome: false },
  codex: { enabled: false, skip_permissions: false, use_chrome: false },
}

/* ======================== Error tracking ======================== */

export type AppPlatform = 'javascript' | 'node' | 'browser' | 'php' | 'python' | 'other'
export type IssueStatus =
  | 'open'
  | 'resolved'
  | 'ignored'
  /** Marked as "fixed in next release" — flips back to open on first new event after release. */
  | 'resolved_in_next_release'
  /** User explicitly discarded this fingerprint. Future events with the same
   *  fingerprint are dropped silently by the ingest path; the issue row stays
   *  for audit / accidental-unmute but is hidden from the default open list. */
  | 'excluded'
export type IssueLevel = 'debug' | 'info' | 'warning' | 'error' | 'fatal'

export interface ReportingApp {
  id: string
  project_id: string
  environment_id: string | null
  name: string
  platform: AppPlatform
  public_key: string
  is_active: boolean
  /** Set when the install agent POSTs /ingest/v1/confirm-install after
   *  successfully wiring the SDK. Null until then, so the Issues UI stays
   *  in the setup wizard even if stray events arrived earlier. */
  install_confirmed_at?: string | null
  created_at: string
  updated_at: string
  /** Populated only by endpoints that return a DSN alongside the app. */
  dsn?: string
}

/** A "reporter-facing" user shape — only fields the UI needs to render an
 *  avatar + name + email. Keep this narrow: the issuer role must not be
 *  able to learn about other users' teams / tokens / projects through it. */
export interface PublicUser {
  id: number
  name: string
  email: string
  avatar_url: string | null
}

/** Where an issue was born. Drives the "Reported by" panel in IssueDetailView
 *  and the source-filter tabs (All / Auto / Manual) in IssuesListView. */
export type IssueSource = 'sdk' | 'manual'

export interface Issue {
  id: string
  app_id: string
  fingerprint: string
  title: string
  culprit: string | null
  /** Manual issues carry free-form prose the reporter typed into the
   *  "Report issue" form. Null for SDK-captured issues — their body lives
   *  on the latest_event (exception / breadcrumbs / context). */
  description: string | null
  status: IssueStatus
  resolved_in_release_id: string | null
  level: IssueLevel
  /** Populated by the backend on every payload; defaults to 'sdk' for
   *  legacy rows so the frontend can rely on it existing. */
  source: IssueSource
  /** User id of whoever manually reported this issue, null for SDK.
   *  Foreign key to the `users` table in the Laravel backend. */
  created_by_user_id: number | null
  /** Eager-loaded when the backend knows it and the caller is authorised
   *  to see it (not for issuer role viewing someone else's report). */
  creator: PublicUser | null
  occurrences_count: number
  first_seen_at: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export interface IssueEvent {
  id: string
  issue_id: string
  app_id: string
  release_id: string | null
  event_id: string
  platform: string | null
  level: IssueLevel
  message: string | null
  exception: {
    type: string
    value?: string
    frames: Array<{
      filename?: string
      function?: string
      lineno?: number
      colno?: number
      pre_context?: string[]
      context_line?: string
      post_context?: string[]
    }>
  } | null
  breadcrumbs: Array<{
    timestamp?: string
    type?: string
    category?: string
    message?: string
    data?: unknown
  }> | null
  contexts: Record<string, unknown> | null
  tags: Record<string, string> | null
  /** IP of the remote client that sent this event to the ingest endpoint.
   *  Populated by the Laravel controller from `request()->ip()`. Null for
   *  rows created before v0.8.0 and for issues whose source is 'manual'. */
  ip: string | null
  /** Raw `User-Agent` header from the ingest request. The UI parses this
   *  into a friendly "Chrome 124 on macOS" label via UserAgentLabel. */
  user_agent: string | null
  /** Identifying info about the END user of the monitored app — i.e. the
   *  person whose browser / app raised the error. Set by the SDK caller
   *  via `Alby.setUser({ id, email, username })`. Only `email` is strongly
   *  relied on by the UI today; id / username are opportunistic. */
  user_context: { id?: string | number; email?: string; username?: string } | null
  received_at: string
  occurred_at: string | null
}

export interface Release {
  id: string
  app_id: string
  version: string
  environment: string | null
  released_at: string | null
  created_at: string
}

export interface WebhookConfig {
  id: string
  app_id: string
  url: string
  events: string[]
  is_active: boolean
  last_delivered_at: string | null
  last_delivery_status: string | null
  created_at: string
  /** Returned only on create/rotate — never on list. */
  secret?: string
}

export interface NotificationSubscription {
  app_id: string
  user_id: number
  /** - `new_issue`: first time a given fingerprint is seen on this app.
   *  - `regression`: a resolved issue started firing again.
   *  - `every_event`: every subsequent occurrence of an existing issue —
   *    deliberately noisy, opt-in only. */
  triggers: Array<'new_issue' | 'regression' | 'every_event'>
  /** Per-channel delivery flags. Missing → treat as email-only (backward compat).
   *  `push` is handled entirely by the Alby desktop client: the server just
   *  stores the preference so it syncs across a user's devices. */
  channels?: { email?: boolean; slack?: boolean; push?: boolean }
  user?: {
    id: number
    name: string
    email: string
  }
}

export interface UserSlackWebhook {
  user_id: number
  webhook_url: string
}

export interface CreateAppDTO {
  name: string
  platform?: AppPlatform
}

export interface UpdateAppDTO {
  name?: string
  platform?: AppPlatform
  is_active?: boolean
}

export interface IssueListFilters {
  status?: IssueStatus | IssueStatus[] | 'all'
  level?: IssueLevel | IssueLevel[]
  /** 'sdk' | 'manual' | 'all' (default 'all'). Drives the source tabs in
   *  IssuesListView. The backend treats missing / 'all' identically. */
  source?: IssueSource | 'all'
  q?: string
  sort?: 'last_seen_at' | 'first_seen_at' | 'occurrences_count'
  dir?: 'asc' | 'desc'
  per_page?: number
  page?: number
}

export interface UpdateIssueDTO {
  status?: IssueStatus
  resolved_in_release_id?: string | null
  level?: IssueLevel
}

/** Payload for the "Report issue" form. The backend infers `source='manual'`
 *  and `created_by_user_id` from the authenticated user — the client only
 *  sends the human content. */
export interface CreateIssueDTO {
  title: string
  description?: string | null
  /** Defaults to 'error' on the server if omitted. Kept optional so a
   *  one-field form still works. */
  level?: IssueLevel
}

export interface CreateReleaseDTO {
  version: string
  environment?: string | null
  released_at?: string | null
}

export interface CreateWebhookDTO {
  url: string
  events: string[]
  is_active?: boolean
}

export interface UpdateWebhookDTO {
  url?: string
  events?: string[]
  is_active?: boolean
}

export interface UpsertNotificationSubDTO {
  user_id?: number
  triggers: Array<'new_issue' | 'regression' | 'every_event'>
  channels?: { email?: boolean; slack?: boolean; push?: boolean }
}

/** Event pushed by Reverb when a new issue / regression / new event happens. */
export interface IssueLiveEvent {
  name: 'issue.created' | 'issue.regression' | 'issue.new_event'
  issue_id: string
  app_id: string
  event_id: string
  title?: string
  level?: IssueLevel
  status?: IssueStatus
  occurrences_count?: number
  last_seen_at?: string | null
}

/** Event pushed by Reverb asking the Electron main to spawn an agent. */
export interface AutoFixRequestedEvent {
  project_id: string
  task_id: string
  environment_id: string
  issue_id: string
  agent_type: 'claude' | 'gemini' | 'codex'
}
