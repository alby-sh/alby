import { useMemo, useState } from 'react'
import { useCreateRoutine } from '../../hooks/useRoutines'
import { parseCronToInterval } from '../../../shared/cron-parser'
import type { RoutineAgentType } from '../../../shared/types'
import { useEnvironment } from '../../hooks/useProjects'

interface Props {
  environmentId: string
  onClose: () => void
}

interface Preset {
  label: string
  cron: string
}

const PRESETS: Preset[] = [
  { label: 'Every 5 min', cron: '*/5 * * * *' },
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Every 30 min', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Daily', cron: '0 0 * * *' },
]

const AGENT_OPTIONS: { value: RoutineAgentType; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'codex', label: 'Codex' },
]

export function NewRoutineDialog({ environmentId, onClose }: Props) {
  const { data: environment } = useEnvironment(environmentId)
  const [name, setName] = useState('')
  const [agentType, setAgentType] = useState<RoutineAgentType>('claude')
  const [mode, setMode] = useState<'preset' | 'custom'>('preset')
  const [presetCron, setPresetCron] = useState(PRESETS[0].cron)
  const [customCron, setCustomCron] = useState('*/5 * * * *')
  const [prompt, setPrompt] = useState('')
  const createRoutine = useCreateRoutine()

  const currentCron = mode === 'preset' ? presetCron : customCron.trim()
  const parsed = useMemo(() => parseCronToInterval(currentCron), [currentCron])
  const validationError = !parsed && mode === 'custom' && customCron.trim().length > 0
    ? 'Unsupported cron. Only interval patterns: */N * * * *, 0 */N * * *, 0 * * * *.'
    : null

  const availableAgents = useMemo(() => {
    if (!environment?.agent_settings) return AGENT_OPTIONS
    return AGENT_OPTIONS.filter((a) => environment.agent_settings?.[a.value]?.enabled !== false)
  }, [environment])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !prompt.trim() || !parsed) return
    createRoutine.mutate(
      {
        environment_id: environmentId,
        name: name.trim(),
        cron_expression: parsed.normalized,
        interval_seconds: parsed.intervalSeconds,
        agent_type: agentType,
        prompt: prompt.trim(),
      },
      { onSuccess: () => onClose() }
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-[520px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-4">New Routine</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm text-[var(--text-secondary)] mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Health check ogni 5 min"
              autoFocus
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div className="mb-4">
            <label className="block text-sm text-[var(--text-secondary)] mb-1">Agent</label>
            <div className="flex gap-2">
              {availableAgents.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setAgentType(opt.value)}
                  className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                    agentType === opt.value
                      ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
                      : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:border-neutral-500'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm text-[var(--text-secondary)]">Schedule</label>
              <button
                type="button"
                onClick={() => setMode(mode === 'preset' ? 'custom' : 'preset')}
                className="text-xs text-[var(--accent)] hover:underline"
              >
                {mode === 'preset' ? 'Use custom cron' : 'Use preset'}
              </button>
            </div>
            {mode === 'preset' ? (
              <select
                value={presetCron}
                onChange={(e) => setPresetCron(e.target.value)}
                className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                {PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>{p.label} ({p.cron})</option>
                ))}
              </select>
            ) : (
              <>
                <input
                  type="text"
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)]"
                />
                {validationError && (
                  <p className="text-xs text-red-400 mt-1">{validationError}</p>
                )}
              </>
            )}
            {parsed && (
              <p className="text-xs text-[var(--text-secondary)] mt-1">
                Will run every {parsed.intervalSeconds < 60
                  ? `${parsed.intervalSeconds}s`
                  : parsed.intervalSeconds < 3600
                    ? `${Math.round(parsed.intervalSeconds / 60)} min`
                    : `${Math.round(parsed.intervalSeconds / 3600)} h`}
              </p>
            )}
          </div>

          <div className="mb-6">
            <label className="block text-sm text-[var(--text-secondary)] mb-1">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Es. 'Verifica lo stato del sito e riporta eventuali anomalie'"
              rows={4}
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)] resize-none"
            />
            <p className="text-xs text-[var(--text-secondary)] mt-1">
              Sent to {agentType} as -p argument at each run.
            </p>
          </div>

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
              disabled={!name.trim() || !prompt.trim() || !parsed || createRoutine.isPending}
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
