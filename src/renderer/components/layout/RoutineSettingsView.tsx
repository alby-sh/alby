import { useEffect, useMemo, useState } from 'react'
import { Close, Copy, TrashCan } from '@carbon/icons-react'
import { useEnvironment } from '../../hooks/useProjects'
import { useAllRoutines, useDeleteRoutine, useStartRoutine, useStopRoutine, useUpdateRoutine } from '../../hooks/useRoutines'
import { useAppStore } from '../../stores/app-store'
import type { Routine, RoutineAgentType } from '../../../shared/types'
import { parseCronToInterval, intervalToPresetLabel } from '../../../shared/cron-parser'
import { RoutineAllowlistPicker } from '../ui/RoutineAllowlistPicker'

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
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

function PrimaryButton({ children, disabled, onClick, type = 'button' }: { children: React.ReactNode; disabled?: boolean; onClick?: () => void; type?: 'button' | 'submit' }) {
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

function TextInput({ value, onChange, placeholder, className = '' }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500 transition-colors ${className}`}
    />
  )
}

function TextArea({ value, onChange, placeholder, rows = 4 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
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

export function RoutineSettingsView({ routineId }: { routineId: string }) {
  const closeRoutineSettings = useAppStore((s) => s.closeRoutineSettings)
  const { data: routines } = useAllRoutines()
  const routine = useMemo(() => routines?.find((r) => r.id === routineId) ?? null, [routines, routineId])
  const { data: environment } = useEnvironment(routine?.environment_id ?? null)

  const updateRoutine = useUpdateRoutine()
  const deleteRoutine = useDeleteRoutine()
  const startRoutine = useStartRoutine()
  const stopRoutine = useStopRoutine()

  const [name, setName] = useState('')
  const [cronExpression, setCronExpression] = useState('')
  const [intervalSeconds, setIntervalSeconds] = useState(300)
  const [agentType, setAgentType] = useState<RoutineAgentType>('claude')
  const [prompt, setPrompt] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [allowedUserIds, setAllowedUserIds] = useState<number[] | null>(null)
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)

  useEffect(() => {
    if (routine) {
      setName(routine.name)
      setCronExpression(routine.cron_expression ?? '')
      setIntervalSeconds(routine.interval_seconds ?? 300)
      setAgentType(routine.agent_type)
      setPrompt(routine.prompt)
      setEnabled(!!routine.enabled)
      setAllowedUserIds(routine.allowed_user_ids ?? null)
    }
  }, [routine])

  const isManual = routine?.interval_seconds == null

  const flashSaved = (key: string): void => {
    setSavedKey(key)
    window.setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 1800)
  }

  const saveField = (data: Partial<Routine>, key: string): void => {
    if (!routine) return
    updateRoutine.mutate({ id: routineId, data }, { onSuccess: () => flashSaved(key) })
  }

  if (!routine) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Loading routine…
      </div>
    )
  }

  const createdLabel = routine.created_at ? new Date(routine.created_at).toLocaleString() : routine.created_at
  const lastRunLabel = routine.last_run_at ? new Date(routine.last_run_at).toLocaleString() : '—'
  const isRunning = !!routine.tmux_session_name
  const cronHuman = (() => {
    try {
      const parsed = parseCronToInterval(cronExpression)
      return parsed ? intervalToPresetLabel(parsed.intervalSeconds) : null
    } catch { return null }
  })()

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400 truncate">
          {environment?.name ?? 'Environment'} <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200 truncate">{routine.name}</span>{' '}
          <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">Settings</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          {isRunning ? (
            <span className="inline-flex items-center gap-1.5 px-2 h-7 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[12px]">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Running
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2 h-7 rounded-md bg-neutral-900 border border-neutral-800 text-neutral-500 text-[12px]">
              <span className="w-1.5 h-1.5 rounded-full bg-neutral-600" /> Stopped
            </span>
          )}
          <button
            type="button"
            onClick={() => isRunning ? stopRoutine.mutate(routineId) : startRoutine.mutate(routineId)}
            className="h-7 px-3 rounded-md text-[12px] font-medium border border-neutral-700 hover:bg-neutral-800 text-neutral-200 transition-colors"
          >
            {isRunning ? 'Stop' : 'Start'}
          </button>
          <button
            type="button"
            onClick={closeRoutineSettings}
            aria-label="Close settings"
            title="Close"
            className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            <Close size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">Routine Settings</h2>
            <p className="text-[14px] text-neutral-400">
              A routine is a cron-scheduled agent run. It spawns the chosen agent on this environment with your prompt at the interval you set.
            </p>
          </div>

          <div className="border-t border-neutral-800">
            <Section title="Name" description="Shown in the sidebar.">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TextInput value={name} onChange={setName} placeholder="e.g. Nightly dependency audit" />
                  <PrimaryButton
                    onClick={() => saveField({ name: name.trim() }, 'name')}
                    disabled={updateRoutine.isPending || !name.trim() || name.trim() === routine.name}
                  >
                    Save
                  </PrimaryButton>
                </div>
                {savedKey === 'name' && <span className="text-[11px] text-emerald-400">Saved</span>}
              </div>
            </Section>

            <Section
              title="Schedule"
              description="How often the routine runs. Leave empty / click Manual to make it run only when you press Start. Supported schedule formats: '@every Ns/Nm/Nh/Nd' (e.g. '@every 5m') or simple cron like '*/5 * * * *'."
            >
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <TextInput
                    value={cronExpression}
                    onChange={setCronExpression}
                    placeholder="@every 5m  (leave empty for manual start only)"
                    className="font-mono"
                  />
                  <PrimaryButton
                    onClick={() => {
                      const trimmed = cronExpression.trim()
                      if (!trimmed) {
                        // Empty → manual-only: null both columns.
                        saveField({ cron_expression: null, interval_seconds: null }, 'schedule')
                        return
                      }
                      const parsed = parseCronToInterval(trimmed)
                      if (!parsed) { alert('Invalid schedule. Try "@every 5m" or "*/5 * * * *", or empty for manual-only.'); return }
                      saveField({ cron_expression: parsed.normalized, interval_seconds: parsed.intervalSeconds }, 'schedule')
                      setIntervalSeconds(parsed.intervalSeconds)
                    }}
                    disabled={updateRoutine.isPending || cronExpression.trim() === (routine.cron_expression ?? '')}
                  >
                    Save
                  </PrimaryButton>
                </div>
                <p className="text-[12px] text-neutral-500">
                  {!cronExpression.trim()
                    ? isManual
                      ? 'Manual-only: press Start in the sidebar to run once.'
                      : 'Leave empty to switch this routine to manual-only (no automatic ticks).'
                    : cronHuman
                      ? `Runs every ${cronHuman}. Effective sleep between runs: `
                      : 'Unrecognized schedule — stick to the supported formats above.'}
                  {cronExpression.trim() && cronHuman && (
                    <code className="text-neutral-300">{intervalSeconds}s</code>
                  )}
                  {cronExpression.trim() && cronHuman ? '.' : ''}
                </p>
                {savedKey === 'schedule' && <span className="text-[11px] text-emerald-400">Saved</span>}
              </div>
            </Section>

            <Section title="Agent" description="Which AI CLI to run on schedule.">
              <div className="flex items-center gap-2">
                <select
                  value={agentType}
                  onChange={(e) => setAgentType(e.target.value as RoutineAgentType)}
                  className="h-10 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500"
                >
                  <option value="claude">Claude</option>
                  <option value="gemini">Gemini</option>
                  <option value="codex">Codex</option>
                </select>
                <PrimaryButton
                  onClick={() => saveField({ agent_type: agentType }, 'agent')}
                  disabled={updateRoutine.isPending || agentType === routine.agent_type}
                >
                  Save
                </PrimaryButton>
                {savedKey === 'agent' && <span className="text-[11px] text-emerald-400">Saved</span>}
              </div>
            </Section>

            <Section
              title="Prompt"
              description="Sent to the agent on every run. Keep it self-contained and idempotent — the agent starts fresh each time."
            >
              <div className="space-y-2">
                <TextArea value={prompt} onChange={setPrompt} rows={6} placeholder="e.g. Review the latest commits on main, list any TODO/FIXME added, and write a short report to /tmp/report.md" />
                <div className="flex items-center gap-2">
                  <PrimaryButton
                    onClick={() => saveField({ prompt }, 'prompt')}
                    disabled={updateRoutine.isPending || !prompt.trim() || prompt === routine.prompt}
                  >
                    Save prompt
                  </PrimaryButton>
                  {savedKey === 'prompt' && <span className="text-[11px] text-emerald-400">Saved</span>}
                </div>
              </div>
            </Section>

            <Section title="Enabled" description="Uncheck to keep the routine's config but pause the schedule.">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => {
                    setEnabled(e.target.checked)
                    saveField({ enabled: e.target.checked ? 1 : 0 }, 'enabled')
                  }}
                  className="accent-[var(--accent)]"
                />
                <span className="text-[13px] text-neutral-200">{enabled ? 'Enabled' : 'Disabled'}</span>
                {savedKey === 'enabled' && <span className="text-[11px] text-emerald-400 ml-2">Saved</span>}
              </label>
            </Section>

            {isManual && (
              <Section
                title="Delegation"
                description="Pick team members who can Start this routine even if their role wouldn't normally let them. Leave empty to fall back to role-based access."
              >
                <div className="space-y-3">
                  <RoutineAllowlistPicker
                    value={allowedUserIds}
                    onChange={(next) => {
                      setAllowedUserIds(next)
                      saveField({ allowed_user_ids: next }, 'delegation')
                    }}
                  />
                  {savedKey === 'delegation' && <span className="text-[11px] text-emerald-400">Saved</span>}
                </div>
              </Section>
            )}

            <Section title="Routine Info" description="Read-only metadata.">
              <dl className="space-y-3 text-[13px]">
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Routine ID</dt>
                  <dd className="flex-1 flex items-center gap-2 min-w-0">
                    <code className="font-mono text-[12px] text-neutral-300 truncate">{routine.id}</code>
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(routine.id).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1200) }) }}
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
                  <dt className="w-32 text-neutral-500 shrink-0">Last run</dt>
                  <dd className="text-neutral-300">{lastRunLabel}</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Last exit code</dt>
                  <dd className="text-neutral-300 font-mono">{routine.last_exit_code ?? '—'}</dd>
                </div>
                <div className="flex items-start gap-3">
                  <dt className="w-32 text-neutral-500 shrink-0">Tmux session</dt>
                  <dd className="text-neutral-300 font-mono">{routine.tmux_session_name || '—'}</dd>
                </div>
              </dl>
            </Section>

            <div className="py-8">
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-4">
                <h3 className="text-[14px] font-semibold text-red-300 mb-1">Delete Routine</h3>
                <p className="text-[13px] text-red-400/80 mb-4">
                  Stops the routine (if running) and removes it permanently.
                </p>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-red-600/90 hover:bg-red-600 text-white transition-colors"
                >
                  <TrashCan size={14} />
                  Delete Routine
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={() => setShowDeleteConfirm(false)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[420px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-neutral-50 mb-2">Delete "{routine.name}"?</div>
            <p className="text-[13px] text-neutral-400 mb-4">This cannot be undone. The routine will stop if running.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowDeleteConfirm(false)} className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800">Cancel</button>
              <button
                onClick={() => { setShowDeleteConfirm(false); deleteRoutine.mutate(routineId, { onSuccess: () => closeRoutineSettings() }) }}
                className="h-8 px-4 rounded-lg text-[13px] text-white bg-red-600 hover:bg-red-500"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
