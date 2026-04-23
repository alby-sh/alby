import { useState } from 'react'
import { useCreateIssue } from '../../hooks/useIssues'
import type { IssueLevel, ReportingApp } from '../../../shared/types'

interface Props {
  /** Apps the user is allowed to report against. If the list has one
   *  entry the picker collapses into a static label, otherwise the user
   *  chooses which app the issue lands against. */
  apps: ReportingApp[]
  /** Pre-selected app id. Pass the one the user was viewing when they
   *  clicked "Report issue" so the dialog feels contextual. */
  initialAppId?: string | null
  onClose: () => void
  /** Called with the newly-created Issue on success. Parent usually
   *  navigates to it or closes the dialog with a toast. */
  onCreated?: (issueId: string) => void
}

const LEVELS: Array<{ value: IssueLevel; label: string; hint: string; color: string }> = [
  { value: 'info',    label: 'Info',    hint: 'FYI, nothing broken', color: 'text-sky-300' },
  { value: 'warning', label: 'Warning', hint: 'Broken but not urgent', color: 'text-amber-300' },
  { value: 'error',   label: 'Error',   hint: 'Broken for this user', color: 'text-red-300' },
  { value: 'fatal',   label: 'Fatal',   hint: 'Production down', color: 'text-red-400' },
]

/**
 * The "Report issue" form. Shared between the regular IssuesListView
 * header button (anyone with canReportIssue) and IssuerShell (the
 * minimal UI for users whose ONLY permission is this form).
 *
 * Intentionally small — title + optional description + level + app.
 * More fields would turn this into a bug-tracker and make it intimidating
 * for non-dev reporters; the rich context belongs in the description
 * text, which supports multiline input.
 */
export function ReportIssueDialog({ apps, initialAppId, onClose, onCreated }: Props) {
  const [appId, setAppId] = useState<string>(initialAppId || apps[0]?.id || '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [level, setLevel] = useState<IssueLevel>('error')
  const createIssue = useCreateIssue(appId)

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!title.trim() || !appId) return
    createIssue.mutate(
      {
        title: title.trim(),
        description: description.trim() ? description.trim() : null,
        level,
      },
      {
        onSuccess: (issue) => {
          onCreated?.(issue.id)
          onClose()
        },
      },
    )
  }

  const errorMsg = createIssue.error instanceof Error ? createIssue.error.message : null
  const disabled = !title.trim() || !appId || createIssue.isPending

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg p-6 w-[520px] max-w-[94vw] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-medium mb-1">Report an issue</h2>
        <p className="text-[12px] text-neutral-500 mb-5">
          A manual report. Your name is attached so the team knows who to ask if they need more context.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* App picker — only shown when there's more than one available.
              One-app workspaces get a subtle label so the reporter knows
              where their issue lands without having to pick. */}
          {apps.length > 1 ? (
            <div>
              <label className="block text-xs text-neutral-400 mb-1">App</label>
              <select
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[var(--accent)]"
              >
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          ) : apps[0] ? (
            <div className="text-[11px] text-neutral-500">
              Filing against <span className="text-neutral-300">{apps[0].name}</span>
            </div>
          ) : (
            <div className="text-[12px] text-amber-300">
              No apps available — ask an admin to add you to one.
            </div>
          )}

          <div>
            <label className="block text-xs text-neutral-400 mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Login button spins forever after adding a credit card"
              autoFocus
              maxLength={255}
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm focus:outline-none focus:border-[var(--accent)]"
            />
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">
              Description <span className="text-neutral-600">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Steps to reproduce, expected vs actual, any URL or IDs the team might need."
              rows={5}
              maxLength={10000}
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2 text-sm font-mono focus:outline-none focus:border-[var(--accent)] resize-none"
            />
          </div>

          <div>
            <label className="block text-xs text-neutral-400 mb-1">Severity</label>
            <div className="grid grid-cols-4 gap-2">
              {LEVELS.map((lvl) => (
                <button
                  key={lvl.value}
                  type="button"
                  onClick={() => setLevel(lvl.value)}
                  title={lvl.hint}
                  className={`px-2 py-1.5 rounded border text-xs font-medium transition-colors ${
                    level === lvl.value
                      ? `${lvl.color} bg-neutral-800 border-neutral-600`
                      : 'text-neutral-400 border-neutral-800 hover:border-neutral-700'
                  }`}
                >
                  {lvl.label}
                </button>
              ))}
            </div>
          </div>

          {errorMsg && (
            <div className="text-xs text-red-300 bg-red-900/30 border border-red-700/40 rounded px-3 py-2">
              {errorMsg.includes('404') || errorMsg.toLowerCase().includes('not found')
                ? 'Your Alby server does not have manual-issue support yet. Ask an admin to deploy the v0.8.0 backend patch.'
                : errorMsg}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={disabled}
              className="px-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-50 rounded text-sm font-medium"
            >
              {createIssue.isPending ? 'Submitting…' : 'Submit report'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
