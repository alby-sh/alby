import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Close, Copy, TrashCan } from '@carbon/icons-react'
import {
  useDeleteProject,
  useEnvironments,
  useProjects,
  useUpdateProject,
} from '../../hooks/useProjects'
import { useAllAgents } from '../../hooks/useAgents'
import { useAppStore } from '../../stores/app-store'
import { useAuthStore } from '../../stores/auth-store'
import { Identicon } from '../ui/ProjectIcon'
import type { Project } from '../../../shared/types'

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-4 py-8 md:grid-cols-10 border-b border-neutral-800 last:border-b-0">
      <div className="w-full space-y-1.5 md:col-span-4">
        <h3 className="text-[15px] font-semibold leading-none text-neutral-50">{title}</h3>
        <p className="text-[13px] text-neutral-400 text-balance">{description}</p>
      </div>
      <div className="md:col-span-6">{children}</div>
    </div>
  )
}

function PrimaryButton({
  children,
  disabled,
  onClick,
  type = 'button',
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center whitespace-nowrap rounded-lg h-9 px-4 text-[13px] font-medium border border-neutral-700 bg-neutral-800 text-neutral-50 hover:bg-neutral-700 disabled:opacity-50 disabled:pointer-events-none transition-colors"
    >
      {children}
    </button>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors"
    />
  )
}

function FaviconPreview({ url, seed, name }: { url: string; seed: string; name: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [url])
  if (!url || failed) {
    return (
      <div className="size-16 rounded-lg bg-neutral-900 border border-neutral-800 flex items-center justify-center p-2">
        <Identicon value={seed} size={48} />
      </div>
    )
  }
  return (
    <img
      src={url}
      alt={name}
      onError={() => setFailed(true)}
      className="size-16 rounded-lg object-contain bg-neutral-900 border border-neutral-800 p-2"
    />
  )
}

