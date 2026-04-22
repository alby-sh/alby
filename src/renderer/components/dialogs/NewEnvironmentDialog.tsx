import { useState, useEffect } from 'react'
import { useCreateEnvironment } from '../../hooks/useProjects'
import type { ExecutionMode, SSHHost } from '../../../shared/types'

interface Props {
  projectId: string
  onClose: () => void
}

export function NewEnvironmentDialog({ projectId, onClose }: Props) {
  const [mode, setMode] = useState<ExecutionMode>('remote')
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshUser, setSshUser] = useState('')
  const [path, setPath] = useState('')
  const [hosts, setHosts] = useState<SSHHost[]>([])
  const [pathError, setPathError] = useState<string | null>(null)
  const createEnvironment = useCreateEnvironment()

  useEffect(() => {
    window.electronAPI.ssh.listHosts().then(setHosts)
  }, [])

  const isValid = mode === 'remote'
    ? !!(name.trim() && sshHost.trim() && path.trim())
    : !!(name.trim() && path.trim())

  const handleBrowse = async () => {
    const picked = await window.electronAPI.dialog.pickFolder('Pick the project folder')
    if (picked) {
      setPath(picked)
      setPathError(null)
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return
    if (mode === 'local' && !path.startsWith('/')) {
      setPathError('Use an absolute path (starts with /)')
      return
    }
    createEnvironment.mutate(
      mode === 'remote'
        ? {
            project_id: projectId,
            name: name.trim(),
            label: label.trim() || undefined,
            execution_mode: 'remote',
            ssh_host: sshHost.trim(),
            ssh_user: sshUser.trim() || undefined,
            remote_path: path.trim()
          }
        : {
            project_id: projectId,
            name: name.trim(),
            label: label.trim() || undefined,
            execution_mode: 'local',
            remote_path: path.trim()
          },
      { onSuccess: () => onClose() }
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-[500px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-4">New Environment</h2>
        <form onSubmit={handleSubmit}>
          {/* Mode tabs */}
          <div className="flex gap-1 mb-5 p-1 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-color)]">
            <button
              type="button"
              onClick={() => setMode('remote')}
              className={`flex-1 h-8 text-[13px] rounded-md transition-colors ${
                mode === 'remote'
                  ? 'bg-neutral-700 text-neutral-50'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Remote (SSH)
            </button>
            <button
              type="button"
              onClick={() => setMode('local')}
              className={`flex-1 h-8 text-[13px] rounded-md transition-colors ${
                mode === 'local'
                  ? 'bg-neutral-700 text-neutral-50'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Local folder
            </button>
          </div>

          <p className="text-[12px] text-neutral-500 mb-4">
            {mode === 'remote'
              ? 'Agents run on a remote server via SSH inside a tmux session. Synced across devices when online sync is enabled.'
              : 'Agents run directly on this Mac in a local folder. Stays only on this device — never synced.'}
          </p>

          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-sm text-[var(--text-secondary)] mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={mode === 'remote' ? 'e.g. dev, staging, prod' : 'e.g. local'}
                autoFocus
                className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
            <div>
              <label className="block text-sm text-[var(--text-secondary)] mb-1">
                Website (optional)
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. truespeak.eu"
                className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              />
            </div>
          </div>

          {mode === 'remote' && (
            <>
              <div className="mb-4">
                <label className="block text-sm text-[var(--text-secondary)] mb-1">SSH Host</label>
                <div className="flex gap-2">
                  <select
                    value={sshHost}
                    onChange={(e) => {
                      setSshHost(e.target.value)
                      const host = hosts.find((h) => h.alias === e.target.value)
                      if (host) setSshUser(host.user)
                    }}
                    className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                  >
                    <option value="">Select or type host...</option>
                    {hosts.map((h) => (
                      <option key={h.alias} value={h.alias}>
                        {h.alias} ({h.hostname})
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    placeholder="or enter manually"
                    className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1">
                    SSH User (optional)
                  </label>
                  <input
                    type="text"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    placeholder="root"
                    className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1">
                    Remote Path
                  </label>
                  <input
                    type="text"
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/var/www/project"
                    className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
              </div>
            </>
          )}

          {mode === 'local' && (
            <div className="mb-4">
              <label className="block text-sm text-[var(--text-secondary)] mb-1">
                Local folder
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={path}
                  onChange={(e) => { setPath(e.target.value); setPathError(null) }}
                  placeholder="/Users/you/code/my-project"
                  className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] font-mono"
                />
                <button
                  type="button"
                  onClick={handleBrowse}
                  className="px-3 h-9 rounded text-[13px] border border-[var(--border-color)] bg-[var(--bg-tertiary)] hover:bg-neutral-800 text-neutral-200"
                >
                  Browse…
                </button>
              </div>
              {pathError && (
                <p className="mt-1 text-[12px] text-red-400">{pathError}</p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isValid || createEnvironment.isPending}
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
