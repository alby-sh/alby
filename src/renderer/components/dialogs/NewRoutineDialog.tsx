import { useMemo, useState } from 'react'
import { useCreateRoutine } from '../../hooks/useRoutines'
import { parseCronToInterval } from '../../../shared/cron-parser'
import type { RoutineAgentType } from '../../../shared/types'
import { useEnvironment } from '../../hooks/useProjects'
import { RoutineAllowlistPicker } from '../ui/RoutineAllowlistPicker'

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
  const [mode, setMode] = useState<'preset' | 'custom' | 'manual'>('preset')
  const [presetCron, setPresetCron] = useState(PRESETS[0].cron)
  const [customCron, setCustomCron] = useState('*/5 * * * *')
  const [prompt, setPrompt] = useState('')
  const [allowedUserIds, setAllowedUserIds] = useState<number[] | null>(null)
  const createRoutine = useCreateRoutine()

  const currentCron = mode === 'preset' ? presetCron : mode === 'custom' ? customCron.trim() : ''
  const parsed = useMemo(() => mode === 'manual' ? null : parseCronToInterval(currentCron), [currentCron, mode])
  const validationError = mode !== 'manual' && !parsed && mode === 'custom' && customCron.trim().length > 0
    ? 'Unsupported cron. Only interval patterns: */N * * * *, 0 */N * * *, 0 * * * *.'
    : null

  const availableAgents = useMemo(() => {
    if (!environment?.agent_settings) return AGENT_OPTIONS
    return AGENT_OPTIONS.filter((a) => environment.agent_settings?.[a.value]?.enabled !== false)
  }, [environment])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !prompt.trim()) return
    if (mode !== 'manual' && !parsed) return
    createRoutine.mutate(
      {
        environment_id: environmentId,
        name: name.trim(),
        cron_expression: mode === 'manual' ? null : parsed!.normalized,
        interval_seconds: mode === 'manual' ? null : parsed!.intervalSeconds,
        agent_type: agentType,
        prompt: prompt.trim(),
        // Only persist the allow-list for manual routines — for scheduled
        // runs the system triggers them autonomously and delegation has no
        // meaning.
        allowed_user_ids: mode === 'manual' ? allowedUserIds : null,
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
            <label className="block text-sm text-[var(--text-secondary)] mb-1.5">Schedule</label>
            <div className="flex gap-1 mb-2 text-xs">
              {(['preset', 'custom', 'manual'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-2.5 h-7 rounded border transition-colors ${
                    mode === m
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                      : 'border-[var(--border-color)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {m === 'preset' ? 'Preset' : m === 'custom' ? 'Custom cron' : 'Manual start only'}
                </button>
              ))}
            </div>
            {mode === 'preset' && (
              <select
                value={presetCron}
                onChange={(e) => setPresetCron(e.target.value)}
                className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                {PRESETS.map((p) => (
                  <option key={p.cron} value={p.cron}>{p.label} ({p.cron})</option>
                ))}
              </select>
            )}
            {mode === 'custom' && (
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
            {mode === 'manual' && (
              <p className="text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2">
                No automatic schedule. The routine runs once each time you
                click <span className="text-[var(--text-primary)]">Start</span> on
                the sidebar row, then exits.
              </p>
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

          {mode === 'manual' && (
            <div className="mb-4">
              <label className="block text-sm text-[var(--text-secondary)] mb-1">Delegate Start to (optional)</label>
              <RoutineAllowlistPicker value={allowedUserIds} onChange={setAllowedUserIds} />
            </div>
          )}

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
              disabled={!name.trim() || !prompt.trim() || (mode !== 'manual' && !parsed) || createRoutine.isPending}
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
