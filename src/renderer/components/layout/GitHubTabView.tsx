import { useCallback, useEffect, useState } from 'react'
import {
  LogoGithub,
  Launch,
  Renew,
  CheckmarkFilled,
  WarningAltFilled,
  Time as TimeIcon,
} from '@carbon/icons-react'
import type { Environment } from '../../../shared/types'

/** Shape of `git:log` IPC payload. Re-declared here so the renderer doesn't
 *  import from main — electron-vite's type path enforcement. */
interface GitCommit {
  hash: string
  short: string
  author: string
  email: string
  date: string
  subject: string
}
interface GitFileChange { path: string; status: string }
interface GhPullRequest {
  number: number
  title: string
  url: string
  state: string
  author: string
  createdAt: string
  headRefName: string
  isDraft: boolean
}
interface GhWorkflowRun {
  databaseId: number
  name: string
  displayTitle: string
  status: string
  conclusion: string | null
  headBranch: string
  createdAt: string
  url: string
}

interface GitStatusData {
  modified: number
  staged: number
  ahead: number
  behind: number
  hasRepo: boolean
}

type SubTab = 'commits' | 'prs' | 'actions'

/** Per-env GitHub tab. Three panes:
 *   - Commits: git log + the modified files list + a commit-push form.
 *   - PRs: `gh pr list --json` rendered as a table (requires gh auth on the env).
 *   - Actions: `gh run list --json` for workflow runs.
 *  Local envs + envs where gh CLI isn't installed/authenticated will simply show
 *  empty lists; the commit/pull/push controls stay functional as long as there's
 *  a git repo in the env's remote_path. */
