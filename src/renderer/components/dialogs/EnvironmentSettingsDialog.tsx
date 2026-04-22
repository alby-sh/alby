import { useState, useEffect } from 'react'
import { useUpdateEnvironment } from '../../hooks/useProjects'
import type {
  Environment,
  SSHHost,
  AgentSettings,
  AgentInstanceSettings,
  DeployConfig,
} from '../../../shared/types'
import { DEFAULT_AGENT_SETTINGS, DEFAULT_DEPLOY_CONFIG } from '../../../shared/types'

interface Props {
  environment: Environment
  onClose: () => void
}

const AGENT_LABELS: Record<string, { name: string; description: string }> = {
  claude: { name: 'Claude', description: 'Anthropic Claude Code' },
  gemini: { name: 'Gemini', description: 'Google Gemini CLI' },
  codex: { name: 'Codex', description: 'OpenAI Codex CLI' },
}

function AgentToggle({
  agentKey,
  settings,
  onChange,
}: {
  agentKey: string
  settings: AgentInstanceSettings
  onChange: (s: AgentInstanceSettings) => void
}) {
  const label = AGENT_LABELS[agentKey] || { name: agentKey, description: '' }

  return (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-[var(--bg-tertiary)] transition-colors"
        onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
      >
        <div
          className={`w-8 h-[18px] rounded-full transition-colors relative cursor-pointer shrink-0 ${
            settings.enabled ? 'bg-[var(--accent)]' : 'bg-neutral-700'
          }`}
        >
          <div
            className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ${
              settings.enabled ? 'left-[16px]' : 'left-[2px]'
            }`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--text-primary)]">{label.name}</div>
          <div className="text-[11px] text-[var(--text-secondary)]">{label.description}</div>
        </div>
      </div>

      {settings.enabled && (
        <div className="border-t border-[var(--border-color)] px-3 py-2 flex flex-col gap-2 bg-[var(--bg-tertiary)]/30">
          <label className="flex items-center gap-2 cursor-pointer text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            <input
              type="checkbox"
              checked={settings.skip_permissions}
              onChange={(e) => onChange({ ...settings, skip_permissions: e.target.checked })}
              className="accent-[var(--accent)]"
            />
            Auto-execute without confirmation
          </label>
          <label className="flex items-center gap-2 cursor-pointer text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors">
            <input
              type="checkbox"
              checked={settings.use_chrome}
              onChange={(e) => onChange({ ...settings, use_chrome: e.target.checked })}
              className="accent-[var(--accent)]"
            />
            Enable MCP Chrome
          </label>
        </div>
      )}
    </div>
  )
}

function CommandList({
  items,
  onChange,
  placeholder,
}: {
  items: string[]
  onChange: (next: string[]) => void
  placeholder: string
}) {
  return (
    <div className="space-y-2">
      {items.map((cmd, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <span className="w-6 text-[11px] text-neutral-500 text-right shrink-0">{idx + 1}.</span>
          <input
            type="text"
            value={cmd}
            onChange={(e) => {
              const next = [...items]
              next[idx] = e.target.value
              onChange(next)
            }}
            placeholder={placeholder}
            className="flex-1 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)]"
          />
          <button
            type="button"
            onClick={() => onChange(items.filter((_, i) => i !== idx))}
            className="size-9 flex items-center justify-center rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800 transition-colors shrink-0"
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...items, ''])}
        className="text-[12px] text-neutral-400 hover:text-neutral-200 transition-colors"
      >
        + Add command
      </button>
    </div>
  )
}

export function EnvironmentSettingsDialog({ environment, onClose }: Props) {
  const isDeploy = environment.role === 'deploy'
  const [name, setName] = useState(environment.name)
  const [label, setLabel] = useState(environment.label || '')
  const [sshHost, setSshHost] = useState(environment.ssh_host)
  const [sshUser, setSshUser] = useState(environment.ssh_user || '')
  const [remotePath, setRemotePath] = useState(environment.remote_path)
  const [hosts, setHosts] = useState<SSHHost[]>([])
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(
    environment.agent_settings || DEFAULT_AGENT_SETTINGS
  )
  const [deployConfig, setDeployConfig] = useState<DeployConfig>(
    environment.deploy_config || DEFAULT_DEPLOY_CONFIG
  )
  const updateEnvironment = useUpdateEnvironment()

  useEffect(() => {
    window.electronAPI.ssh.listHosts().then(setHosts)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !sshHost.trim() || !remotePath.trim()) return
    updateEnvironment.mutate(
      {
        id: environment.id,
        data: {
          name: name.trim(),
          label: label.trim() || undefined,
          ssh_host: sshHost.trim(),
          ssh_user: sshUser.trim() || undefined,
          remote_path: remotePath.trim(),
          ...(isDeploy
            ? {
                deploy_config: {
                  branch: deployConfig.branch.trim() || 'main',
                  pre_commands: deployConfig.pre_commands.map((c) => c.trim()).filter(Boolean),
                  post_commands: deployConfig.post_commands.map((c) => c.trim()).filter(Boolean),
                },
              }
            : { agent_settings: agentSettings }),
        },
      },
      { onSuccess: () => onClose() }
    )
  }

  const updateAgent = (key: keyof AgentSettings, settings: AgentInstanceSettings) => {
    setAgentSettings((prev) => ({ ...prev, [key]: settings }))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-[560px] shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-lg font-medium">Environment Settings</h2>
          <span
            className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${
              isDeploy ? 'bg-red-500/15 text-red-300' : 'bg-blue-500/15 text-blue-300'
            }`}
          >
            {isDeploy ? `Deploy · ${environment.platform ?? 'linux'}` : 'Operational'}
          </span>
        </div>
        <form onSubmit={handleSubmit}>
          {/* Connection */}
          <div className="mb-5">
            <div className="text-[11px] text-[var(--text-secondary)] uppercase tracking-wider mb-3">
              Connection
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
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
                  placeholder="e.g. example.com"
                  className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>

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

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1">User (optional)</label>
                <input
                  type="text"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  placeholder="root"
                  className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--text-secondary)] mb-1">Remote Path</label>
                <input
                  type="text"
                  value={remotePath}
                  onChange={(e) => setRemotePath(e.target.value)}
                  placeholder={environment.platform === 'windows' ? 'C:\\inetpub\\wwwroot\\app' : '/var/www/project'}
                  className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)]"
                />
              </div>
            </div>
          </div>

          {/* Agents — operational envs only */}
          {!isDeploy && (
            <div className="mb-5">
              <div className="text-[11px] text-[var(--text-secondary)] uppercase tracking-wider mb-3">
                Agents
              </div>
              <div className="flex flex-col gap-2">
                {(Object.keys(AGENT_LABELS) as (keyof AgentSettings)[]).map((key) => (
                  <AgentToggle
                    key={key}
                    agentKey={key}
                    settings={agentSettings[key]}
                    onChange={(s) => updateAgent(key, s)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Deploy pipeline — deploy envs only */}
          {isDeploy && (
            <div className="mb-5">
              <div className="text-[11px] text-[var(--text-secondary)] uppercase tracking-wider mb-3">
                Deploy pipeline
              </div>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-1">Branch</label>
                  <input
                    type="text"
                    value={deployConfig.branch}
                    onChange={(e) => setDeployConfig({ ...deployConfig, branch: e.target.value })}
                    placeholder="main"
                    className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-2">
                    Pre-commands (before git pull)
                  </label>
                  <CommandList
                    items={deployConfig.pre_commands}
                    onChange={(next) => setDeployConfig({ ...deployConfig, pre_commands: next })}
                    placeholder="e.g. git stash"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[var(--text-secondary)] mb-2">
                    Post-commands (after git pull)
                  </label>
                  <CommandList
                    items={deployConfig.post_commands}
                    onChange={(next) => setDeployConfig({ ...deployConfig, post_commands: next })}
                    placeholder={environment.platform === 'windows' ? 'e.g. iisreset' : 'e.g. php artisan migrate --force'}
                  />
                </div>
              </div>
            </div>
          )}

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
              disabled={
                !name.trim() || !sshHost.trim() || !remotePath.trim() || updateEnvironment.isPending
              }
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded text-sm font-medium"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
