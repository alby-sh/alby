import { useEffect, useMemo, useState } from 'react'
import { Close, Copy, TrashCan } from '@carbon/icons-react'
import { useDeleteTask, useEnvironment, useTasks, useUpdateTask } from '../../hooks/useProjects'
import { useAllAgents } from '../../hooks/useAgents'
import { useAppStore } from '../../stores/app-store'
import type { Task } from '../../../shared/types'

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
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors"
    />
  )
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors resize-y"
    />
  )
}

export function TaskSettingsView({ taskId }: { taskId: string }) {
  const closeTaskSettings = useAppStore((s) => s.closeTaskSettings)
  const updateTask = useUpdateTask()
  const deleteTask = useDeleteTask()
  const { data: allAgents } = useAllAgents()

  const selectedEnvironmentId = useAppStore((s) => s.selectedEnvironmentId)
  const { data: tasks } = useTasks(selectedEnvironmentId)
  const task = useMemo(() => tasks?.find((t) => t.id === taskId) ?? null, [tasks, taskId])
  const { data: environment } = useEnvironment(task?.environment_id ?? selectedEnvironmentId)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [contextNotes, setContextNotes] = useState('')
  const [status, setStatus] = useState<Task['status']>('open')
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showRunningBlock, setShowRunningBlock] = useState(false)

  useEffect(() => {
    if (task) {
      setTitle(task.title)
      setDescription(task.description ?? '')
      setContextNotes(task.context_notes ?? '')
      setStatus(task.status)
    }
  }, [task])

  const runningAgents = useMemo(() => {
    return (allAgents ?? []).filter((a) => a.task_id === taskId && a.status === 'running')
  }, [allAgents, taskId])

  const flashSaved = (key: string): void => {
    setSavedKey(key)
    window.setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1800)
  }

  const saveField = (field: keyof Pick<Task, 'title' | 'description' | 'context_notes' | 'status'>, value: string): void => {
    if (!task) return
    updateTask.mutate(
      { id: taskId, data: { [field]: value } },
      { onSuccess: () => flashSaved(field) }
    )
  }

  const handleDelete = (): void => {
    setShowDeleteConfirm(false)
    deleteTask.mutate(taskId, { onSuccess: () => closeTaskSettings() })
  }

  if (!task) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Loading task…
      </div>
    )
  }

  if (task.is_default) {
    return (
      <div className="flex-1 flex flex-col bg-[var(--bg-primary)]">
        <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
          <div className="text-[14px] text-neutral-400">
            {environment?.name ?? 'Environment'} <span className="text-neutral-600">/</span>{' '}
            <span className="text-neutral-200">general</span>
          </div>
          <div className="flex-1" />
          <button onClick={closeTaskSettings} className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200">
            <Close size={16} />
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-sm px-8 text-center">
          The <code className="mx-1 text-neutral-300">general</code> task is a protected catch-all created automatically for every environment. It has no editable settings.
        </div>
      </div>
    )
  }

  const createdLabel = task.created_at ? new Date(task.created_at).toLocaleString() : task.created_at
  const isTitleDirty = title.trim() && title.trim() !== task.title
  const isDescDirty = (description ?? '') !== (task.description ?? '')
  const isNotesDirty = (contextNotes ?? '') !== (task.context_notes ?? '')

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400 truncate">
          {environment?.name ?? 'Environment'} <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200 truncate">{task.title}</span>{' '}
          <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">Settings</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={closeTaskSettings}
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
            <h2 className="text-2xl font-bold text-neutral-50">Task Settings</h2>
            <p className="text-[14px] text-neutral-400">
              Edit this task's metadata and the context injected into any agent spawned under it.
            </p>
          </div>

          <div className="border-t border-neutral-800">
            <Section
              title="Title"
              description="Shown in the sidebar and used as the tab label for agents of this task."
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TextInput value={title} onChange={setTitle} placeholder="e.g. Fix login bug" />
                  <PrimaryButton
                    onClick={() => saveField('title', title.trim())}
                    disabled={updateTask.isPending || !isTitleDirty}
                  >
                    Save
                  </PrimaryButton>
                </div>
                {savedKey === 'title' && <span className="text-[11px] text-emerald-400">Saved</span>}
              </div>
            </Section>

            <Section
              title="Description"
              description="Short description visible in the task list. Not sent to agents."
            >
              <div className="space-y-2">
                <TextArea value={description} onChange={setDescription} placeholder="One-line description (optional)" rows={3} />
                <div className="flex items-center gap-2">
                  <PrimaryButton
                    onClick={() => saveField('description', description)}
                    disabled={updateTask.isPending || !isDescDirty}
                  >
                    Save description
                  </PrimaryButton>
                  {savedKey === 'description' && <span className="text-[11px] text-emerald-400">Saved</span>}
                </div>
              </div>
            </Section>

            <Section
              title="Context notes for agents"
              description="Appended to the system prompt of every agent spawned on this task. Use it for long-lived context: coding conventions, file layout hints, the current ticket description, etc."
            >
              <div className="space-y-2">
                <TextArea value={contextNotes} onChange={setContextNotes} placeholder="e.g. This task concerns only the billing module. Our pricing rules live in src/lib/pricing.ts." rows={6} />
                <div className="flex items-center gap-2">
                  <PrimaryButton
                    onClick={() => saveField('context_notes', contextNotes)}
                    disabled={updateTask.isPending || !isNotesDirty}
                  >
                    Save context
                  </PrimaryButton>
                  {savedKey === 'context_notes' && <span className="text-[11px] text-emerald-400">Saved</span>}
                </div>
              </div>
            </Section>

            <Section
              title="Status"
              description="'Done' tasks get a strikethrough in the sidebar and are visually de-prioritized."
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as Task['status'])}
                    className="h-10 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500"
                  >
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="done">Done</option>
                  </select>
                  <PrimaryButton
                    onClick={() => saveField('status', status)}
                    disabled={updateTask.isPending || status === task.status}
                  >
                    Save
                  </PrimaryButton>
                  {savedKey === 'status' && <span className="text-[11px] text-emerald-400">Saved</span>}
                </div>
              </div>
            </Section>

            <Section
              title="Task Info"
              description="Read-only metadata. Useful for debugging or referencing this task."
            >
              <dl className="space-y-3 text-[13px]">
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Task ID</dt>
                  <dd className="flex-1 flex items-center gap-2 min-w-0">
                    <code className="font-mono text-[12px] text-neutral-300 truncate">{task.id}</code>
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(task.id).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) }) }}
                      title="Copy ID"
                      className="size-7 flex items-center justify-center rounded hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors shrink-0"
                    >
                      <Copy size={14} />
                    </button>
                    {copied && <span className="text-[11px] text-emerald-400">Copied</span>}
                  </dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Created</dt>
                  <dd className="text-neutral-300">{createdLabel}</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Environment</dt>
                  <dd className="text-neutral-300">{environment?.name ?? '—'}</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Running agents</dt>
                  <dd className="text-neutral-300">{runningAgents.length}</dd>
                </div>
              </dl>
            </Section>

            <div className="py-8">
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-4">
                <h3 className="text-[14px] font-semibold text-red-300 mb-1">Delete Task</h3>
                <p className="text-[13px] text-red-400/80 mb-4">
                  Permanently removes this task and its agent records. Running tmux sessions
                  on the remote server will continue running unless you stop them from the
                  terminal tabs first.
                </p>
                <button
                  type="button"
                  onClick={() => runningAgents.length > 0 ? setShowRunningBlock(true) : setShowDeleteConfirm(true)}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-red-600/90 hover:bg-red-600 text-white transition-colors"
                >
                  <TrashCan size={14} />
                  Delete Task
                </button>
                {runningAgents.length > 0 && (
                  <p className="mt-2 text-[12px] text-red-400/70">
                    {runningAgents.length} running agent{runningAgents.length === 1 ? '' : 's'} —
                    stop {runningAgents.length === 1 ? 'it' : 'them'} before deleting.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showRunningBlock && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={() => setShowRunningBlock(false)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[420px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-neutral-50 mb-2">Stop running agents first</div>
            <p className="text-[13px] text-neutral-400 mb-4">
              This task has <span className="text-neutral-200 font-medium">{runningAgents.length} running agent{runningAgents.length === 1 ? '' : 's'}</span>. Close {runningAgents.length === 1 ? 'it' : 'them all'} before deleting.
            </p>
            <div className="flex justify-end">
              <button onClick={() => setShowRunningBlock(false)} className="h-8 px-4 rounded-lg text-[13px] text-neutral-50 bg-neutral-700 hover:bg-neutral-600">OK</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[420px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-neutral-50 mb-2">Delete "{task.title}"?</div>
            <p className="text-[13px] text-neutral-400 mb-4">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800">Cancel</button>
              <button onClick={handleDelete} className="h-8 px-4 rounded-lg text-[13px] text-white bg-red-600 hover:bg-red-500">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
