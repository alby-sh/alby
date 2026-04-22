import { useState } from 'react'
import {
  Close,
  Launch,
  Application,
  Api,
  Screen,
  BareMetalServer,
  Cube,
  Script,
  Mobile,
  Laptop,
  Book,
  Code,
} from '@carbon/icons-react'
import { useCreateStack } from '../../hooks/useStacks'
import { useProjects } from '../../hooks/useProjects'
import { useAppStore } from '../../stores/app-store'
import type { StackKind } from '../../../shared/types'

const KIND_CARDS: {
  kind: StackKind
  title: string
  description: string
  Icon: React.ComponentType<{ size?: number }>
}[] = [
  { kind: 'website', title: 'Website', description: 'Marketing or content site.', Icon: Launch },
  { kind: 'webapp', title: 'Web app', description: 'Auth + dashboard + database.', Icon: Application },
  { kind: 'api', title: 'API', description: 'REST or GraphQL service.', Icon: Api },
  { kind: 'frontend', title: 'Frontend', description: 'SPA or UI layer only.', Icon: Screen },
  { kind: 'backend', title: 'Backend', description: 'Headless service or worker.', Icon: BareMetalServer },
  { kind: 'fullstack', title: 'Fullstack', description: 'Everything in one repo.', Icon: Cube },
  { kind: 'mobile_app', title: 'Mobile app', description: 'iOS / Android native or hybrid.', Icon: Mobile },
  { kind: 'desktop_app', title: 'Desktop app', description: 'Electron or native desktop.', Icon: Laptop },
  { kind: 'script', title: 'Script', description: 'CLI or standalone job.', Icon: Script },
  { kind: 'library', title: 'Library', description: 'Reusable package.', Icon: Book },
  { kind: 'custom', title: 'Custom', description: 'Something else.', Icon: Code },
]

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
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors ${
        mono ? 'font-mono' : ''
      }`}
    />
  )
}

function KindCard({
  active,
  onClick,
  title,
  description,
  Icon,
}: {
  active: boolean
  onClick: () => void
  title: string
  description: string
  Icon: React.ComponentType<{ size?: number }>
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition-all ${
        active
          ? 'border-blue-500/70 bg-blue-500/5'
          : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-600'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className={`size-9 rounded-lg flex items-center justify-center shrink-0 ${
            active ? 'bg-blue-500/15 text-blue-300' : 'bg-neutral-800 text-neutral-400'
          }`}
        >
          <Icon size={20} />
        </div>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold text-neutral-100">{title}</div>
          <p className="mt-1 text-[12px] text-neutral-400">{description}</p>
        </div>
      </div>
    </button>
  )
}

export function AddStackView({ projectId }: { projectId: string }) {
  const { data: projects } = useProjects()
  const createStack = useCreateStack()
  const closeAddStack = useAppStore((s) => s.closeAddStack)
  const openEditStack = useAppStore((s) => s.openEditStack)

  const project = projects?.find((p) => p.id === projectId) ?? null

  const [name, setName] = useState('')
  const [kind, setKind] = useState<StackKind>('website')
  const [gitRemote, setGitRemote] = useState('')
  const [branch, setBranch] = useState('main')
  const [error, setError] = useState<string | null>(null)

  const canSubmit = name.trim().length > 0 && !createStack.isPending

  const handleCreate = async (): Promise<void> => {
    if (!canSubmit) return
    setError(null)
    try {
      const stack = await createStack.mutateAsync({
        project_id: projectId,
        name: name.trim(),
        kind,
        git_remote_url: gitRemote.trim() || null,
        default_branch: branch.trim() || 'main',
      })
      closeAddStack()
      openEditStack(stack.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400">
          {project?.name ?? '…'} <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">New stack</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeAddStack}
          aria-label="Close"
          className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <Close size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">Add Stack</h2>
            <p className="text-[14px] text-neutral-400">
              A stack is a single codebase/repo. Pick a kind and give it a name; you'll add
              environments (dev/staging/prod/etc.) under it next.
            </p>
          </div>

          <div className="border-t border-neutral-800">
            <Section
              title="Kind"
              description="Used for sidebar icons and quick filters. Pick the closest match."
            >
              <div className="grid grid-cols-2 gap-3">
                {KIND_CARDS.map((card) => (
                  <KindCard
                    key={card.kind}
                    active={kind === card.kind}
                    onClick={() => setKind(card.kind)}
                    title={card.title}
                    description={card.description}
                    Icon={card.Icon}
                  />
                ))}
              </div>
            </Section>

            <Section title="Name" description="Shown in the sidebar and breadcrumbs.">
              <TextInput value={name} onChange={setName} placeholder="e.g. Website" />
            </Section>

            <Section
              title="Git remote"
              description="One repo per stack. All environments deploy code from here. Optional — you can set it later."
            >
              <TextInput
                value={gitRemote}
                onChange={setGitRemote}
                placeholder="git@github.com:org/repo.git"
                mono
              />
            </Section>

            <Section
              title="Default branch"
              description="Branch deploy pulls when no env-level override is set."
            >
              <TextInput value={branch} onChange={setBranch} placeholder="main" mono />
            </Section>
          </div>

          {error && (
            <div className="mt-4 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-300">
              {error}
            </div>
          )}

          <div className="sticky bottom-0 bg-[var(--bg-primary)] pt-4 mt-4 border-t border-neutral-800">
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeAddStack}
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
                {createStack.isPending ? 'Creating…' : 'Create stack'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
