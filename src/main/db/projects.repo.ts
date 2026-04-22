import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import type {
  Project,
  Environment,
  Task,
  CreateProjectDTO,
  CreateEnvironmentDTO,
  CreateTaskDTO,
  UpdateProjectDTO,
  UpdateEnvironmentDTO,
  UpdateTaskDTO,
  AgentSettings,
  Stack,
  StackKind,
  AutoFixAgentType
} from '../../shared/types'

function parseAgentSettings(row: Record<string, unknown>): void {
  if (row.agent_settings && typeof row.agent_settings === 'string') {
    try { row.agent_settings = JSON.parse(row.agent_settings as string) } catch { row.agent_settings = null }
  }
  if (row.deploy_config && typeof row.deploy_config === 'string') {
    try { row.deploy_config = JSON.parse(row.deploy_config as string) } catch { row.deploy_config = null }
  }
}

function rowToStack(row: Record<string, unknown>): Stack {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    name: String(row.name),
    slug: (row.slug as string | null) ?? null,
    kind: ((row.kind as StackKind) ?? 'custom'),
    favicon_url: (row.favicon_url as string | null) ?? null,
    git_remote_url: (row.git_remote_url as string | null) ?? null,
    default_branch: String(row.default_branch ?? 'main'),
    auto_fix_enabled: Boolean(row.auto_fix_enabled),
    auto_fix_agent_type: ((row.auto_fix_agent_type as AutoFixAgentType) ?? 'claude'),
    auto_fix_target_env_id: (row.auto_fix_target_env_id as string | null) ?? null,
    auto_fix_max_per_day: Number(row.auto_fix_max_per_day ?? 5),
    sort_order: Number(row.sort_order ?? 0),
    created_at: (row.created_at as string | undefined),
    updated_at: (row.updated_at as string | undefined),
  }
}

export class ProjectsRepo {
  constructor(private db: Database.Database) {}

  // --- Projects ---
  listProjects(): Project[] {
    return this.db
      .prepare('SELECT * FROM projects ORDER BY sort_order, created_at')
      .all() as Project[]
  }

  getProject(id: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined
  }

