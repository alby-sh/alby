import { useState } from 'react'
import { useCreateTeamRole, useUpdateTeamRole } from '../../hooks/useTeams'
import type { TeamRole, WorkspaceCapability } from '../../stores/auth-store'

interface Props {
  teamId: string
  /** When null, the dialog creates a new role. When a TeamRole is passed,
   *  the dialog edits it (builtins are view-only — the slug + capabilities
   *  inputs render disabled). */
  existing: TeamRole | null
  onClose: () => void
}

/** Grouped capability catalogue — drives the checkbox layout. Groups are
 *  display-only; the server stores a flat string[] on team_roles.capabilities.
 *  Order inside a group is "most powerful → least powerful" so the most
 *  common toggle (the first one) is the one the admin is most likely to
 *  scan past. */
const CAPABILITY_GROUPS: Array<{
  label: string
  description: string
  caps: Array<{ key: WorkspaceCapability; label: string; hint: string }>
}> = [
  {
    label: 'Workspace',
    description: 'Team membership, billing, custom roles.',
    caps: [
      { key: 'manage_workspace', label: 'Manage workspace', hint: 'Invite / remove members, change team name + billing.' },
      { key: 'manage_roles',     label: 'Manage roles',     hint: 'Create, edit, delete custom team roles.' },
    ],
  },
  {
    label: 'Projects',
    description: 'Core CRUD on projects / envs / stacks / tasks.',
    caps: [
      { key: 'edit_projects',   label: 'Edit projects',   hint: 'Create and edit projects, stacks, environments, tasks.' },
      { key: 'see_reports',     label: 'See reports',     hint: 'Open activity reports and analytics.' },
    ],
  },
  {
    label: 'Agents & terminals',
    description: 'Interactive work inside environments.',
    caps: [
      { key: 'launch_agents',   label: 'Launch agents',   hint: 'Spawn Claude/Gemini/Codex/terminal sessions, type into them.' },
      { key: 'manage_routines', label: 'Manage routines', hint: 'Create, edit, start, stop scheduled agent routines.' },
      { key: 'run_deploy',      label: 'Run deploys',     hint: 'Press "Deploy now" on deploy-role environments.' },
    ],
  },
  {
    label: 'Issues',
    description: 'Error monitoring and manual issue reports.',
    caps: [
      { key: 'view_issues',     label: 'View issues',     hint: 'Open the Issues tab and read issue details.' },
      { key: 'report_issue',    label: 'Report issue',    hint: 'File manual issue reports via the Report form.' },
      { key: 'resolve_issues',  label: 'Resolve issues',  hint: 'Change issue status, delete resolved issues.' },
    ],
  },
]

/** Slug input normaliser. Team roles can be matched against membership
 *  rows by slug — keep it ASCII / lowercase / no spaces so the DB key
 *  doesn't carry display quirks. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function RoleEditorDialog({ teamId, existing, onClose }: Props) {
  const isEdit = !!existing
  const isBuiltin = !!existing?.is_builtin

  const [name, setName] = useState(existing?.name ?? '')
  const [slug, setSlug] = useState(existing?.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState(existing?.description ?? '')
  const [caps, setCaps] = useState<Set<WorkspaceCapability>>(
    new Set(existing?.capabilities ?? [])
  )

  const createMut = useCreateTeamRole(teamId)
  const updateMut = useUpdateTeamRole(teamId)
  const submitting = createMut.isPending || updateMut.isPending
  const mutErr = createMut.error ?? updateMut.error
  const errMsg = mutErr instanceof Error ? mutErr.message : null

  const toggle = (cap: WorkspaceCapability) => {
    setCaps((prev) => {
      const next = new Set(prev)
      if (next.has(cap)) next.delete(cap); else next.add(cap)
      return next
    })
  }

  const handleNameChange = (v: string) => {
    setName(v)
    // Auto-derive slug while the user hasn't typed in the slug field
    // directly. Once they touch it we respect their input.
    if (!slugTouched && !isEdit) setSlug(slugify(v))
  }

  const canSubmit = name.trim().length > 0 && slug.trim().length > 0 && !submitting

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!canSubmit) return
    const capabilities = Array.from(caps)
    if (isEdit && existing) {
      // Builtins → only the name/description are editable (server rejects
      // capability changes with 422). Non-builtins get the full shape.
      const payload = isBuiltin
        ? { name: name.trim(), description: description.trim() || null }
        : { name: name.trim(), description: description.trim() || null, capabilities }
      updateMut.mutate({ roleId: existing.id, data: payload }, { onSuccess: () => onClose() })
    } else {
      createMut.mutate(
        { slug: slug.trim(), name: name.trim(), description: description.trim() || null, capabilities },
        { onSuccess: () => onClose() },
      )
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-[620px] max-w-[94vw] max-h-[86vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-lg font-medium">
            {isEdit ? (isBuiltin ? `Built-in: ${existing?.name}` : `Edit role · ${existing?.name}`) : 'New role'}
          </h2>
          {isBuiltin && (
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 border border-neutral-700 rounded px-1.5 py-0.5">
              built-in
            </span>
          )}
        </div>
        <p className="text-[12px] text-neutral-500 mb-5">
          {isBuiltin
            ? 'Built-in roles can be renamed but their capabilities are managed by Alby and cannot be edited.'
            : 'Pick the capabilities this role grants. Members get the union of every capability their role holds — nothing more, nothing less.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-neutral-400 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. Frontend Lead"
                autoFocus={!isEdit}
                maxLength={60}
                className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-400 mb-1">Slug</label>
              <input
                type="text"
                value={slug}
                onChange={(e) => { setSlug(slugify(e.target.value)); setSlugTouched(true) }}
                disabled={isEdit}
                placeholder="frontend-lead"
                maxLength={40}
                className={`w-full border rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)] ${
                  isEdit
                    ? 'bg-neutral-900 text-neutral-500 border-neutral-800 cursor-not-allowed'
                    : 'bg-[var(--bg-tertiary)] border-[var(--border-color)]'
                }`}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">
              Description <span className="text-neutral-600">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Who is this role for? What can they typically do?"
              maxLength={200}
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs text-neutral-400">Capabilities</label>
              <span className="text-[11px] text-neutral-600">
                {caps.size} selected
              </span>
            </div>
            <div className="space-y-3">
              {CAPABILITY_GROUPS.map((group) => (
                <div key={group.label} className="rounded border border-neutral-800 p-3">
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="text-[12px] font-medium text-neutral-200">{group.label}</div>
                    <div className="text-[10.5px] text-neutral-600">{group.description}</div>
                  </div>
                  <ul className="space-y-1">
                    {group.caps.map((c) => {
                      const active = caps.has(c.key)
                      return (
                        <li key={c.key}>
                          <label
                            className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                              isBuiltin
                                ? 'cursor-not-allowed opacity-70'
                                : 'hover:bg-neutral-900'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={active}
                              disabled={isBuiltin}
                              onChange={() => toggle(c.key)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-[12.5px] text-neutral-100">{c.label}</div>
                              <div className="text-[11px] text-neutral-500">{c.hint}</div>
                            </div>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {errMsg && (
            <div className="text-xs text-red-300 bg-red-900/30 border border-red-700/40 rounded px-3 py-2">
              {errMsg.includes('404') || errMsg.toLowerCase().includes('not found')
                ? 'Your Alby server doesn\'t have custom-role support yet. Ask an admin to deploy the v0.8.1 backend patch.'
                : errMsg}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded text-sm font-medium"
            >
              {submitting ? 'Saving…' : isEdit ? 'Save role' : 'Create role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
