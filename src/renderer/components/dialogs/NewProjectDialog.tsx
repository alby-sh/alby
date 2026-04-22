import { useState } from 'react'
import { useCreateProject } from '../../hooks/useProjects'
import { useAuthStore } from '../../stores/auth-store'

interface Props {
  onClose: () => void
}

export function NewProjectDialog({ onClose }: Props) {
  const [name, setName] = useState('')
  const createProject = useCreateProject()
  const workspace = useAuthStore((s) => s.workspace)
  const teams = useAuthStore((s) => s.teams)

  // Default owner: if the user is currently filtering by a team, the new
  // project belongs to that team; 'personal' or 'all' both mean the user's
  // own workspace.
  const owner = (() => {
    if (workspace === 'all' || workspace === 'personal') return undefined
    const team = teams.find((t) => t.id === workspace)
    if (!team) return undefined
    return { owner_type: 'team' as const, owner_id: team.id }
  })()

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!name.trim()) return
    createProject.mutate(
      { name: name.trim(), ...(owner ?? {}) },
      { onSuccess: () => onClose() }
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-96 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-4">New Project</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm text-[var(--text-secondary)] mb-1">
              Project Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. truespeak.eu"
              autoFocus
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
            />
          </div>
          <p className="mb-6 text-[12px] text-neutral-500">
            You'll choose Remote (SSH) or Local for each environment when you add one.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!name.trim() || createProject.isPending}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded text-sm font-medium"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
