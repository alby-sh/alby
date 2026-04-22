import { ipcMain } from 'electron'
import https from 'https'
import http from 'http'
import type Database from 'better-sqlite3'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'
import { ProjectsRepo } from '../db/projects.repo'
import type {
  CreateProjectDTO,
  CreateEnvironmentDTO,
  CreateTaskDTO,
  CreateStackDTO,
  UpdateProjectDTO,
  UpdateEnvironmentDTO,
  UpdateTaskDTO,
  UpdateStackDTO,
  Project,
  Environment,
  Task,
  Stack
} from '../../shared/types'

/* ======================== Favicon fetcher (unchanged from local version) ===== */

function fetchUrl(url: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) { reject(new Error('Too many redirects')); return }
        let loc = res.headers.location
        if (loc.startsWith('/')) {
          const u = new URL(url)
          loc = `${u.protocol}//${u.host}${loc}`
        }
        resolve(fetchUrl(loc, maxRedirects - 1))
        return
      }
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

function parseFaviconFromHtml(html: string, baseUrl: string): string | null {
  const linkRegex = /<link\s+[^>]*rel\s*=\s*["']([^"']*icon[^"']*)["'][^>]*>/gi
  const candidates: { url: string; size: number; priority: number }[] = []
  let match: RegExpExecArray | null
  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0]
    const rel = match[1].toLowerCase()
    const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/)
    if (!hrefMatch) continue
    let href = hrefMatch[1]
    if (href.startsWith('//')) href = 'https:' + href
    else if (href.startsWith('/')) {
      try { const u = new URL(baseUrl); href = `${u.protocol}//${u.host}${href}` } catch { continue }
    } else if (!href.startsWith('http')) {
      try { href = new URL(href, baseUrl).toString() } catch { continue }
    }
    const sizeMatch = tag.match(/sizes\s*=\s*["'](\d+)x\d+["']/)
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 16
    const priority = rel.includes('apple-touch-icon') ? 0 : 1
    candidates.push({ url: href, size, priority })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const aInRange = a.size >= 32 && a.size <= 96 ? 1 : 0
    const bInRange = b.size >= 32 && b.size <= 96 ? 1 : 0
    if (aInRange !== bInRange) return bInRange - aInRange
    return b.size - a.size
  })
  return candidates[0].url
}

async function fetchFaviconForDomain(website: string): Promise<string | null> {
  let domain = website.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (!domain || !domain.includes('.')) return null
  const baseUrl = `https://${domain}`
  try {
    const html = await fetchUrl(baseUrl)
    const favicon = parseFaviconFromHtml(html, baseUrl)
    if (favicon) return favicon
  } catch {
    try {
      const html = await fetchUrl(`http://${domain}`)
      const favicon = parseFaviconFromHtml(html, `http://${domain}`)
      if (favicon) return favicon
    } catch { /* ignore */ }
  }
  return `${baseUrl}/favicon.ico`
}

async function pickBestWebsiteAndUpdateFavicon(projectId: string): Promise<void> {
  try {
    // Never trample a favicon the user already picked (uploaded image, manual
    // URL, previous auto-fetch). Auto-fetch only bootstraps when nothing is
    // set — the Project Settings page has an explicit "Auto-fetch from
    // domain" button for the re-fetch case. Previously this fired on every
    // env-save / env-create and silently overwrote custom uploads.
    const project = await cloudClient.getProject(projectId).catch(() => null)
    if (project?.favicon_url) return

    const envs = await cloudClient.listEnvironments(projectId)
    if (envs.length === 0) return
    const prodEnv = envs.find((e) => ['production', 'prod', 'live'].includes(e.name.toLowerCase()))
    const website = (prodEnv?.label && prodEnv.label.includes('.')) ? prodEnv.label
      : envs.find((e) => e.label && e.label.includes('.'))?.label
    if (!website) return
    const faviconUrl = await fetchFaviconForDomain(website)
    if (faviconUrl) {
      await cloudClient.updateProject(projectId, { favicon_url: faviconUrl })
    }
  } catch { /* best-effort */ }
}

