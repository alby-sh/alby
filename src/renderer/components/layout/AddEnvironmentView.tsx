import { useEffect, useMemo, useState } from 'react'
import { Close, TrashCan, Add, Renew, CheckmarkFilled, WarningAltFilled } from '@carbon/icons-react'
import { useAppStore } from '../../stores/app-store'
import { useCreateEnvironment, useProjects } from '../../hooks/useProjects'
import type {
  CreateEnvironmentDTO,
  EnvironmentPlatform,
  EnvironmentRole,
  SSHHost,
  SSHPreflightResult,
} from '../../../shared/types'

interface Props {
  projectId: string
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
  disabled,
}: {
  title: string
  description?: string
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <div
      className={`grid grid-cols-1 gap-x-10 gap-y-4 py-6 md:grid-cols-10 border-b border-neutral-800 last:border-b-0 ${
        disabled ? 'opacity-40 pointer-events-none' : ''
      }`}
    >
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
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  icon: React.ReactNode
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 text-left rounded-xl border p-4 transition-all ${
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
  const remove = (idx: number): void => {
    onChange(items.filter((_, i) => i !== idx))
  }
  const add = (): void => {
    onChange([...items, ''])
  }
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
        <p>
          Connection hasn't been tested yet. You must run a successful test before you can create
          the environment — this catches wrong keys, closed ports, and firewall issues up front.
        </p>
      </div>
    )
  }
  if (test.status === 'running') {
    return (
      <div className="rounded-lg border border-blue-500/40 bg-blue-500/5 p-4 text-[13px] text-blue-200 flex items-center gap-3">
        <Renew size={16} className="animate-spin" />
        <div>
          Running preflight: DNS → TCP → SSH handshake → authentication → shell → path → git…
        </div>
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
          {result.code && (
            <div className="mt-2 text-[11px] text-neutral-500 font-mono">code: {result.code}</div>
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

export function AddEnvironmentView({ projectId }: Props) {
  // Picked up from the store when the user clicks "Add environment" inside a
  // specific stack row in the sidebar. Null when no stack is specified (the
  // backend then auto-assigns the project's first stack).
  const stackId = useAppStore((s) => s.addingEnvironmentForStackId)
  const { data: projects } = useProjects()
  const closeAddEnvironment = useAppStore((s) => s.closeAddEnvironment)
  const createEnvironment = useCreateEnvironment()

  const project = useMemo(() => projects?.find((p) => p.id === projectId), [projects, projectId])

  // --- Form state ---
  const [role, setRole] = useState<EnvironmentRole>('operational')
  const [executionMode, setExecutionMode] = useState<'remote' | 'local'>('remote')
  const [platform, setPlatform] = useState<EnvironmentPlatform>('linux')
  const [name, setName] = useState('')
  const [label, setLabel] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshUser, setSshUser] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshKeyPath, setSshKeyPath] = useState('')
  // Default ON for new environments — the cross-device UX is the whole point
  // of adding an env in the first place. The user can turn it off if they
  // want device-local credentials.
  const [passwordSyncEnabled, setPasswordSyncEnabled] = useState(true)
  const [keySyncEnabled, setKeySyncEnabled] = useState(true)
  const [sshAuthMethod, setSshAuthMethod] = useState<'key' | 'password'>('key')
  const [sshPassword, setSshPassword] = useState('')
  const [remotePath, setRemotePath] = useState('')
  const [branch, setBranch] = useState('main')
  const [preCommands, setPreCommands] = useState<string[]>([])
  const [postCommands, setPostCommands] = useState<string[]>([])
  const [hosts, setHosts] = useState<SSHHost[]>([])
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    window.electronAPI.ssh.listHosts().then(setHosts).catch(() => { /* ignore */ })
  }, [])

  // Invalidate prior test when any connection-affecting field changes — a
  // green badge against stale values would be misleading. The user must
  // re-run the preflight whenever the connection inputs move.
  useEffect(() => {
    setTest({ status: 'idle' })
  }, [sshHost, sshUser, sshPort, sshKeyPath, sshAuthMethod, sshPassword, remotePath, platform, role])

  // Operational envs are Linux-only in this release; force the invariant as
  // soon as the role flips so the UI can't drift into an inconsistent state.
  useEffect(() => {
    if (role === 'operational' && platform !== 'linux') setPlatform('linux')
    // Deploy targets are remote by definition — there's no concept of
    // "deploying to your local machine".
    if (role === 'deploy' && executionMode !== 'remote') setExecutionMode('remote')
  }, [role, platform, executionMode])

  const trimmedHost = sshHost.trim()
  const trimmedPath = remotePath.trim()
  const portNum = Math.max(1, Math.min(65535, parseInt(sshPort, 10) || 22))

  const isLocal = executionMode === 'local'
  const canRunTest = !isLocal && !!(trimmedHost && trimmedPath)
  // Local envs skip the SSH preflight (there's nothing to test). Remote envs
  // still require it so wrong keys / closed ports get caught up front.
  const canSubmit = !!name.trim() && (isLocal ? !!trimmedPath : test.status === 'ok') && createEnvironment.isPending === false

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

  const handleCreate = async (): Promise<void> => {
    if (!canSubmit) return
    setSubmitError(null)
    const dto: CreateEnvironmentDTO = {
      project_id: projectId,
      ...(stackId ? { stack_id: stackId } : {}),
      name: name.trim(),
      label: label.trim() || undefined,
      execution_mode: executionMode,
      role,
      platform,
      ssh_host: isLocal ? '' : trimmedHost,
      ssh_user: isLocal ? undefined : (sshUser.trim() || undefined),
      ssh_port: isLocal ? 22 : portNum,
      ssh_key_path: isLocal ? undefined : (sshKeyPath.trim() || undefined),
      ssh_auth_method: isLocal ? undefined : sshAuthMethod,
      ssh_password: !isLocal && sshAuthMethod === 'password' ? sshPassword : undefined,
      remote_path: trimmedPath,
    }

    // Vault-sync inputs. For new envs the backend can always derive what it
    // needs from the plaintext values we're already passing — we only have
    // to read the private key off disk once here for the initial upload.
    if (!isLocal && sshAuthMethod === 'password') {
      dto.ssh_password_sync_enabled = passwordSyncEnabled
    }
    if (!isLocal && sshAuthMethod === 'key' && sshKeyPath.trim() && keySyncEnabled) {
      const content = await window.electronAPI.environments.readPrivateKey(sshKeyPath.trim())
      if (!content) {
        setSubmitError(`Couldn't read the private key at ${sshKeyPath.trim()}. Check the path and file permissions.`)
        return
      }
      dto.ssh_private_key_content = content
      dto.ssh_private_key_sync_enabled = true
    }
    if (role === 'deploy') {
      dto.deploy_config = {
        branch: branch.trim() || 'main',
        pre_commands: preCommands.map((c) => c.trim()).filter(Boolean),
        post_commands: postCommands.map((c) => c.trim()).filter(Boolean),
      }
    }
    createEnvironment.mutate(dto, {
      onSuccess: () => closeAddEnvironment(),
      onError: (err) => setSubmitError((err as Error).message),
    })
  }

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Project not found.
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400">
          {project.name} <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">New Environment</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeAddEnvironment}
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
            <h2 className="text-2xl font-bold text-neutral-50">Add Environment</h2>
            <p className="text-[14px] text-neutral-400">
              Configure a new environment for <span className="text-neutral-200">{project.name}</span>. A
              successful connection test is required before the environment can be saved.
            </p>
          </div>

          <div className="border-t border-neutral-800">
            {/* ROLE */}
            <Section
              title="Purpose"
              description="Operational = place where you develop and spawn agents/terminals. Deploy = production target, read-only: only git pull + predefined commands."
            >
              <div className="flex gap-3">
                <RoleCard
                  active={role === 'operational'}
                  onClick={() => setRole('operational')}
                  title="Operational"
                  description="Run terminals and AI agents from this workspace. Linux only."
                  icon={
                    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7">
                      <path d="M4 17l6-5-6-5M12 19h8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  }
                />
                <RoleCard
                  active={role === 'deploy'}
                  onClick={() => setRole('deploy')}
                  title="Deploy target"
                  description="No interactive shell. One-click deploy: git pull + your migrate / cache-clear / restart commands."
                  danger
                  icon={
                    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.7">
                      <path
                        d="M12 3v14m0 0l-5-5m5 5l5-5M4 21h16"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  }
                />
              </div>
            </Section>

            {/* WHERE: local vs remote (operational only — deploy is always remote) */}
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
                  <TextInput
                    value={name}
                    onChange={setName}
                    placeholder={role === 'deploy' ? 'production' : 'dev'}
                  />
                </div>
                <div>
                  <label className="block text-[12px] text-neutral-400 mb-1.5">Website (optional)</label>
                  <TextInput value={label} onChange={setLabel} placeholder="example.com" />
                </div>
              </div>
            </Section>

            {/* LOCAL FOLDER (when Local) */}
            {isLocal && (
              <Section
                title="Local folder"
                description="The folder on this Mac where agents will be spawned. Pick any directory you have read/write access to — it doesn't need to be a git repo."
              >
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <TextInput
                      value={remotePath}
                      onChange={setRemotePath}
                      placeholder="/Users/you/code/my-project"
                      mono
                    />
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

            {/* SSH CONNECTION (when Remote) */}
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
                      <TextInput
                        value={sshHost}
                        onChange={setSshHost}
                        placeholder="hostname or IP, e.g. prod.example.com"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-[1fr_110px] gap-4">
                    <div>
                      <label className="block text-[12px] text-neutral-400 mb-1.5">User</label>
                      <TextInput
                        value={sshUser}
                        onChange={setSshUser}
                        placeholder={platform === 'windows' ? 'Administrator' : 'root'}
                      />
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
                        <TextInput
                          value={sshKeyPath}
                          onChange={setSshKeyPath}
                          placeholder="~/.ssh/id_rsa"
                          mono
                        />
                        <p className="mt-1 text-[11px] text-neutral-500">
                          Leave blank to use your default SSH agent.
                        </p>
                        <SyncToggle
                          id="add-key-sync"
                          checked={keySyncEnabled}
                          onChange={setKeySyncEnabled}
                          disabled={!sshKeyPath.trim()}
                          label="Sync to cloud for use on other devices"
                          description="We read the file once, encrypt it on alby.sh with an AES-256-GCM key unique to you, and keep only the ciphertext. On a new device Alby asks the server for your encrypted key, unseals it into its own folder (chmod 600), and uses it — your other machines don't need to re-upload."
                        />
                      </>
                    ) : (
                      <>
                        <TextInput
                          value={sshPassword}
                          onChange={setSshPassword}
                          placeholder="••••••••"
                          type="password"
                        />
                        <SyncToggle
                          id="add-password-sync"
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
                    <TextInput
                      value={remotePath}
                      onChange={setRemotePath}
                      placeholder={platform === 'windows' ? 'C:\\inetpub\\wwwroot\\app' : '/var/www/app'}
                      mono
                    />
                  </div>
                </div>
              </Section>
            )}

            {/* TEST */}
            {!isLocal && (
              <Section
                title="Test connection"
                description="Required. We probe DNS, TCP, SSH handshake, authentication, shell, remote path and git. Failures explain what to fix."
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

            {/* DEPLOY PIPELINE (only for deploy role) */}
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
                    <label className="block text-[12px] text-neutral-400 mb-1.5">
                      Pre-commands (run before git pull)
                    </label>
                    <CommandList
                      items={preCommands}
                      onChange={setPreCommands}
                      placeholder="e.g. git stash"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] text-neutral-400 mb-1.5">
                      Post-commands (run after git pull)
                    </label>
                    <CommandList
                      items={postCommands}
                      onChange={setPostCommands}
                      placeholder={
                        platform === 'windows'
                          ? 'e.g. iisreset'
                          : 'e.g. php artisan migrate --force'
                      }
                    />
                  </div>
                </div>
              </Section>
            )}
          </div>

          {/* FOOTER */}
          <div className="sticky bottom-0 -mx-8 mt-2 bg-gradient-to-t from-[var(--bg-primary)] via-[var(--bg-primary)] to-transparent pt-8 pb-6 px-8">
            {submitError && (
              <div className="mb-3 rounded-md border border-red-500/50 bg-red-500/10 text-red-200 text-[12px] px-3 py-2">
                {submitError}
              </div>
            )}
            <div className="flex items-center justify-between">
              <div className="text-[12px] text-neutral-500">
                {isLocal
                  ? trimmedPath
                    ? 'Local folder set — environment can be created.'
                    : 'Pick a local folder to enable the Create button.'
                  : test.status === 'ok'
                  ? 'Preflight passed — environment can be created.'
                  : 'Run a successful preflight to enable the Create button.'}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={closeAddEnvironment}
                  className="h-9 px-4 rounded-md text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={!canSubmit}
                  className="h-9 px-5 rounded-md text-[13px] font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:pointer-events-none text-white transition-colors"
                >
                  {createEnvironment.isPending ? 'Creating…' : 'Create Environment'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
