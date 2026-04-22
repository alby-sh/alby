import { useEffect, useMemo, useState } from 'react'
import { Close, TrashCan } from '@carbon/icons-react'
import { useStack, useUpdateStack, useDeleteStack } from '../../hooks/useStacks'
import { useEnvironments, useProjects } from '../../hooks/useProjects'
import { useAppStore } from '../../stores/app-store'
import type { AutoFixAgentType, Stack, StackKind } from '../../../shared/types'

const KIND_LABELS: Record<StackKind, string> = {
  website: 'Website',
  webapp: 'Web app',
  api: 'API',
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Fullstack',
  script: 'Script',
  mobile_app: 'Mobile app',
  desktop_app: 'Desktop app',
  library: 'Library',
  custom: 'Custom',
}

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

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  disabled?: boolean
}) {
  return (
    <input
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors disabled:opacity-60 ${
        mono ? 'font-mono' : ''
      }`}
    />
  )
}

export function EditStackView({ stackId }: { stackId: string }) {
  const { data: stack } = useStack(stackId)
  const updateStack = useUpdateStack()
  const { data: projects } = useProjects()
  const { data: environments } = useEnvironments(stack?.project_id ?? null)
  const deleteStack = useDeleteStack(stack?.project_id ?? '')
  const closeEditStack = useAppStore((s) => s.closeEditStack)

  const project = useMemo(
    () => projects?.find((p) => p.id === stack?.project_id) ?? null,
    [projects, stack?.project_id]
  )

  const [name, setName] = useState('')
  const [kind, setKind] = useState<StackKind>('custom')
  const [gitRemote, setGitRemote] = useState('')
  const [branch, setBranch] = useState('main')
  const [autoFixEnabled, setAutoFixEnabled] = useState(false)
  const [autoFixAgent, setAutoFixAgent] = useState<AutoFixAgentType>('claude')
  const [autoFixTargetEnv, setAutoFixTargetEnv] = useState<string>('')
  const [autoFixMax, setAutoFixMax] = useState(5)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (stack) {
      setName(stack.name)
      setKind(stack.kind)
      setGitRemote(stack.git_remote_url ?? '')
      setBranch(stack.default_branch)
      setAutoFixEnabled(stack.auto_fix_enabled)
      setAutoFixAgent(stack.auto_fix_agent_type)
      setAutoFixTargetEnv(stack.auto_fix_target_env_id ?? '')
      setAutoFixMax(stack.auto_fix_max_per_day)
    }
  }, [stack])

  const flashSaved = (key: string) => {
    setSavedKey(key)
    window.setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1500)
  }

  const save = (patch: Partial<Stack>, key: string) => {
    if (!stack) return
    updateStack.mutate(
      { id: stack.id, data: patch },
      { onSuccess: () => flashSaved(key) }
    )
  }

  const stackEnvs = useMemo(
    () => (environments ?? []).filter((e) => e.stack_id === stackId),
    [environments, stackId]
  )
  const stackEnvCount = stackEnvs.length

  if (!stack) {
    return (
      <div className="flex-1 flex flex-col bg-[var(--bg-primary)] items-center justify-center text-neutral-400 text-sm">
        Loading stack…
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400">
          {project?.name ?? '…'} <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">{stack.name}</span>{' '}
          <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">Settings</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeEditStack}
          aria-label="Close"
          className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <Close size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">Stack Settings</h2>
            <p className="text-[14px] text-neutral-400">
              A stack is a single codebase under this project. Envs of this stack share its git
              remote and auto-fix config.
            </p>
          </div>

          <div className="border-t border-neutral-800">
            <Section title="Name" description="Shown in the sidebar and breadcrumbs.">
              <div className="flex items-center gap-2">
                <TextInput value={name} onChange={setName} />
                <button
                  type="button"
                  onClick={() => save({ name: name.trim() }, 'name')}
                  disabled={!name.trim() || name === stack.name}
                  className="h-9 px-3 rounded-md text-[12px] text-neutral-300 border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
                >
                  {savedKey === 'name' ? 'Saved' : 'Save'}
                </button>
              </div>
            </Section>

            <Section title="Kind" description="Used for icons and quick filters.">
              <select
                value={kind}
                onChange={(e) => {
                  const next = e.target.value as StackKind
                  setKind(next)
                  save({ kind: next }, 'kind')
                }}
                className="flex h-10 w-full max-w-xs rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500 transition-colors"
              >
                {(Object.keys(KIND_LABELS) as StackKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </Section>

            <Section title="Git remote" description="One repo per stack. Every env of this stack deploys code from here.">
              <div className="flex items-center gap-2">
                <TextInput
                  value={gitRemote}
                  onChange={setGitRemote}
                  placeholder="git@github.com:org/repo.git"
                  mono
                />
                <button
                  type="button"
                  onClick={() =>
                    save({ git_remote_url: gitRemote.trim() || null }, 'gitRemote')
                  }
                  disabled={gitRemote === (stack.git_remote_url ?? '')}
                  className="h-9 px-3 rounded-md text-[12px] text-neutral-300 border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
                >
                  {savedKey === 'gitRemote' ? 'Saved' : 'Save'}
                </button>
              </div>
            </Section>

            <Section title="Default branch" description="What deploy pulls when an env has no branch override.">
              <div className="flex items-center gap-2">
                <TextInput value={branch} onChange={setBranch} placeholder="main" mono />
                <button
                  type="button"
                  onClick={() => save({ default_branch: branch.trim() || 'main' }, 'branch')}
                  disabled={branch === stack.default_branch}
                  className="h-9 px-3 rounded-md text-[12px] text-neutral-300 border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:opacity-40 transition-colors"
                >
                  {savedKey === 'branch' ? 'Saved' : 'Save'}
                </button>
              </div>
            </Section>

            <Section
              title="Auto-fix"
              description="Enable or disable auto-fix on a specific environment of this stack. Only one env can host it — typically dev or staging, since Claude commits and pushes from there."
            >
              {stack.auto_fix_target_env_id ? (
                (() => {
                  const host = stackEnvs.find((e) => e.id === stack.auto_fix_target_env_id) ?? null
                  return (
                    <div className="text-[13px] text-neutral-200">
                      Hosted by{' '}
                      <span className="font-medium text-neutral-50">
                        {host?.name ?? 'unknown env'}
                      </span>
                      .{' '}
                      <span className="text-neutral-500">
                        Open that env's settings to change the agent type or daily cap.
                      </span>
                    </div>
                  )
                })()
              ) : (
                <div className="text-[13px] text-neutral-400">
                  No auto-fix configured. Open a remote (non-deploy) env of this stack and toggle
                  <span className="text-neutral-200"> Enable auto-fix</span> there.
                </div>
              )}
            </Section>

            <Section
              title="Danger zone"
              description="Stacks can only be deleted once they have no environments under them."
            >
              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={stackEnvCount > 0}
                  className="h-9 px-3 rounded-md text-[12px] text-red-300 border border-red-500/30 bg-red-500/5 hover:bg-red-500/10 disabled:opacity-40 disabled:pointer-events-none transition-colors flex items-center gap-1"
                >
                  <TrashCan size={14} /> Delete stack
                  {stackEnvCount > 0 && (
                    <span className="text-neutral-500 ml-2">
                      — {stackEnvCount} env{stackEnvCount === 1 ? '' : 's'} still here
                    </span>
                  )}
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-neutral-300">
                    Delete "{stack.name}" and all its settings?
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      await deleteStack.mutateAsync(stack.id)
                      closeEditStack()
                    }}
                    className="h-9 px-3 rounded-md text-[12px] text-white bg-red-600 hover:bg-red-500 transition-colors"
                  >
                    Yes, delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="h-9 px-3 rounded-md text-[12px] text-neutral-300 border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  )
}