/**
 * The IPC contract is unchanged so the renderer doesn't need to know we're
 * cloud-backed now — but every read/write goes through alby.sh.
 *
 * The `db` argument is kept for the (still-local) agent runtime state and
 * for the migration step in auth.ipc.ts.
 */
export function registerProjectsIPC(db: Database.Database): void {
  const repo = new ProjectsRepo(db)

  // Helper to gracefully short-circuit when not authenticated. Returns the
  // fallback so renderer queries don't crash; React Query just shows empty state.
  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!(await loadToken())) return fallback
    try {
      return await fn()
    } catch (err) {
      console.error('[cloud]', (err as Error).message)
      return fallback
    }
  }

  // Swallow cache-write errors — the cloud copy is authoritative, and a local
  // mirror failure just means runtime lookups may need a fallback fetch.
  const mirror = (fn: () => void): void => {
    try { fn() } catch (err) { console.warn('[cache mirror]', (err as Error).message) }
  }

  // ---------- Projects ----------
  ipcMain.handle('projects:list', async () => {
    const list = await safe(() => cloudClient.listProjects(), [] as Project[])
    list.forEach((p) => mirror(() => repo.upsertProject(p)))
    return list
  })

  ipcMain.handle('projects:get', async (_, id: string) => {
    const p = await safe(() => cloudClient.getProject(id), null as Project | null)
    if (p) mirror(() => repo.upsertProject(p))
    return p
  })

  ipcMain.handle('projects:create', async (_, data: CreateProjectDTO) => {
    // Default owner to the current user if the renderer didn't override with a
    // team — the renderer passes `owner_type: 'team'` when the user created the
    // project from inside a team workspace selector.
    const { owner_type, owner_id, ...rest } = data
    let resolvedType: 'user' | 'team' = owner_type ?? 'user'
    let resolvedId: string | null = owner_id ?? null
    if (!resolvedId) {
      const me = await cloudClient.me()
      resolvedType = 'user'
      resolvedId = String(me.user.id)
    }
    const p = await cloudClient.createProject({
      ...rest,
      owner_type: resolvedType,
      owner_id: resolvedId
    })
    mirror(() => repo.upsertProject(p))
    return p
  })

  ipcMain.handle('projects:update', async (_, id: string, data: UpdateProjectDTO) => {
    const p = await cloudClient.updateProject(id, data)
    mirror(() => repo.upsertProject(p))
    return p
  })

  ipcMain.handle('projects:delete', async (_, id: string) => {
    await cloudClient.deleteProject(id)
    mirror(() => repo.deleteProject(id))
  })

  ipcMain.handle('projects:reorder', async (_, orderedIds: string[]) => {
    const result = await cloudClient.reorderProjects(orderedIds)
    mirror(() => repo.reorderProjects(orderedIds))
    return result
  })

  ipcMain.handle('projects:transfer', async (_, id: string, ownerType: 'user' | 'team', ownerId: string) => {
    const p = await cloudClient.transferProject(id, ownerType, ownerId)
    mirror(() => repo.upsertProject(p))
    return p
  })

  // ---------- Stacks ----------
  ipcMain.handle('stacks:list', async (_, projectId: string) => {
    const list = await safe(() => cloudClient.listStacks(projectId), [] as Stack[])
    list.forEach((s) => mirror(() => repo.upsertStack(s)))
    return list
  })

  ipcMain.handle('stacks:get', async (_, id: string) => {
    const s = await safe(() => cloudClient.getStack(id), null as Stack | null)
    if (s) mirror(() => repo.upsertStack(s))
    return s
  })

  ipcMain.handle('stacks:create', async (_, data: CreateStackDTO) => {
    const s = await cloudClient.createStack(data.project_id, {
      name: data.name,
      slug: data.slug,
      kind: data.kind,
      favicon_url: data.favicon_url,
      git_remote_url: data.git_remote_url,
      default_branch: data.default_branch,
    })
    mirror(() => repo.upsertStack(s))
    return s
  })

  ipcMain.handle('stacks:update', async (_, id: string, data: UpdateStackDTO) => {
    const s = await cloudClient.updateStack(id, data)
    mirror(() => repo.upsertStack(s))
    return s
  })

  ipcMain.handle('stacks:delete', async (_, id: string) => {
    await cloudClient.deleteStack(id)
    mirror(() => repo.deleteStack(id))
  })

  ipcMain.handle('stacks:reorder', async (_, projectId: string, orderedIds: string[]) => {
    // Cloud doesn't expose a dedicated reorder endpoint for stacks — mirror the
    // env strategy: one sort_order update per id, then sync the local cache so
    // the sidebar reflects the new order even if React Query's cached list is
    // consulted before the next fetch.
    await Promise.all(orderedIds.map((id, i) => cloudClient.updateStack(id, { sort_order: i })))
    mirror(() => repo.reorderStacks(projectId, orderedIds))
  })

  // ---------- Environments ----------
  ipcMain.handle('environments:list', async (_, projectId: string) => {
    const list = await safe(() => cloudClient.listEnvironments(projectId), [] as Environment[])
    list.forEach((e) => {
      mirror(() => repo.upsertEnvironment(e))
      if (e.stack) mirror(() => repo.upsertStack(e.stack!))
    })
    return list
  })

  ipcMain.handle('environments:get', async (_, id: string) => {
    const e = await safe(() => cloudClient.getEnvironment(id), null as Environment | null)
    if (e) mirror(() => repo.upsertEnvironment(e))
    return e
  })

  ipcMain.handle('environments:create', async (_, data: CreateEnvironmentDTO) => {
    // stack_id is nominally required server-side, but we let the backend
    // auto-resolve to the project's first stack when omitted (handy for
    // legacy projects that still have a single Default stack and clients
    // that don't surface a stack picker).
    const payload: Partial<CreateEnvironmentDTO> & { remote_path: string } = {
      name: data.name,
      remote_path: data.remote_path,
    }
    if (data.stack_id) payload.stack_id = data.stack_id
    if (data.label !== undefined) payload.label = data.label
    if (data.execution_mode !== undefined) payload.execution_mode = data.execution_mode
    if (data.role !== undefined) payload.role = data.role
    if (data.platform !== undefined) payload.platform = data.platform
    if (data.ssh_host !== undefined) payload.ssh_host = data.ssh_host
    if (data.ssh_user !== undefined) payload.ssh_user = data.ssh_user
    if (data.ssh_port !== undefined) payload.ssh_port = data.ssh_port
    if (data.ssh_key_path !== undefined) payload.ssh_key_path = data.ssh_key_path
    if (data.ssh_auth_method !== undefined) payload.ssh_auth_method = data.ssh_auth_method
    if (data.ssh_password !== undefined) payload.ssh_password = data.ssh_password
    if (data.deploy_config !== undefined) payload.deploy_config = data.deploy_config
    const env = await cloudClient.createEnvironment(
      data.project_id,
      payload as Omit<CreateEnvironmentDTO, 'project_id'>
    )
    mirror(() => repo.upsertEnvironment(env))
    if (env.stack) mirror(() => repo.upsertStack(env.stack!))
    if (data.label && data.label.includes('.')) {
      pickBestWebsiteAndUpdateFavicon(data.project_id)
    }
    return env
  })

  ipcMain.handle('environments:update', async (_, id: string, data: UpdateEnvironmentDTO) => {
    const env = await cloudClient.updateEnvironment(id, data)
    mirror(() => repo.upsertEnvironment(env))
    if (data.label !== undefined && env.project_id) {
      pickBestWebsiteAndUpdateFavicon(env.project_id)
    }
    return env
  })

  ipcMain.handle('environments:delete', async (_, id: string) => {
    await cloudClient.deleteEnvironment(id)
    mirror(() => repo.deleteEnvironment(id))
  })

  ipcMain.handle('environments:reorder', async (_, projectId: string, orderedIds: string[]) => {
    // Cloud doesn't expose a dedicated reorder endpoint for envs yet — fall back
    // to per-item updates with sort_order.
    await Promise.all(orderedIds.map((id, i) => cloudClient.updateEnvironment(id, { sort_order: i })))
    mirror(() => repo.reorderEnvironments(projectId, orderedIds))
    return { ok: true }
  })

  ipcMain.handle('environments:enable-monitoring', async (_, id: string) => {
    return cloudClient.enableEnvironmentMonitoring(id)
  })

  ipcMain.handle('environments:disable-monitoring', async (_, id: string) => {
    await cloudClient.disableEnvironmentMonitoring(id)
  })

  // Read a private-key file off disk on behalf of the renderer. Used by the
  // Add/Edit environment UI when the user enables "Sync to cloud" on a key
  // that currently lives at a path (~/.ssh/id_rsa etc.) — the renderer can't
  // read files directly, so we slurp and return the content for upload.
  // Resolves ~ to homedir and only reads regular files under a few sane
  // roots; anything else returns null.
  ipcMain.handle('environments:read-private-key', async (_, absolutePath: string): Promise<string | null> => {
    if (!absolutePath || typeof absolutePath !== 'string') return null
    try {
      const { readFileSync, statSync } = await import('fs')
      const { homedir } = await import('os')
      const expanded = absolutePath.replace(/^~(?=\/|$)/, homedir())
      const st = statSync(expanded)
      if (!st.isFile()) return null
      // Cap at 64 KiB — private keys are well under 10 KiB; any file this
      // big isn't one and we don't want the renderer to accidentally slurp
      // something huge into memory.
      if (st.size > 64 * 1024) return null
      return readFileSync(expanded, 'utf8')
    } catch (err) {
      console.warn('[env] read-private-key failed:', (err as Error).message)
      return null
    }
  })

  // ---------- Tasks ----------
  ipcMain.handle('tasks:list', async (_, environmentId: string) => {
    const list = await safe(() => cloudClient.listTasks(environmentId), [] as Task[])
    list.forEach((t) => mirror(() => repo.upsertTask(t)))
    return list
  })

  ipcMain.handle('tasks:create', async (_, data: CreateTaskDTO) => {
    const t = await cloudClient.createTask(data.environment_id, {
      title: data.title,
      description: data.description,
      context_notes: data.context_notes
    })
    mirror(() => repo.upsertTask(t))
    return t
  })

  ipcMain.handle('tasks:update', async (_, id: string, data: UpdateTaskDTO) => {
    const t = await cloudClient.updateTask(id, data)
    mirror(() => repo.upsertTask(t))
    return t
  })

  ipcMain.handle('tasks:delete', async (_, id: string) => {
    await cloudClient.deleteTask(id)
    mirror(() => repo.deleteTask(id))
  })

  ipcMain.handle('tasks:reorder', async (_, environmentId: string, orderedIds: string[]) => {
    await Promise.all(orderedIds.map((id, i) => cloudClient.updateTask(id, { sort_order: i })))
    mirror(() => repo.reorderTasks(environmentId, orderedIds))
    return { ok: true }
  })

  ipcMain.handle('audit:project', (_, projectId: string) =>
    safe(() => cloudClient.listProjectAudit(projectId), [])
  )

  ipcMain.handle('audit:record', async (_, payload: {
    project_id: string
    entity_type: string
    entity_id: string
    action: string
    summary?: string
    diff?: unknown
  }) => {
    try { await cloudClient.recordAudit(payload) } catch (err) {
      console.warn('[audit:record]', (err as Error).message)
    }
  })

  ipcMain.handle(
    'tasks:by-project',
    (
      _,
      projectId: string,
      params?: Parameters<typeof cloudClient.listProjectTasks>[1],
    ) =>
      safe(() => cloudClient.listProjectTasks(projectId, params), {
        data: [],
        current_page: 1,
        last_page: 1,
        per_page: params?.per_page ?? 50,
        total: 0,
      })
  )

  ipcMain.handle(
    'tasks:by-stack',
    (
      _,
      stackId: string,
      params?: Parameters<typeof cloudClient.listStackTasks>[1],
    ) =>
      safe(() => cloudClient.listStackTasks(stackId, params), {
        data: [],
        current_page: 1,
        last_page: 1,
        per_page: params?.per_page ?? 50,
        total: 0,
      })
  )
}
