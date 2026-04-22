import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Close, TrashCan, Add, Renew, CheckmarkFilled, WarningAltFilled } from '@carbon/icons-react'
import { useAppStore } from '../../stores/app-store'
import {
  useDeleteEnvironment,
  useEnvironment,
  useEnvironments,
  useProjects,
  useUpdateEnvironment,
} from '../../hooks/useProjects'
import { useStack, useUpdateStack } from '../../hooks/useStacks'
import type {
  AutoFixAgentType,
  Environment,
  EnvironmentPlatform,
  EnvironmentRole,
  SSHHost,
  SSHPreflightResult,
  UpdateEnvironmentDTO,
} from '../../../shared/types'

interface Props {
  environmentId: string
}

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; result: SSHPreflightResult }
  | { status: 'error'; result: SSHPreflightResult }

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-4 py-6 md:grid-cols-10 border-b border-neutral-800 last:border-b-0">
      <div className="w-full space-y-1.5 md:col-span-4">
        <h3 className="text-[15px] font-semibold leading-none text-neutral-50">{title}</h3>
        {description && <p className="text-[13px] text-neutral-400 text-balance">{description}</p>}
      </div>
      <div className="md:col-span-6">{children}</div>
    </div>
  )
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
  mono = false,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  mono?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors ${
        mono ? 'font-mono' : ''
      }`}
    />
  )
}

function SyncToggle({
  id,
  checked,
  onChange,
  disabled,
  label,
  description,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  label: string
  description: string
}) {
  return (
    <div className={`mt-3 rounded-md border border-neutral-800 bg-neutral-900/50 p-3 ${disabled ? 'opacity-50' : ''}`}>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 cursor-pointer accent-emerald-500"
        />
        <div className="space-y-1">
          <div className="text-[12px] font-medium text-neutral-200">{label}</div>
          <p className="text-[11px] leading-relaxed text-neutral-500">{description}</p>
        </div>
      </label>
    </div>
  )
}

function RoleCard({
  active,
  onClick,
  title,
  description,
  icon,
  danger,
  disabled,
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  icon: React.ReactNode
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 text-left rounded-xl border p-4 transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
        active
          ? danger
            ? 'border-red-500/70 bg-red-500/5'
            : 'border-blue-500/70 bg-blue-500/5'
          : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-600'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
            active ? (danger ? 'bg-red-500/15 text-red-300' : 'bg-blue-500/15 text-blue-300') : 'bg-neutral-800 text-neutral-400'
          }`}
        >
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-neutral-100">{title}</div>
          <p className="mt-1 text-[12px] text-neutral-400">{description}</p>
        </div>
      </div>
    </button>
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
  const update = (idx: number, value: string): void => {
    const next = [...items]
    next[idx] = value
    onChange(next)
  }
  const remove = (idx: number): void => onChange(items.filter((_, i) => i !== idx))
  const add = (): void => onChange([...items, ''])
  return (
    <div className="space-y-2">
      {items.map((cmd, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <span className="w-6 text-[11px] text-neutral-500 text-right shrink-0">{idx + 1}.</span>
          <TextInput value={cmd} onChange={(v) => update(idx, v)} placeholder={placeholder} mono />
          <button
            type="button"
            onClick={() => remove(idx)}
            className="size-9 flex items-center justify-center rounded-md text-neutral-500 hover:text-red-400 hover:bg-neutral-800 transition-colors shrink-0"
            title="Remove"
          >
            <TrashCan size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[12px] text-neutral-300 border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 transition-colors"
      >
        <Add size={12} />
        Add command
      </button>
    </div>
  )
}

function TestResultPanel({ test, onRetry }: { test: TestState; onRetry: () => void }) {
  if (test.status === 'idle') {
    return (
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-[13px] text-neutral-400">
        Run a connection test to verify the changes you've made still work.
      </div>
    )
  }
  if (test.status === 'running') {
    return (
      <div className="rounded-lg border border-blue-500/40 bg-blue-500/5 p-4 text-[13px] text-blue-200 flex items-center gap-3">
        <Renew size={16} className="animate-spin" />
        <div>Running preflight: DNS → TCP → SSH handshake → auth → shell → path → git…</div>
      </div>
    )
  }
  const { status, result } = test
  const ok = status === 'ok'
  return (
    <div
      className={`rounded-lg border p-4 text-[13px] ${
        ok
          ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-200'
          : 'border-red-500/50 bg-red-500/5 text-red-200'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`size-5 rounded-full flex items-center justify-center shrink-0 ${ok ? 'text-emerald-300' : 'text-red-300'}`}>
          {ok ? <CheckmarkFilled size={18} /> : <WarningAltFilled size={18} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-neutral-50">
            {ok ? 'Connection verified' : `Failed at stage: ${result.stage ?? 'unknown'}`}
          </div>
          <p className="mt-1 text-neutral-300 whitespace-pre-wrap">
            {result.message || (ok ? 'All checks passed.' : 'Unknown error.')}
          </p>
          {result.hint && !ok && (
            <div className="mt-3 rounded-md bg-black/30 border border-red-500/20 p-3 text-[12px] text-red-100/90 leading-relaxed">
              <div className="font-medium text-red-200 mb-1">How to fix</div>
              <div className="whitespace-pre-wrap">{result.hint}</div>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 h-8 px-3 rounded-md text-[12px] border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 transition-colors"
        >
          Re-test
        </button>
      </div>
    </div>
  )
}

export function EditEnvironmentView({ environmentId }: Props) {
  const { data: environment } = useEnvironment(environmentId)
  const { data: projects } = useProjects()
  const updateEnvironment = useUpdateEnvironment()
  const deleteEnvironment = useDeleteEnvironment()
  const closeEditEnvironment = useAppStore((s) => s.closeEditEnvironment)

  const project = useMemo(
    () => projects?.find((p) => p.id === environment?.project_id),
    [projects, environment]
  )

  // --- Form state (initialised from environment when it loads) ---
  const [executionMode, setExecutionMode] = useState<'remote' | 'local'>('remote')
  const [platform, setPlatform] = useState<EnvironmentPlatform>('linux')
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshUser, setSshUser] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshKeyPath, setSshKeyPath] = useState('')
  const [sshAuthMethod, setSshAuthMethod] = useState<'key' | 'password'>('key')
  const [sshPassword, setSshPassword] = useState('')
  // "Sync to cloud" toggles. Seeded from the has_synced_* flags the backend
  // sends back on the Environment record; if true, the user already uploaded
  // an encrypted copy from this or another device and can rely on it for
  // cross-device access.
  const [passwordSyncEnabled, setPasswordSyncEnabled] = useState(false)
  const [keySyncEnabled, setKeySyncEnabled] = useState(false)
  const [remotePath, setRemotePath] = useState('')
  const [branch, setBranch] = useState('main')
  const [preCommands, setPreCommands] = useState<string[]>([])
  const [postCommands, setPostCommands] = useState<string[]>([])
  const [hosts, setHosts] = useState<SSHHost[]>([])
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const role: EnvironmentRole = environment?.role ?? 'operational'

  useEffect(() => {
    if (!environment) return
    setExecutionMode(environment.execution_mode === 'local' ? 'local' : 'remote')
    setPlatform(environment.platform === 'windows' ? 'windows' : 'linux')
    setName(environment.name ?? '')
    setLabel(environment.label ?? '')
    setSshHost(environment.ssh_host ?? '')
    setSshUser(environment.ssh_user ?? '')
    setSshPort(String(environment.ssh_port ?? 22))
    setSshKeyPath(environment.ssh_key_path ?? '')
    setSshAuthMethod((environment.ssh_auth_method as 'key' | 'password') ?? 'key')
    setSshPassword(environment.ssh_password ?? '')
    setPasswordSyncEnabled(!!environment.has_synced_password)
    setKeySyncEnabled(!!environment.has_synced_private_key)
    setRemotePath(environment.remote_path ?? '')
    if (environment.deploy_config) {
      setBranch(environment.deploy_config.branch ?? 'main')
      setPreCommands(environment.deploy_config.pre_commands ?? [])
      setPostCommands(environment.deploy_config.post_commands ?? [])
    }
  }, [environment])

  useEffect(() => {
    window.electronAPI.ssh.listHosts().then(setHosts).catch(() => { /* ignore */ })
  }, [])

  // Stale preflight badge would lie about new connection params.
  useEffect(() => {
    setTest({ status: 'idle' })
  }, [sshHost, sshUser, sshPort, sshKeyPath, sshAuthMethod, sshPassword, remotePath, platform, executionMode])

  const trimmedHost = sshHost.trim()
  const trimmedPath = remotePath.trim()
  const portNum = Math.max(1, Math.min(65535, parseInt(sshPort, 10) || 22))
  const isLocal = executionMode === 'local'

  const canRunTest = !isLocal && !!(trimmedHost && trimmedPath)
  const canSave = !!name.trim() && (isLocal ? !!trimmedPath : true) && !updateEnvironment.isPending

  const runTest = async (): Promise<void> => {
    if (!canRunTest) return
    setTest({ status: 'running' })
    try {
      const result = (await window.electronAPI.ssh.testPreflight({
        role,
        platform,
        ssh_host: trimmedHost,
        ssh_user: sshUser.trim() || undefined,
        ssh_port: portNum,
        ssh_key_path: sshKeyPath.trim() || undefined,
        ssh_auth_method: sshAuthMethod,
        ssh_password: sshAuthMethod === 'password' ? sshPassword : undefined,
        remote_path: trimmedPath,
      })) as SSHPreflightResult
      setTest({ status: result.ok ? 'ok' : 'error', result })
    } catch (err) {
      setTest({
        status: 'error',
        result: { ok: false, code: 'IPC_ERROR', message: (err as Error).message },
      })
    }
  }

  const handlePickFolder = async (): Promise<void> => {
    const folder = await window.electronAPI.dialog.pickFolder('Select project folder')
    if (folder) setRemotePath(folder)
  }

  const handleSave = async (): Promise<void> => {
    if (!canSave) return
    setSubmitError(null)
    const dto: UpdateEnvironmentDTO = {
      name: name.trim(),
      label: label.trim() || undefined,
      execution_mode: executionMode,
      platform,
      ssh_host: isLocal ? '' : trimmedHost,
      ssh_user: isLocal ? undefined : (sshUser.trim() || undefined),
      ssh_port: isLocal ? 22 : portNum,
      ssh_key_path: isLocal ? undefined : (sshKeyPath.trim() || undefined),
      ssh_auth_method: isLocal ? undefined : sshAuthMethod,
      ssh_password: !isLocal && sshAuthMethod === 'password' ? sshPassword : null,
      remote_path: trimmedPath,
    }

    // Vault-sync toggles. Password: just flag it on the DTO, the server
    // encrypts with the current password it already has (or the new one we
    // just sent). Private key: the renderer can't access the filesystem so
    // we ask main to read the file at sshKeyPath, then pass the plaintext
    // once to the server. Subsequent edits don't need to re-upload unless
    // the user changes the path.
    if (!isLocal && sshAuthMethod === 'password') {
      dto.ssh_password_sync_enabled = passwordSyncEnabled
    } else if (!isLocal) {
      dto.ssh_password_sync_enabled = false
    }
    if (!isLocal && sshAuthMethod === 'key' && sshKeyPath.trim()) {
      dto.ssh_private_key_sync_enabled = keySyncEnabled
      // Only read + upload the key when enabling sync (don't waste a file
      // read on every save) or when the path changed while sync is already on.
      const shouldUpload = keySyncEnabled && (
        !environment?.has_synced_private_key || environment?.ssh_key_path !== sshKeyPath.trim()
      )
      if (shouldUpload) {
        const content = await window.electronAPI.environments.readPrivateKey(sshKeyPath.trim())
        if (!content) {
          setSubmitError(`Couldn't read the private key at ${sshKeyPath.trim()}. Check the path and file permissions.`)
          return
        }
        dto.ssh_private_key_content = content
      }
    } else if (!isLocal) {
      dto.ssh_private_key_sync_enabled = false
    }
    if (role === 'deploy') {
      dto.deploy_config = {
        branch: branch.trim() || 'main',
        pre_commands: preCommands.map((c) => c.trim()).filter(Boolean),
        post_commands: postCommands.map((c) => c.trim()).filter(Boolean),
      }
    }
    updateEnvironment.mutate(
      { id: environmentId, data: dto },
      {
        onSuccess: () => closeEditEnvironment(),
        onError: (err) => setSubmitError((err as Error).message),
      }
    )
  }

  const handleDelete = (): void => {
    deleteEnvironment.mutate(environmentId, {
      onSuccess: () => closeEditEnvironment(),
    })
  }

  if (!environment) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Loading environment…
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400 truncate">
          {project?.name ?? 'Project'} <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200 truncate">{environment.name}</span>{' '}
          <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">Settings</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeEditEnvironment}
          aria-label="Close"
          title="Close"
          className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <Close size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">Environment Settings</h2>
            <p className="text-[14px] text-neutral-400">
              Edit how <span className="text-neutral-200">{environment.name}</span> connects and behaves. Role (operational vs deploy) is fixed at creation.
            </p>
          </div>

          <div className="border-t border-neutral-800">
            {/* PURPOSE — read-only display */}
            <Section title="Purpose" description="Set when this environment was created and not editable.">
              <div className="inline-flex items-center gap-2 px-3 h-10 rounded-md border border-neutral-800 bg-neutral-900/60 text-[13px] text-neutral-200">
                <span className="size-2 rounded-full bg-blue-400" />
                {role === 'deploy' ? 'Deploy target' : 'Operational'}
              </div>
            </Section>

            {/* WHERE: local vs remote (operational only) */}
            {role === 'operational' && (
              <Section
                title="Where it runs"
                description="Local: agents and terminals run on this Mac, in a folder you pick. Remote: SSH into a Linux box and spawn there (best for shared servers and persistent tmux sessions across devices)."
              >
                <div className="flex gap-3">
                  <RoleCard
                    active={executionMode === 'local'}
                    onClick={() => setExecutionMode('local')}
                    title="Local"
                    description="Spawns shells in a folder on this Mac via node-pty. Sessions don't survive an app quit."
                    icon={
                      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7">
                        <path d="M3 5h18v11H3z M8 21h8 M12 16v5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    }
                  />
                  <RoleCard
                    active={executionMode === 'remote'}
                    onClick={() => setExecutionMode('remote')}
                    title="Remote (SSH)"
                    description="Connects to a server over SSH; tmux keeps every session alive across app restarts and devices."
                    icon={
                      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7">
                        <path d="M5 12a7 7 0 0 1 14 0M3 12h18M9 19c1.5 1 4.5 1 6 0" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    }
                  />
                </div>
              </Section>
            )}

            {/* PLATFORM (only for deploy) */}
            {role === 'deploy' && (
              <Section
                title="Platform"
                description="Linux uses bash; Windows uses PowerShell via OpenSSH Server. Pick what matches the remote host."
              >
                <div className="flex gap-3">
                  <RoleCard
                    active={platform === 'linux'}
                    onClick={() => setPlatform('linux')}
                    title="Linux"
                    description="bash login shell, ~/.bashrc sourced, standard Unix tooling."
                    icon={<span className="font-mono text-[16px]">$_</span>}
                  />
                  <RoleCard
                    active={platform === 'windows'}
                    onClick={() => setPlatform('windows')}
                    title="Windows"
                    description="PowerShell over OpenSSH. Enable sshd on the server with Add-WindowsCapability."
                    icon={<span className="font-mono text-[16px]">PS</span>}
                  />
                </div>
              </Section>
            )}

            {/* BASIC */}
            <Section title="Basics" description="How this environment appears in the sidebar.">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] text-neutral-400 mb-1.5">Name</label>
                  <TextInput value={name} onChange={setName} />
                </div>
                <div>
                  <label className="block text-[12px] text-neutral-400 mb-1.5">Website (optional)</label>
                  <TextInput value={label} onChange={setLabel} placeholder="example.com" />
                </div>
              </div>
            </Section>

            {/* LOCAL FOLDER */}
            {isLocal && (
              <Section
                title="Local folder"
                description="The folder on this Mac where agents will be spawned. Pick any directory you have read/write access to."
              >
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <TextInput value={remotePath} onChange={setRemotePath} placeholder="/Users/you/code/my-project" mono />
                    <button
                      type="button"
                      onClick={handlePickFolder}
                      className="h-10 px-3 rounded-md text-[12px] border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 transition-colors shrink-0"
                    >
                      Browse…
                    </button>
                  </div>
                  <p className="text-[11px] text-neutral-500">
                    Local environments don't sync across devices — sessions live on this Mac only and don't survive an app quit (unlike SSH+tmux).
                  </p>
                </div>
              </Section>
            )}

            {/* SSH CONNECTION */}
            {!isLocal && (
              <Section
                title="SSH connection"
                description="Alby connects over SSH. Pick a host from your ~/.ssh/config or type one manually. Your local SSH agent / private key is used for authentication."
              >
                <div className="space-y-4">
                  {platform === 'windows' && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[12px] text-amber-100/90 leading-relaxed space-y-1.5">
                      <div className="font-semibold text-amber-200">Setting up SSH on a Windows server</div>
                      <ol className="list-decimal pl-4 space-y-1">
                        <li>
                          On the Windows machine, open <span className="font-mono">PowerShell</span> as Administrator and install OpenSSH Server:
                          <pre className="mt-1 bg-black/30 rounded p-2 text-amber-50/90 overflow-x-auto"><code>{`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic`}</code></pre>
                        </li>
                        <li>
                          Open the Windows Firewall on TCP <span className="font-mono">22</span>:
                          <pre className="mt-1 bg-black/30 rounded p-2 text-amber-50/90 overflow-x-auto"><code>{'New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22'}</code></pre>
                        </li>
                        <li>
                          The user is the Windows account you log in with (e.g. <span className="font-mono">Administrator</span>, or your domain user — exactly the name you'd see in <span className="font-mono">whoami</span>).
                        </li>
                        <li>
                          For key auth: copy your <span className="font-mono">~/.ssh/id_rsa.pub</span> from this Mac into the server's <span className="font-mono">C:\Users\&lt;user&gt;\.ssh\authorized_keys</span>. For local admins use <span className="font-mono">C:\ProgramData\ssh\administrators_authorized_keys</span> instead (and make sure SYSTEM owns the file).
                        </li>
                        <li>
                          If your office router blocks port 22, ask your network admin to forward it to the server, or expose SSH over a tunnel (Cloudflare Tunnel, Tailscale, …).
                        </li>
                      </ol>
                    </div>
                  )}

                  <div>
                    <label className="block text-[12px] text-neutral-400 mb-1.5">SSH Host</label>
                    <div className="flex gap-2">
                      <select
                        value={hosts.some((h) => h.alias === sshHost) ? sshHost : ''}
                        onChange={(e) => {
                          const h = hosts.find((x) => x.alias === e.target.value)
                          if (h) {
                            setSshHost(h.alias)
                            setSshUser(h.user)
                            setSshPort(String(h.port))
                            if (h.identityFile) setSshKeyPath(h.identityFile)
                          }
                        }}
                        className="h-10 w-52 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500"
                      >
                        <option value="">From ~/.ssh/config…</option>
                        {hosts.map((h) => (
                          <option key={h.alias} value={h.alias}>
                            {h.alias} ({h.hostname})
                          </option>
                        ))}
                      </select>
                      <TextInput value={sshHost} onChange={setSshHost} placeholder="hostname or IP" />
                    </div>
                  </div>
                  <div className="grid grid-cols-[1fr_110px] gap-4">
                    <div>
                      <label className="block text-[12px] text-neutral-400 mb-1.5">User</label>
                      <TextInput value={sshUser} onChange={setSshUser} placeholder={platform === 'windows' ? 'Administrator' : 'root'} />
                    </div>
                    <div>
                      <label className="block text-[12px] text-neutral-400 mb-1.5">Port</label>
                      <TextInput value={sshPort} onChange={setSshPort} placeholder="22" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-[12px] text-neutral-400 mb-1.5">Authentication</label>
                    <div className="inline-flex h-9 rounded-md border border-neutral-700 bg-neutral-900 p-0.5 mb-2">
                      <button
                        type="button"
                        onClick={() => setSshAuthMethod('key')}
                        className={`h-8 px-3 rounded text-[12px] transition-colors ${sshAuthMethod === 'key' ? 'bg-neutral-700 text-neutral-50' : 'text-neutral-400 hover:text-neutral-200'}`}
                      >
                        Private key
                      </button>
                      <button
                        type="button"
                        onClick={() => setSshAuthMethod('password')}
                        className={`h-8 px-3 rounded text-[12px] transition-colors ${sshAuthMethod === 'password' ? 'bg-neutral-700 text-neutral-50' : 'text-neutral-400 hover:text-neutral-200'}`}
                      >
                        Password
                      </button>
                    </div>
                    {sshAuthMethod === 'key' ? (
                      <>
                        <TextInput value={sshKeyPath} onChange={setSshKeyPath} placeholder="~/.ssh/id_rsa" mono />
                        <p className="mt-1 text-[11px] text-neutral-500">
                          Leave blank to use your default SSH agent.
                        </p>
                        <SyncToggle
                          id="edit-key-sync"
                          checked={keySyncEnabled}
                          onChange={setKeySyncEnabled}
                          disabled={!sshKeyPath.trim()}
                          label="Sync to cloud for use on other devices"
                          description="We read the file once, encrypt it on alby.sh with an AES-256-GCM key unique to you, and keep only the ciphertext. On a new device Alby asks the server for your encrypted key, unseals it into its own folder (chmod 600), and uses it — your other machines don't need to re-upload."
                        />
                      </>
                    ) : (
                      <>
                        <TextInput value={sshPassword} onChange={setSshPassword} placeholder="••••••••" type="password" />
                        <SyncToggle
                          id="edit-password-sync"
                          checked={passwordSyncEnabled}
                          onChange={setPasswordSyncEnabled}
                          disabled={!sshPassword}
                          label="Sync to cloud for use on other devices"
                          description="Encrypted on alby.sh with an AES-256-GCM key unique to you (HKDF-derived, so no two users share the same key). The plaintext is decrypted only when this device — or another one you log into — needs to open an SSH connection."
                        />
                      </>
                    )}
                  </div>
                  <div>
                    <label className="block text-[12px] text-neutral-400 mb-1.5">Remote path</label>
                    <TextInput value={remotePath} onChange={setRemotePath} placeholder={platform === 'windows' ? 'C:\\inetpub\\wwwroot\\app' : '/var/www/app'} mono />
                  </div>
                </div>
              </Section>
            )}

            {/* TEST */}
            {!isLocal && (
              <Section
                title="Test connection"
                description="Optional but recommended after editing. Runs the same DNS → TCP → SSH → auth → shell → path probe used at create time."
              >
                <div className="space-y-3">
                  <button
                    type="button"
                    onClick={runTest}
                    disabled={!canRunTest || test.status === 'running'}
                    className="inline-flex items-center gap-2 h-10 px-4 rounded-md text-[13px] font-medium border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:pointer-events-none text-neutral-50 transition-colors"
                  >
                    {test.status === 'running' ? (
                      <>
                        <Renew size={14} className="animate-spin" /> Running…
                      </>
                    ) : (
                      'Run Test Connection'
                    )}
                  </button>
                  <TestResultPanel test={test} onRetry={runTest} />
                </div>
              </Section>
            )}

            {/* DEPLOY PIPELINE */}
            {role === 'deploy' && (
              <Section
                title="Deploy pipeline"
                description="Each deploy: run pre-commands → git pull on the branch → run post-commands. First non-zero exit aborts the pipeline."
              >
                <div className="space-y-5">
                  <div>
                    <label className="block text-[12px] text-neutral-400 mb-1.5">Branch</label>
                    <TextInput value={branch} onChange={setBranch} placeholder="main" mono />
                  </div>
                  <div>
                    <label className="block text-[12px] text-neutral-400 mb-1.5">Pre-commands</label>
                    <CommandList items={preCommands} onChange={setPreCommands} placeholder="e.g. git stash" />
                  </div>
                  <div>
                    <label className="block text-[12px] text-neutral-400 mb-1.5">Post-commands</label>
                    <CommandList items={postCommands} onChange={setPostCommands} placeholder={platform === 'windows' ? 'e.g. iisreset' : 'e.g. php artisan migrate --force'} />
                  </div>
                </div>
              </Section>
            )}

            {/* DANGER ZONE */}
            <Section
              title="Error monitoring"
              description="Toggle the alby.sh error tracker for this environment. When on, you get a public key + a copy-paste snippet to drop in your code; received errors land in the Issues page for this project."
            >
              <MonitoringToggle environment={environment} />
            </Section>

            <Section
              title="Auto-fix"
              description="When a new issue lands from any env of this stack, Alby can spawn Claude here to investigate, fix, commit and push to origin. Only one env per stack can host auto-fix. Local envs can't run it — they need a remote server with a working git remote."
            >
              <AutoFixToggle environment={environment} />
            </Section>

            <Section title="Danger zone" description="Removing the environment is permanent and stops every agent attached to it.">
              {showDeleteConfirm ? (
                <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-[12px] text-red-200 space-y-2">
                  <div>This will delete <span className="font-medium text-red-100">{environment.name}</span> and all its tasks, agents and routines. This action cannot be undone.</div>
                  <div className="flex justify-end gap-2">
                    <button type="button" onClick={() => setShowDeleteConfirm(false)} className="h-8 px-3 rounded-md text-[12px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800">Cancel</button>
                    <button type="button" onClick={handleDelete} disabled={deleteEnvironment.isPending} className="h-8 px-3 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-500 disabled:opacity-50">
                      {deleteEnvironment.isPending ? 'Deleting…' : 'Yes, delete environment'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-[13px] text-red-400 border border-red-500/30 bg-red-500/5 hover:bg-red-500/10 transition-colors"
                >
                  <TrashCan size={14} /> Delete environment
                </button>
              )}
            </Section>
          </div>

          {/* FOOTER */}
          <div className="sticky bottom-0 -mx-8 mt-2 bg-gradient-to-t from-[var(--bg-primary)] via-[var(--bg-primary)] to-transparent pt-8 pb-6 px-8">
            {submitError && (
              <div className="mb-3 rounded-md border border-red-500/50 bg-red-500/10 text-red-200 text-[12px] px-3 py-2">
                {submitError}
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeEditEnvironment}
                className="h-9 px-4 rounded-md text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!canSave}
                className="h-9 px-5 rounded-md text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-colors"
              >
                {updateEnvironment.isPending ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============ Error monitoring (1:1 env↔reporting app) ============ */

function MonitoringToggle({ environment }: { environment: Environment }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [testState, setTestState] = useState<
    { status: 'idle' } | { status: 'running' } | { status: 'ok' } | { status: 'error'; message: string }
  >({ status: 'idle' })
  const app = environment.app ?? null
  // Monitoring is conceptually a stack-level feature — the SDK lives in
  // source code that every env of the stack deploys, so a single public key
  // covers all of them (`ALBY_ENVIRONMENT` differentiates at report time).
  // If a sibling env in the same stack already has it turned on, don't let
  // the user create a second app for this env — it'd produce a duplicate key
  // for the same shipped SDK.
  const { data: envsInSameProject } = useEnvironments(environment.project_id)
  const stackSiblingWithApp = (envsInSameProject ?? []).find(
    (e) =>
      e.id !== environment.id &&
      e.stack_id === environment.stack_id &&
      e.app != null,
  ) ?? null

  const enable = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await window.electronAPI.environments.enableMonitoring(environment.id)
      await qc.invalidateQueries({ queryKey: ['environment', environment.id] })
      await qc.invalidateQueries({ queryKey: ['environments'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const disable = async (): Promise<void> => {
    if (!confirm('Disable error monitoring for this environment? Future events will be rejected and the public key will stop working.')) return
    setBusy(true); setError(null)
    try {
      await window.electronAPI.environments.disableMonitoring(environment.id)
      await qc.invalidateQueries({ queryKey: ['environment', environment.id] })
      await qc.invalidateQueries({ queryKey: ['environments'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const copy = (label: string, text: string): void => {
    navigator.clipboard.writeText(text)
    setCopied(label)
    window.setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
  }

  if (!app) {
    if (stackSiblingWithApp) {
      return (
        <div className="space-y-2">
          <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-[13px] text-emerald-200">
            Monitoring is already configured on{' '}
            <strong className="text-emerald-100">{stackSiblingWithApp.name}</strong>{' '}
            in this stack. The SDK is committed to source code, so this env
            reports under the same public key automatically on its next
            deploy — just set{' '}
            <code className="px-1 py-0.5 rounded bg-emerald-500/10 text-emerald-100 text-[11px]">
              ALBY_ENVIRONMENT={environment.name}
            </code>{' '}
            in this env's .env so events get tagged correctly.
          </div>
          <button
            type="button"
            disabled
            title="One app per stack — enable monitoring from the stack host env instead"
            className="h-9 px-4 rounded-md bg-neutral-800 text-neutral-500 text-[13px] font-medium cursor-not-allowed"
          >
            Enable monitoring
          </button>
        </div>
      )
    }
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={enable}
          disabled={busy}
          className="h-9 px-4 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[13px] font-medium transition-colors"
        >
          {busy ? 'Enabling…' : 'Enable monitoring'}
        </button>
        {error && <div className="text-[12px] text-red-300">{error}</div>}
        <p className="text-[11px] text-neutral-500">
          One app per stack. The public key gets committed to source code, and
          every env in the stack reports under it — ALBY_ENVIRONMENT
          differentiates them at report time.
        </p>
      </div>
    )
  }

  const dsn = `https://${app.public_key}@alby.sh/ingest/v1/${app.id}`
  const browserSnippet = `<!-- Auto-installed global error handler -->
<script src="https://alby.sh/report.js?key=${encodeURIComponent(dsn)}" defer></script>`
  const curlSnippet = `curl -X POST https://alby.sh/api/ingest/v1/events \\
  -H 'Content-Type: application/json' \\
  -H 'X-Alby-Public-Key: ${app.public_key}' \\
  -H 'X-Alby-App-Id: ${app.id}' \\
  -d '{"message":"test event","level":"info","environment":"${environment.name}"}'`

  const sendTestEvent = async (): Promise<void> => {
    setTestState({ status: 'running' })
    try {
      const res = (await window.electronAPI.apps.sendTestEvent({
        dsn,
        environment: environment.name,
      })) as { ok: true } | { ok: false; error: string }
      if (res.ok) setTestState({ status: 'ok' })
      else setTestState({ status: 'error', message: res.error })
    } catch (e) {
      setTestState({
        status: 'error',
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-[12px] text-emerald-200 flex items-center gap-2">
        <span className="size-2 rounded-full bg-emerald-400" />
        <span>Monitoring is active</span>
      </div>
      <div>
        <label className="block text-[12px] text-neutral-400 mb-1.5">Public key</label>
        <div className="flex gap-2">
          <input value={app.public_key} readOnly className="flex-1 h-10 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[12px] font-mono text-neutral-200" />
          <button type="button" onClick={() => copy('key', app.public_key)} className="h-10 px-3 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-[12px] text-neutral-200">
            {copied === 'key' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div>
        <label className="block text-[12px] text-neutral-400 mb-1.5">Debug</label>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={sendTestEvent}
            disabled={testState.status === 'running'}
            className="h-9 px-3 rounded-md border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 text-[12px] text-neutral-100"
          >
            {testState.status === 'running' ? 'Sending…' : 'Send test event'}
          </button>
          {testState.status === 'ok' && (
            <span className="text-[11px] text-emerald-300 inline-flex items-center gap-1">
              <CheckmarkFilled size={12} /> Event sent — check the Issues page.
            </span>
          )}
          {testState.status === 'error' && (
            <span className="text-[11px] text-red-300">Failed: {testState.message}</span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          Posts a single event straight to the Alby ingest endpoint using this key — confirms the DSN and env name without waiting for a real error.
        </p>
      </div>
      <div>
        <label className="block text-[12px] text-neutral-400 mb-1.5">Browser snippet</label>
        <div className="relative">
          <pre className="bg-neutral-950 border border-neutral-800 rounded-md p-3 text-[11px] font-mono text-neutral-200 overflow-x-auto">{browserSnippet}</pre>
          <button type="button" onClick={() => copy('browser', browserSnippet)} className="absolute top-2 right-2 h-7 px-2 rounded text-[11px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200">
            {copied === 'browser' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <div>
        <label className="block text-[12px] text-neutral-400 mb-1.5">Backend (cURL)</label>
        <div className="relative">
          <pre className="bg-neutral-950 border border-neutral-800 rounded-md p-3 text-[11px] font-mono text-neutral-200 overflow-x-auto whitespace-pre">{curlSnippet}</pre>
          <button type="button" onClick={() => copy('curl', curlSnippet)} className="absolute top-2 right-2 h-7 px-2 rounded text-[11px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200">
            {copied === 'curl' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={disable}
        disabled={busy}
        className="h-8 px-3 rounded-md text-[12px] text-red-400 border border-red-500/30 bg-red-500/5 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
      >
        {busy ? 'Disabling…' : 'Disable monitoring'}
      </button>
      {error && <div className="text-[12px] text-red-300">{error}</div>}
    </div>
  )
}

/* ============ Auto-fix (env-level toggle, stack-level storage) ============ */

function AutoFixToggle({ environment }: { environment: Environment }) {
  const { data: stack } = useStack(environment.stack_id ?? null)
  const { data: envsInProject } = useEnvironments(environment.project_id)
  const updateStack = useUpdateStack()

  // The env currently hosting auto-fix (if any) for this stack.
  const hostEnvId = stack?.auto_fix_target_env_id ?? null
  const isThisEnv = hostEnvId === environment.id
  const enabled = isThisEnv
  const otherHost = useMemo(() => {
    if (!hostEnvId || isThisEnv) return null
    return envsInProject?.find((e) => e.id === hostEnvId) ?? null
  }, [hostEnvId, isThisEnv, envsInProject])

  // Local envs can't run a cloud-orchestrated fix loop — they have no always-on
  // server. Deploy envs are read-only. Block both with a clear hint.
  if (environment.execution_mode === 'local') {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-[12px] text-neutral-400">
        Auto-fix needs a remote environment — it runs a loop on the server that polls for new issues.
        Local environments can't host it.
      </div>
    )
  }
  if (environment.role === 'deploy') {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-[12px] text-neutral-400">
        Auto-fix is disabled on deploy targets. Enable it on the stack's operational env
        (dev/staging) — Claude commits + pushes there and production pulls on its next deploy.
      </div>
    )
  }

  const agentType: AutoFixAgentType = stack?.auto_fix_agent_type ?? 'claude'
  const maxPerDay = stack?.auto_fix_max_per_day ?? 5

  const setEnabled = async (next: boolean): Promise<void> => {
    if (!stack) return
    await updateStack.mutateAsync({
      id: stack.id,
      data: {
        auto_fix_enabled: next,
        auto_fix_target_env_id: next ? environment.id : null,
      },
    })
  }

  const setAgent = async (next: AutoFixAgentType): Promise<void> => {
    if (!stack) return
    await updateStack.mutateAsync({ id: stack.id, data: { auto_fix_agent_type: next } })
  }

  const setMax = async (next: number): Promise<void> => {
    if (!stack) return
    await updateStack.mutateAsync({ id: stack.id, data: { auto_fix_max_per_day: next } })
  }

  return (
    <div className="space-y-3">
      {otherHost && !enabled && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-[12px] text-amber-200">
          Auto-fix is currently on{' '}
          <span className="font-medium">{otherHost.name}</span>. Enabling it here will move it —
          only one env per stack can host auto-fix.
        </div>
      )}

      <label className="flex items-center gap-2 text-[13px] text-neutral-200">
        <input
          type="checkbox"
          checked={enabled}
          disabled={updateStack.isPending || !stack}
          onChange={(e) => setEnabled(e.target.checked)}
          className="size-4"
        />
        Enable auto-fix on <span className="font-medium">{environment.name}</span>
      </label>

      {enabled && (
        <div className="space-y-3 pl-6 border-l border-neutral-800 ml-1">
          <div>
            <label className="block text-[12px] text-neutral-400 mb-1">Agent</label>
            <select
              value={agentType}
              onChange={(e) => setAgent(e.target.value as AutoFixAgentType)}
              disabled={updateStack.isPending}
              className="w-full max-w-xs h-9 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[12px] text-neutral-50 disabled:opacity-40"
            >
              <option value="claude">claude</option>
              <option value="gemini">gemini</option>
              <option value="codex">codex</option>
            </select>
          </div>
          <div>
            <label className="block text-[12px] text-neutral-400 mb-1">Max auto-fixes per day</label>
            <input
              type="number"
              min={0}
              max={1000}
              value={maxPerDay}
              onChange={(e) => setMax(Number(e.target.value))}
              disabled={updateStack.isPending}
              className="w-32 h-9 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[12px] text-neutral-50 disabled:opacity-40"
            />
          </div>
          <div className="text-[11px] text-neutral-500">
            On each new issue Alby SSHes into this env, pulls, spawns {agentType}, fixes, commits and
            pushes to origin. Production envs pick up the fix on their next deploy.
          </div>
        </div>
      )}
    </div>
  )
}