  createProject(data: CreateProjectDTO): Project {
    const id = uuid()
    const maxOrder = (
      this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM projects').get() as {
        m: number
      }
    ).m
    this.db
      .prepare(
        'INSERT INTO projects (id, name, execution_mode, sort_order) VALUES (?, ?, ?, ?)'
      )
      .run(id, data.name, data.execution_mode || 'remote', maxOrder + 1)
    return this.getProject(id)!
  }

  updateProject(id: string, data: UpdateProjectDTO): Project {
    const fields: string[] = []
    const values: unknown[] = []
    if (data.name !== undefined) {
      fields.push('name = ?')
      values.push(data.name)
    }
    if (data.execution_mode !== undefined) {
      fields.push('execution_mode = ?')
      values.push(data.execution_mode)
    }
    if (data.favicon_url !== undefined) {
      fields.push('favicon_url = ?')
      values.push(data.favicon_url)
    }
    if (data.url !== undefined) {
      fields.push('url = ?')
      values.push(data.url)
    }
    if (data.pinned !== undefined) {
      fields.push('pinned = ?')
      values.push(data.pinned)
    }
    if (fields.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.getProject(id)!
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  // --- Environments ---
  listEnvironments(projectId: string): Environment[] {
    const rows = this.db
      .prepare('SELECT * FROM environments WHERE project_id = ? ORDER BY sort_order, created_at')
      .all(projectId) as Record<string, unknown>[]
    rows.forEach(parseAgentSettings)
    return rows as unknown as Environment[]
  }

  getEnvironment(id: string): Environment | undefined {
    const row = this.db
      .prepare('SELECT * FROM environments WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined
    if (row) parseAgentSettings(row)
    return row as unknown as Environment | undefined
  }

  createEnvironment(data: CreateEnvironmentDTO & { id?: string }): Environment {
    const id = data.id || uuid()
    const maxOrder = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sort_order), -1) as m FROM environments WHERE project_id = ?'
        )
        .get(data.project_id) as { m: number }
    ).m
    this.db
      .prepare(
        `INSERT INTO environments (id, project_id, name, label, execution_mode, role, platform, ssh_host, ssh_user, ssh_port, ssh_key_path, remote_path, launch_command, deploy_config, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.project_id,
        data.name,
        data.label || null,
        data.execution_mode || 'remote',
        data.role || 'operational',
        data.platform || 'linux',
        data.ssh_host || '',
        data.ssh_user || null,
        data.ssh_port || 22,
        data.ssh_key_path || null,
        data.remote_path,
        data.launch_command ?? null,
        data.deploy_config ? JSON.stringify(data.deploy_config) : null,
        maxOrder + 1
      )
    return this.getEnvironment(id)!
  }

  updateEnvironment(id: string, data: UpdateEnvironmentDTO): Environment {
    const jsonFields = new Set(['agent_settings', 'deploy_config'])
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`)
        values.push(jsonFields.has(key) ? (value === null ? null : JSON.stringify(value)) : value)
      }
    }
    if (fields.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE environments SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.getEnvironment(id)!
  }

  deleteEnvironment(id: string): void {
    this.db.prepare('DELETE FROM environments WHERE id = ?').run(id)
  }

  // --- Tasks ---
  listTasks(environmentId: string): Task[] {
    return this.db
      .prepare(
        'SELECT * FROM tasks WHERE environment_id = ? ORDER BY sort_order, created_at'
      )
      .all(environmentId) as Task[]
  }

  getTask(id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
  }

  createTask(data: CreateTaskDTO): Task {
    const id = uuid()
    const maxOrder = (
      this.db
        .prepare(
          'SELECT COALESCE(MAX(sort_order), -1) as m FROM tasks WHERE environment_id = ?'
        )
        .get(data.environment_id) as { m: number }
    ).m
    this.db
      .prepare(
        `INSERT INTO tasks (id, environment_id, title, description, context_notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.environment_id,
        data.title,
        data.description || null,
        data.context_notes || null,
        maxOrder + 1
      )
    return this.getTask(id)!
  }

  updateTask(id: string, data: UpdateTaskDTO): Task {
    const existing = this.getTask(id)
    if (existing?.is_default) {
      // Only status changes are allowed on the default "general" task.
      const allowed: UpdateTaskDTO = {}
      if (data.status !== undefined) allowed.status = data.status
      data = allowed
    }
    const fields: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`)
        values.push(value)
      }
    }
    if (fields.length > 0) {
      values.push(id)
      this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
    }
    return this.getTask(id)!
  }

  deleteTask(id: string): void {
    const existing = this.getTask(id)
    if (existing?.is_default) {
      throw new Error('Cannot delete the default "general" task')
    }
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  /**
   * Ensure every environment has a protected default task named "general" —
   * used as the fallback target when the user launches an agent without
   * picking a task. The task is immutable (update/delete blocked) and carries
   * no context so agents spawned on it start clean.
   */
  ensureGeneralTask(environmentId: string): Task {
    const existing = this.db
      .prepare('SELECT * FROM tasks WHERE environment_id = ? AND is_default = 1')
      .get(environmentId) as Task | undefined
    if (existing) return existing
    const id = uuid()
    this.db
      .prepare(
        `INSERT INTO tasks (id, environment_id, title, description, context_notes, is_default, sort_order)
         VALUES (?, ?, 'general', NULL, NULL, 1, -1)`
      )
      .run(id, environmentId)
    return this.getTask(id)!
  }

  ensureGeneralTaskForAllEnvironments(): void {
    const envs = this.db.prepare('SELECT id FROM environments').all() as { id: string }[]
    for (const env of envs) this.ensureGeneralTask(env.id)
  }

  reorderProjects(orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id))
    })
    tx()
  }

  reorderEnvironments(projectId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE environments SET sort_order = ? WHERE id = ? AND project_id = ?')
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id, projectId))
    })
    tx()
  }

  reorderTasks(environmentId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ? AND environment_id = ?')
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id, environmentId))
    })
    tx()
  }

  reorderStacks(projectId: string, orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE stacks SET sort_order = ? WHERE id = ? AND project_id = ?')
    const tx = this.db.transaction(() => {
      orderedIds.forEach((id, i) => stmt.run(i, id, projectId))
    })
    tx()
  }

  // --- Cloud cache mirror ---
  // The cloud (alby.sh) is authoritative; these upserts keep local SQLite in
  // sync so runtime code (agent-manager etc.) can read synchronously without
  // hitting the network on every spawn.

  upsertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, execution_mode, favicon_url, url, created_at, sort_order, pinned)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0), COALESCE(?, 0))
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           execution_mode = excluded.execution_mode,
           favicon_url = excluded.favicon_url,
           url = excluded.url,
           sort_order = excluded.sort_order,
           pinned = excluded.pinned`
      )
      .run(
        p.id,
        p.name,
        p.execution_mode || 'remote',
        p.favicon_url ?? null,
        p.url ?? null,
        p.created_at ?? null,
        p.sort_order ?? 0,
        p.pinned ?? 0
      )
  }

  upsertEnvironment(e: Environment): void {
    this.db
      .prepare(
        `INSERT INTO environments (
           id, project_id, stack_id, name, label, execution_mode, role, platform,
           ssh_host, ssh_user, ssh_port, ssh_key_path, ssh_auth_method,
           ssh_password, remote_path, launch_command,
           agent_settings, deploy_config, git_remote_url, created_at, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0))
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           stack_id = excluded.stack_id,
           name = excluded.name,
           label = excluded.label,
           execution_mode = excluded.execution_mode,
           role = excluded.role,
           platform = excluded.platform,
           ssh_host = excluded.ssh_host,
           ssh_user = excluded.ssh_user,
           ssh_port = excluded.ssh_port,
           ssh_key_path = excluded.ssh_key_path,
           ssh_auth_method = excluded.ssh_auth_method,
           -- Preserve locally-stored password when the cloud omits it from
           -- the response (some backends redact credentials on GET for
           -- security). Overwrite only if the cloud provided a new value.
           ssh_password = COALESCE(excluded.ssh_password, environments.ssh_password),
           remote_path = excluded.remote_path,
           launch_command = excluded.launch_command,
           agent_settings = excluded.agent_settings,
           deploy_config = excluded.deploy_config,
           git_remote_url = excluded.git_remote_url,
           sort_order = excluded.sort_order`
      )
      .run(
        e.id,
        e.project_id,
        (e as { stack_id?: string | null }).stack_id ?? null,
        e.name,
        e.label ?? null,
        e.execution_mode || 'remote',
        e.role ?? 'operational',
        e.platform ?? 'linux',
        e.ssh_host ?? '',
        e.ssh_user ?? null,
        e.ssh_port ?? 22,
        e.ssh_key_path ?? null,
        e.ssh_auth_method ?? 'key',
        e.ssh_password ?? null,
        e.remote_path,
        e.launch_command ?? null,
        e.agent_settings ? JSON.stringify(e.agent_settings) : null,
        e.deploy_config ? JSON.stringify(e.deploy_config) : null,
        (e as { git_remote_url?: string | null }).git_remote_url ?? null,
        e.created_at ?? null,
        e.sort_order ?? 0
      )
  }

  upsertStack(s: Stack): void {
    this.db
      .prepare(
        `INSERT INTO stacks (
           id, project_id, name, slug, kind, favicon_url, git_remote_url, default_branch,
           auto_fix_enabled, auto_fix_agent_type, auto_fix_target_env_id, auto_fix_max_per_day,
           sort_order, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           name = excluded.name,
           slug = excluded.slug,
           kind = excluded.kind,
           favicon_url = excluded.favicon_url,
           git_remote_url = excluded.git_remote_url,
           default_branch = excluded.default_branch,
           auto_fix_enabled = excluded.auto_fix_enabled,
           auto_fix_agent_type = excluded.auto_fix_agent_type,
           auto_fix_target_env_id = excluded.auto_fix_target_env_id,
           auto_fix_max_per_day = excluded.auto_fix_max_per_day,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`
      )
      .run(
        s.id,
        s.project_id,
        s.name,
        s.slug ?? null,
        s.kind ?? 'custom',
        s.favicon_url ?? null,
        s.git_remote_url ?? null,
        s.default_branch ?? 'main',
        s.auto_fix_enabled ? 1 : 0,
        s.auto_fix_agent_type ?? 'claude',
        s.auto_fix_target_env_id ?? null,
        s.auto_fix_max_per_day ?? 5,
        s.sort_order ?? 0,
        s.created_at ?? null,
        s.updated_at ?? null
      )
  }

  listStacks(projectId: string): Stack[] {
    const rows = this.db
      .prepare('SELECT * FROM stacks WHERE project_id = ? ORDER BY sort_order')
      .all(projectId) as Array<Record<string, unknown>>
    return rows.map(rowToStack)
  }

  getStack(id: string): Stack | null {
    const row = this.db.prepare('SELECT * FROM stacks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToStack(row) : null
  }

  deleteStack(id: string): void {
    this.db.prepare('DELETE FROM stacks WHERE id = ?').run(id)
  }

  upsertTask(t: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, environment_id, title, description, context_notes, status, is_default, created_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, 0))
         ON CONFLICT(id) DO UPDATE SET
           environment_id = excluded.environment_id,
           title = excluded.title,
           description = excluded.description,
           context_notes = excluded.context_notes,
           status = excluded.status,
           is_default = excluded.is_default,
           sort_order = excluded.sort_order`
      )
      .run(
        t.id,
        t.environment_id,
        t.title,
        t.description ?? null,
        t.context_notes ?? null,
        t.status || 'open',
        t.is_default ? 1 : 0,
        t.created_at ?? null,
        t.sort_order ?? 0
      )
  }

  getTaskWithEnvironment(
    taskId: string
  ): (Task & { environment: Environment; project: Project }) | undefined {
    const task = this.getTask(taskId)
    if (!task) return undefined
    const env = this.getEnvironment(task.environment_id)
    if (!env) return undefined
    const project = this.getProject(env.project_id)
    if (!project) return undefined
    return { ...task, environment: env, project }
  }
}