function suggestFaviconUrl(
  projectName: string,
  projectUrl?: string | null,
  envLabel?: string | null,
): string | null {
  // Priority: the project's own URL field (most authoritative, the user
  // typed it explicitly) → any env label that looks like a domain → the
  // project name if it happens to contain a dot. The previous signature
  // skipped projectUrl entirely, which is why the button was a no-op for
  // projects with no env label but a valid link.
  const candidates = [projectUrl, envLabel, projectName].filter(Boolean) as string[]
  for (const c of candidates) {
    const stripped = c.replace(/^https?:\/\//, '').split('/')[0]
    if (stripped.includes('.')) {
      return `https://www.google.com/s2/favicons?domain=${stripped}&sz=64`
    }
  }
  return null
}

export function ProjectSettingsView({ projectId }: { projectId: string }) {
  const { data: projects } = useProjects()
  const { data: environments } = useEnvironments(projectId)
  const { data: allAgents } = useAllAgents()
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()
  const closeProjectSettings = useAppStore((s) => s.closeProjectSettings)

  const project: Project | undefined = useMemo(
    () => projects?.find((p) => p.id === projectId),
    [projects, projectId]
  )

  const [name, setName] = useState('')
  const [iconUrl, setIconUrl] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [copyKey, setCopyKey] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showRunningBlock, setShowRunningBlock] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Hydrate local state when the project loads / changes
  useEffect(() => {
    if (project) {
      setName(project.name)
      setIconUrl(project.favicon_url ?? '')
      setLinkUrl(project.url ?? '')
    }
  }, [project])

  // Normalize a user-typed URL so plain "example.com" still works.
  const normalizeUrl = (raw: string): string => {
    const trimmed = raw.trim()
    if (!trimmed) return ''
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
  }

  const projectAgentCount = useMemo(() => {
    if (!allAgents) return 0
    return allAgents.filter((a) => a.project_id === projectId).length
  }, [allAgents, projectId])

  const runningAgentCount = useMemo(() => {
    if (!allAgents) return 0
    return allAgents.filter((a) => a.project_id === projectId && a.status === 'running').length
  }, [allAgents, projectId])

  const flashSaved = (key: string) => {
    setSavedKey(key)
    window.setTimeout(() => setSavedKey((current) => (current === key ? null : current)), 1800)
  }

  const handleSaveName = () => {
    const trimmed = name.trim()
    if (!project || !trimmed || trimmed === project.name) return
    updateProject.mutate(
      { id: projectId, data: { name: trimmed } },
      { onSuccess: () => flashSaved('name') }
    )
  }

  const handleSaveIcon = () => {
    const trimmed = iconUrl.trim()
    const next = trimmed === '' ? null : trimmed
    if (!project || next === (project.favicon_url ?? null)) return
    updateProject.mutate(
      { id: projectId, data: { favicon_url: next } },
      { onSuccess: () => flashSaved('icon') }
    )
  }

  const handleSaveLink = () => {
    if (!project) return
    const next = linkUrl.trim() === '' ? null : normalizeUrl(linkUrl)
    if (next === (project.url ?? null)) return
    if (next) setLinkUrl(next) // reflect normalized form back into the input
    updateProject.mutate(
      { id: projectId, data: { url: next } },
      { onSuccess: () => flashSaved('link') }
    )
  }

  const handleAutoFetch = () => {
    if (!project) return
    const url = suggestFaviconUrl(project.name, project.url, environments?.[0]?.label)
    if (url) setIconUrl(url)
  }

  const handlePickFile = () => {
    setUploadError(null)
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setUploadError('Please select an image file.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      setUploadError('Image too large (max 5 MB).')
      return
    }
    setUploadError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        // Downscale to 128×128 PNG to keep DB rows small.
        const SIZE = 128
        const canvas = document.createElement('canvas')
        canvas.width = SIZE
        canvas.height = SIZE
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          setUploadError('Could not process image.')
          return
        }
        const scale = Math.min(SIZE / img.width, SIZE / img.height)
        const w = img.width * scale
        const h = img.height * scale
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'high'
        ctx.clearRect(0, 0, SIZE, SIZE)
        ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h)
        setIconUrl(canvas.toDataURL('image/png'))
      }
      img.onerror = () => setUploadError('Could not decode image.')
      img.src = reader.result as string
    }
    reader.onerror = () => setUploadError('Could not read file.')
    reader.readAsDataURL(file)
  }

  const handleCopy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyKey(key)
      window.setTimeout(() => setCopyKey((current) => (current === key ? null : current)), 1200)
    } catch { /* ignore */ }
  }

  const handleDelete = () => {
    if (!project) return
    setDeleting(true)
    deleteProject.mutate(projectId, {
      onSuccess: () => {
        setDeleting(false)
        setShowDeleteConfirm(false)
        closeProjectSettings()
      },
      onError: () => setDeleting(false),
    })
  }

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Project not found.
      </div>
    )
  }

  const created = new Date(project.created_at)
  const createdLabel = isNaN(created.getTime())
    ? project.created_at
    : created.toLocaleString()

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400">
          {project.name} <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">Settings</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeProjectSettings}
          aria-label="Close settings"
          title="Close"
          className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <Close size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">Project Settings</h2>
            <p className="text-[14px] text-neutral-400">
              Manage this project's appearance, metadata, and lifecycle.
            </p>
          </div>

          <div className="border-t border-neutral-800">
            <Section
              title="Project Icon"
              description="Shown in the sidebar. Paste a favicon URL or auto-fetch it from the project's domain."
            >
              <div className="flex items-start gap-4">
                <FaviconPreview url={iconUrl} seed={project.id} name={project.name} />
                <div className="flex-1 space-y-2">
                  <TextInput
                    value={iconUrl}
                    onChange={setIconUrl}
                    placeholder="https://example.com/favicon.ico"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={handlePickFile}
                      className="text-[12px] text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Upload file
                    </button>
                    <span className="text-neutral-700">·</span>
                    <button
                      type="button"
                      onClick={handleAutoFetch}
                      className="text-[12px] text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Auto-fetch from domain
                    </button>
                    <span className="text-neutral-700">·</span>
                    <button
                      type="button"
                      onClick={() => setIconUrl('')}
                      className="text-[12px] text-neutral-400 hover:text-neutral-200 transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />
                  {uploadError && (
                    <p className="text-[12px] text-red-400">{uploadError}</p>
                  )}
                  <div className="flex items-center gap-2 pt-1">
                    <PrimaryButton
                      onClick={handleSaveIcon}
                      disabled={
                        updateProject.isPending ||
                        (iconUrl.trim() === '' ? null : iconUrl.trim()) ===
                          (project.favicon_url ?? null)
                      }
                    >
                      Save Icon
                    </PrimaryButton>
                    {savedKey === 'icon' && (
                      <span className="text-[12px] text-emerald-400">Saved</span>
                    )}
                  </div>
                </div>
              </div>
            </Section>

            <Section
              title="Project Name"
              description="Used everywhere this project appears — sidebar, tabs, notifications."
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TextInput
                    value={name}
                    onChange={setName}
                    placeholder="Project name"
                  />
                  <PrimaryButton
                    onClick={handleSaveName}
                    disabled={
                      updateProject.isPending ||
                      !name.trim() ||
                      name.trim() === project.name
                    }
                  >
                    Save
                  </PrimaryButton>
                </div>
                <div className="flex items-center gap-2">
                  <p className="text-[11px] text-neutral-500">Max 64 characters</p>
                  {savedKey === 'name' && (
                    <span className="text-[11px] text-emerald-400">Saved</span>
                  )}
                </div>
              </div>
            </Section>

            <Section
              title="Project Link"
              description="An optional URL associated with this project (e.g. its homepage or GitHub repo). A shortcut button in the sidebar header opens it."
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TextInput
                    value={linkUrl}
                    onChange={setLinkUrl}
                    type="url"
                    placeholder="https://example.com"
                  />
                  <PrimaryButton
                    onClick={handleSaveLink}
                    disabled={
                      updateProject.isPending ||
                      (linkUrl.trim() === '' ? null : normalizeUrl(linkUrl)) ===
                        (project.url ?? null)
                    }
                  >
                    Save
                  </PrimaryButton>
                </div>
                {savedKey === 'link' && (
                  <span className="text-[11px] text-emerald-400">Saved</span>
                )}
              </div>
            </Section>

            <Section
              title="Workspace"
              description="The workspace this project belongs to. Moving it hands ownership over — every member of the destination workspace will see and be able to edit it."
            >
              <ProjectWorkspaceControl project={project} />
            </Section>

            <Section
              title="Project Info"
              description="Read-only metadata. Useful for debugging or referencing this project elsewhere."
            >
              <dl className="space-y-3 text-[13px]">
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Project ID</dt>
                  <dd className="flex-1 flex items-center gap-2 min-w-0">
                    <code className="font-mono text-[12px] text-neutral-300 truncate">
                      {project.id}
                    </code>
                    <button
                      type="button"
                      onClick={() => handleCopy('id', project.id)}
                      title="Copy ID"
                      className="size-7 flex items-center justify-center rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors shrink-0"
                    >
                      <Copy size={14} />
                    </button>
                    {copyKey === 'id' && (
                      <span className="text-[11px] text-emerald-400">Copied</span>
                    )}
                  </dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Created</dt>
                  <dd className="text-neutral-300">{createdLabel}</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Environments</dt>
                  <dd className="text-neutral-300">{environments?.length ?? 0}</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Active agents</dt>
                  <dd className="text-neutral-300">{projectAgentCount}</dd>
                </div>
              </dl>
            </Section>

            <div className="py-8">
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-4">
                <h3 className="text-[14px] font-semibold text-red-300 mb-1">
                  Delete Project
                </h3>
                <p className="text-[13px] text-red-400/80 mb-4">
                  Permanently removes this project, all its environments, tasks, and
                  agent records from the local database. Running tmux sessions on the
                  remote servers are <span className="font-medium">not</span> killed —
                  you'll need to clean them up manually if needed.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (runningAgentCount > 0) setShowRunningBlock(true)
                    else setShowDeleteConfirm(true)
                  }}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-red-600/90 hover:bg-red-600 text-white transition-colors"
                >
                  <TrashCan size={14} />
                  Delete Project
                </button>
                {runningAgentCount > 0 && (
                  <p className="mt-2 text-[12px] text-red-400/70">
                    {runningAgentCount} running agent{runningAgentCount === 1 ? '' : 's'} —
                    stop {runningAgentCount === 1 ? 'it' : 'them'} before deleting.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showRunningBlock && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
          onClick={() => setShowRunningBlock(false)}
        >
          <div
            className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[420px] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold text-neutral-50 mb-2">
              Stop running agents first
            </div>
            <p className="text-[13px] text-neutral-400 mb-4">
              "{project.name}" has{' '}
              <span className="text-neutral-200 font-medium">
                {runningAgentCount} running agent{runningAgentCount === 1 ? '' : 's'}
              </span>
              . Close {runningAgentCount === 1 ? 'it' : 'them all'} from the terminal
              tabs (or kill the tmux session{runningAgentCount === 1 ? '' : 's'}) before
              deleting the project.
            </p>
            <div className="flex justify-end">
              <button
                onClick={() => setShowRunningBlock(false)}
                className="h-8 px-4 rounded-lg text-[13px] text-neutral-50 bg-neutral-700 hover:bg-neutral-600 transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
          onClick={() => !deleting && setShowDeleteConfirm(false)}
        >
          <div
            className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[420px] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[15px] font-semibold text-neutral-50 mb-2">
              Delete "{project.name}"?
            </div>
            <p className="text-[13px] text-neutral-400 mb-4">
              This cannot be undone. All environments, tasks, and agent records for
              this project will be removed from the database.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
                className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="h-8 px-4 rounded-lg text-[13px] text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-colors"
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ================= Workspace transfer ================= */

function ProjectWorkspaceControl({ project }: { project: Project }) {
  const user = useAuthStore((s) => s.user)
  const teams = useAuthStore((s) => s.teams)
  const [target, setTarget] = useState<{ type: 'user' | 'team'; id: string } | null>(null)

  const currentLabel = (() => {
    if (project.owner_type === 'team') {
      const team = teams.find((t) => t.id === project.owner_id)
      return team?.name ?? 'Team'
    }
    return 'Personal'
  })()

  const options = useMemo(() => {
    const opts: { key: string; label: string; owner: { type: 'user' | 'team'; id: string } }[] = []
    if (user) {
      opts.push({ key: `user:${user.id}`, label: 'Personal', owner: { type: 'user', id: String(user.id) } })
    }
    for (const t of teams) {
      if (t.role === 'viewer') continue // viewers can't own projects
      opts.push({ key: `team:${t.id}`, label: t.name, owner: { type: 'team', id: t.id } })
    }
    return opts
  }, [user, teams])

  const currentKey = `${project.owner_type ?? 'user'}:${project.owner_id ?? ''}`

  const handlePick = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    const v = e.target.value
    if (v === currentKey) return
    const [type, id] = v.split(':')
    if (type !== 'user' && type !== 'team') return
    setTarget({ type, id })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-[13px] text-neutral-300">
          Currently in <span className="font-medium text-neutral-100">{currentLabel}</span>
        </div>
      </div>
      <select
        value={currentKey}
        onChange={handlePick}
        className="h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500"
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>{o.label}</option>
        ))}
      </select>
      <p className="text-[11px] text-neutral-500">
        To move, pick a different workspace. You'll be asked to confirm by typing the project name.
      </p>
      {target && (
        <TransferConfirmDialog
          project={project}
          target={target}
          targetLabel={options.find((o) => `${o.owner.type}:${o.owner.id}` === `${target.type}:${target.id}`)?.label || ''}
          onClose={() => setTarget(null)}
        />
      )}
    </div>
  )
}