export function GitHubTabView({ env }: { env: Environment }) {
  const envId = env.id
  const [status, setStatus] = useState<GitStatusData | null>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [files, setFiles] = useState<GitFileChange[]>([])
  const [prs, setPrs] = useState<GhPullRequest[]>([])
  const [runs, setRuns] = useState<GhWorkflowRun[]>([])
  const [tab, setTab] = useState<SubTab>('commits')
  const [remoteUrl, setRemoteUrl] = useState<string | null>(env.git_remote_url || null)

  const [commitMsg, setCommitMsg] = useState('')
  const [actionRunning, setActionRunning] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [ghAuth, setGhAuth] = useState<{ authenticated: boolean; username?: string; ghInstalled: boolean } | null>(null)

  const loadAll = useCallback(async (): Promise<void> => {
    // Parallel fetch — each call is tolerant to SSH hiccups (returns empty).
    const [st, cm, fs, pr, rn, auth] = await Promise.all([
      window.electronAPI.git.status(envId) as Promise<GitStatusData>,
      window.electronAPI.git.log(envId, 25) as Promise<GitCommit[]>,
      window.electronAPI.git.changedFiles(envId) as Promise<GitFileChange[]>,
      window.electronAPI.git.prList(envId, 20) as Promise<GhPullRequest[]>,
      window.electronAPI.git.runList(envId, 20) as Promise<GhWorkflowRun[]>,
      window.electronAPI.git.checkGitHubAuth(envId) as Promise<{ authenticated: boolean; username?: string; ghInstalled: boolean }>,
    ])
    setStatus(st)
    setCommits(cm)
    setFiles(fs)
    setPrs(pr)
    setRuns(rn)
    setGhAuth(auth)
    if (!remoteUrl) {
      try {
        const url = (await window.electronAPI.git.remoteUrl(envId)) as string | null
        if (url) setRemoteUrl(url)
      } catch { /* ignore */ }
    }
  }, [envId, remoteUrl])

  useEffect(() => {
    void loadAll()
    const interval = setInterval(() => { void loadAll() }, 30_000)
    return () => clearInterval(interval)
  }, [loadAll])

  const run = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    setActionRunning(label)
    setActionError(null)
    try { await fn() } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
    setActionRunning(null)
    await loadAll()
  }

  const handleCommitPush = (): Promise<void> =>
    run('commit-push', () => window.electronAPI.git.commitPush(envId, commitMsg.trim() || 'Update')).then(() => setCommitMsg(''))
  const handleFetch = (): Promise<void> => run('fetch', () => window.electronAPI.git.fetch(envId))
  const handlePull = (): Promise<void> => run('pull', () => window.electronAPI.git.pull(envId))
  const handleDiscard = (): Promise<void> => {
    if (!confirm('Discard ALL local changes? This cannot be undone.')) return Promise.resolve()
    return run('discard', () => window.electronAPI.git.discard(envId))
  }

  const canInteract = !!status?.hasRepo
  const repoHost = remoteUrl ? prettyRepoUrl(remoteUrl) : null

  return (
    <div className="h-full overflow-y-auto px-6 py-5 space-y-5">
      {/* Header summary */}
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-neutral-500">
            <LogoGithub size={14} />
            GitHub
            {ghAuth?.authenticated && (
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                gh {ghAuth.username ? `· ${ghAuth.username}` : 'authenticated'}
              </span>
            )}
            {ghAuth && !ghAuth.authenticated && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-300 bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 rounded">
                <WarningAltFilled size={10} /> gh not signed in
              </span>
            )}
          </div>
          <div className="mt-1 flex items-baseline gap-3 flex-wrap">
            <div className="text-[18px] font-semibold text-neutral-50 truncate">
              {repoHost ?? 'No git remote'}
            </div>
            {remoteUrl && (
              <a
                href={repoToWebUrl(remoteUrl)}
                onClick={(e) => { e.preventDefault(); if (repoToWebUrl(remoteUrl)) window.open(repoToWebUrl(remoteUrl)!, '_blank') }}
                className="text-[12px] text-blue-300 hover:text-blue-200 inline-flex items-center gap-1"
              >
                Open on GitHub <Launch size={10} />
              </a>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3 text-[12px] text-neutral-400">
            {status?.modified ? (
              <span className="text-amber-300">{status.modified} modified</span>
            ) : <span>Working tree clean</span>}
            {status?.ahead ? <span className="text-blue-300">{status.ahead} to push</span> : null}
            {status?.behind ? <span className="text-purple-300">{status.behind} to pull</span> : null}
          </div>
        </div>
        <button
          type="button"
          onClick={() => { void loadAll() }}
          className="h-8 px-3 rounded-md border border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900 text-[12px] text-neutral-200 inline-flex items-center gap-1.5"
        >
          <Renew size={12} /> Refresh
        </button>
      </div>

      {actionError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 px-3 py-2 text-[12px] text-red-200">
          {actionError}
        </div>
      )}

      {/* Commit form */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={status?.modified ? `Commit message (${status.modified} file${status.modified === 1 ? '' : 's'})` : 'Commit message'}
            disabled={!canInteract || !!actionRunning}
            className="flex-1 h-9 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-600 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => { void handleCommitPush() }}
            disabled={!canInteract || !status?.modified || actionRunning === 'commit-push'}
            className="h-9 px-4 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:pointer-events-none text-[13px] text-white font-medium"
          >
            {actionRunning === 'commit-push' ? 'Committing…' : 'Commit & push'}
          </button>
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          <button
            type="button"
            onClick={() => { void handleFetch() }}
            disabled={!canInteract || actionRunning === 'fetch'}
            className="h-8 px-3 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:opacity-40 text-neutral-200"
          >
            {actionRunning === 'fetch' ? 'Fetching…' : 'Fetch'}
          </button>
          <button
            type="button"
            onClick={() => { void handlePull() }}
            disabled={!canInteract || !status?.behind || actionRunning === 'pull'}
            className="h-8 px-3 rounded-md border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:opacity-40 text-neutral-200"
          >
            {actionRunning === 'pull' ? 'Pulling…' : `Pull${status?.behind ? ` (${status.behind})` : ''}`}
          </button>
          <button
            type="button"
            onClick={() => { void handleDiscard() }}
            disabled={!canInteract || !status?.modified || actionRunning === 'discard'}
            className="h-8 px-3 rounded-md border border-red-500/30 bg-red-500/5 hover:bg-red-500/10 disabled:opacity-40 text-red-300"
          >
            {actionRunning === 'discard' ? 'Discarding…' : 'Discard changes'}
          </button>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="flex items-center gap-1 border-b border-neutral-800">
        {([
          { key: 'commits', label: `Commits (${commits.length})` },
          { key: 'prs', label: `Pull requests (${prs.length})` },
          { key: 'actions', label: `Actions (${runs.length})` },
        ] as { key: SubTab; label: string }[]).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`h-8 px-3 text-[12px] rounded-t-md transition-colors ${
              tab === t.key
                ? 'bg-neutral-900/60 text-neutral-50 border-b-2 border-blue-500'
                : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900/40 border-b-2 border-transparent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'commits' && (
        <div className="space-y-4">
          {files.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">
                Modified files
              </div>
              <div className="rounded-md border border-neutral-800 divide-y divide-neutral-900 bg-neutral-950/40">
                {files.map((f) => (
                  <div key={f.path} className="flex items-center gap-3 px-3 h-7 text-[12px]">
                    <span
                      className={`font-mono text-[11px] w-8 shrink-0 tabular-nums ${
                        f.status.includes('??') ? 'text-blue-300' : f.status.trim() === 'M' ? 'text-amber-300' : 'text-neutral-400'
                      }`}
                    >
                      {f.status.trim() || '??'}
                    </span>
                    <span className="text-neutral-200 font-mono truncate">{f.path}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Recent commits</div>
            {commits.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-[13px] text-neutral-500">
                {canInteract ? 'No commits yet.' : 'Git repository not detected in this environment.'}
              </div>
            ) : (
              <div className="rounded-md border border-neutral-800 divide-y divide-neutral-900 bg-neutral-950/40">
                {commits.map((c) => (
                  <div key={c.hash} className="flex items-center gap-3 px-3 py-2 text-[12px]">
                    <span className="font-mono text-[11px] text-neutral-500 shrink-0 w-12">{c.short}</span>
                    <span className="flex-1 min-w-0 text-neutral-100 truncate">{c.subject}</span>
                    <span className="text-neutral-500 shrink-0">{c.author}</span>
                    <span className="text-neutral-600 shrink-0 tabular-nums text-[10px]">
                      {formatShortDate(c.date)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'prs' && (
        <>
          {ghAuth && !ghAuth.authenticated && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-200">
              GitHub CLI is not authenticated on this env. Pull requests can't be listed — authenticate via the env's git menu or the Deploy tab.
            </div>
          )}
          {prs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-[13px] text-neutral-500">
              {ghAuth?.authenticated ? 'No open pull requests.' : 'Authenticate gh CLI to list pull requests.'}
            </div>
          ) : (
            <div className="rounded-md border border-neutral-800 divide-y divide-neutral-900 bg-neutral-950/40">
              {prs.map((pr) => (
                <a
                  key={pr.number}
                  href={pr.url}
                  onClick={(e) => { e.preventDefault(); window.open(pr.url, '_blank') }}
                  className="flex items-center gap-3 px-3 py-2 text-[12px] hover:bg-neutral-900/60 cursor-pointer"
                >
                  <span className="font-mono text-[11px] text-neutral-500 w-12 shrink-0">#{pr.number}</span>
                  <span className="flex-1 min-w-0 text-neutral-100 truncate">{pr.title}</span>
                  {pr.isDraft && <span className="text-[10px] uppercase tracking-wider text-neutral-500 shrink-0">draft</span>}
                  <span className="text-neutral-500 shrink-0">{pr.author}</span>
                  <span className="text-neutral-600 shrink-0 tabular-nums text-[10px]">
                    {formatShortDate(pr.createdAt)}
                  </span>
                </a>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'actions' && (
        <>
          {runs.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 px-4 py-6 text-center text-[13px] text-neutral-500">
              {ghAuth?.authenticated ? 'No workflow runs yet.' : 'Authenticate gh CLI to list workflow runs.'}
            </div>
          ) : (
            <div className="rounded-md border border-neutral-800 divide-y divide-neutral-900 bg-neutral-950/40">
              {runs.map((r) => (
                <a
                  key={r.databaseId}
                  href={r.url}
                  onClick={(e) => { e.preventDefault(); window.open(r.url, '_blank') }}
                  className="flex items-center gap-3 px-3 py-2 text-[12px] hover:bg-neutral-900/60 cursor-pointer"
                >
                  <RunStatusIcon status={r.status} conclusion={r.conclusion} />
                  <span className="flex-1 min-w-0">
                    <div className="text-neutral-100 truncate">{r.displayTitle || r.name}</div>
                    <div className="text-[11px] text-neutral-500 truncate">
                      {r.name} · {r.headBranch}
                    </div>
                  </span>
                  <span className="text-neutral-600 shrink-0 tabular-nums text-[10px] inline-flex items-center gap-1">
                    <TimeIcon size={10} /> {formatShortDate(r.createdAt)}
                  </span>
                </a>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function RunStatusIcon({ status, conclusion }: { status: string; conclusion: string | null }) {
  // Non-terminal runs get a spinning indicator; terminal runs get green /
  // red / grey depending on conclusion.
  if (status !== 'completed') {
    return (
      <svg viewBox="0 0 24 24" className="w-4 h-4 animate-spin shrink-0" fill="none">
        <circle cx="12" cy="12" r="10" stroke="#60a5fa" strokeWidth="2" opacity="0.25" />
        <path d="M12 2a10 10 0 0 1 10 10" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
      </svg>
    )
  }
  if (conclusion === 'success') return <CheckmarkFilled size={14} className="text-emerald-400 shrink-0" />
  if (conclusion === 'failure' || conclusion === 'cancelled') return <WarningAltFilled size={14} className="text-red-400 shrink-0" />
  return <span className="w-4 h-4 rounded-full bg-neutral-700 shrink-0" />
}

function formatShortDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d`
  return d.toLocaleDateString()
}

/** Strip scheme + .git suffix to show a human-readable "owner/repo" label. */
function prettyRepoUrl(url: string): string {
  let s = url.trim().replace(/\.git$/i, '')
  s = s.replace(/^git@github\.com:/, 'github.com/')
  s = s.replace(/^https?:\/\//, '')
  return s
}

/** Convert git remote URL (ssh or https) to the browsable web URL. */
function repoToWebUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/i, '')
  if (trimmed.startsWith('http')) return trimmed
  const match = trimmed.match(/^git@([^:]+):(.+)$/)
  if (match) return `https://${match[1]}/${match[2]}`
  return null
}