function TransferConfirmDialog({
  project,
  target,
  targetLabel,
  onClose,
}: {
  project: Project
  target: { type: 'user' | 'team'; id: string }
  targetLabel: string
  onClose: () => void
}) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const qc = useQueryClient()

  // Block paste so the user has to actually type the name.
  const blockPaste = (e: React.ClipboardEvent<HTMLInputElement>): void => {
    e.preventDefault()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const handleConfirm = async (): Promise<void> => {
    if (typed !== project.name) return
    setBusy(true)
    setError(null)
    try {
      await window.electronAPI.projects.transfer(project.id, target.type, target.id)
      await qc.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    } catch (e) {
      setError((e as Error).message || 'Transfer failed')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60" onClick={busy ? undefined : onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-[460px] max-w-[92vw] p-5"
      >
        <div className="text-[15px] font-semibold text-neutral-50 mb-1">Move project to {targetLabel}?</div>
        <p className="text-[12px] text-neutral-400 mb-4">
          This transfers ownership to <span className="text-neutral-200">{targetLabel}</span>. Every member of that workspace
          will be able to see and edit <span className="text-neutral-200">{project.name}</span>.
          Type the project name exactly to confirm. Paste is disabled.
        </p>
        <input
          type="text"
          autoFocus
          value={typed}
          onPaste={blockPaste}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={project.name}
          disabled={busy}
          className="w-full h-10 rounded-md border border-neutral-700 bg-neutral-950 px-3 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500 disabled:opacity-50"
        />
        {error && (
          <div className="mt-2 text-[12px] text-red-400">{error}</div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy || typed !== project.name}
            className="h-8 px-4 rounded-lg text-[13px] text-white bg-blue-600 hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            {busy ? 'Moving…' : 'Move project'}
          </button>
        </div>
      </div>
    </div>
  )
}
