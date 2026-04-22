import { execFile } from 'child_process'
import { promisify } from 'util'
import type {
  GitCommit,
  GitFileChange,
  GitHubAuthStatus,
  GhPullRequest,
  GhWorkflowRun,
} from './git-status'
import type { GitStatus } from './git-status'

const run = promisify(execFile)

/** Run git in the given cwd. Throws on non-zero exit. Output limited to 1MB
 *  so a runaway repo never blows up main memory. */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 1024 * 1024 })
  return stdout
}
async function gitSoft(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args)
  } catch {
    return ''
  }
}

export async function getGitStatusLocal(cwd: string): Promise<GitStatus> {
  const empty: GitStatus = { modified: 0, staged: 0, ahead: 0, behind: 0, hasRepo: false }
  const isRepo = (await gitSoft(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
  if (isRepo !== 'true') return empty

  const porcelain = await gitSoft(cwd, ['status', '--porcelain=v1', '-z'])
  const records = porcelain.split('\0').filter((r) => r.length > 0)
  let modified = 0
  let staged = 0
  for (const rec of records) {
    const xy = rec.slice(0, 2)
    if (xy[0] !== ' ' && xy[0] !== '?') staged++
    if (xy[1] !== ' ' || xy === '??') modified++
  }
  modified = records.length // total changed-file count (UX parity with SSH helper)

  // Ahead / behind vs the upstream of the current branch. Silently 0 when
  // no upstream is configured (fresh branch, detached HEAD, etc.).
  let ahead = 0
  let behind = 0
  const counts = (await gitSoft(cwd, ['rev-list', '--count', '--left-right', '@{u}...HEAD'])).trim()
  if (counts) {
    const [b, a] = counts.split(/\s+/).map((n) => parseInt(n, 10))
    behind = isNaN(b) ? 0 : b
    ahead = isNaN(a) ? 0 : a
  }
  return { modified, staged, ahead, behind, hasRepo: true }
}

export async function gitLogLocal(cwd: string, limit: number = 20): Promise<GitCommit[]> {
  try {
    const fmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x00'
    const out = await git(cwd, [
      'log',
      `-n`, String(Math.max(1, Math.min(200, limit))),
      '--date=iso-strict',
      `--pretty=format:${fmt}`,
    ])
    const records = out.split('\0').filter((r) => r.trim().length > 0)
    return records.map((r) => {
      const [hash, short, author, email, date, subject] = r.split('\x1f')
      return {
        hash: hash ?? '',
        short: short ?? '',
        author: author ?? '',
        email: email ?? '',
        date: date ?? '',
        subject: subject ?? '',
      }
    })
  } catch {
    return []
  }
}

export async function gitChangedFilesLocal(cwd: string): Promise<GitFileChange[]> {
  const out = await gitSoft(cwd, ['status', '--porcelain=v1', '-z'])
  const records = out.split('\0').filter((r) => r.length > 0)
  const out2: GitFileChange[] = []
  for (const rec of records) {
    const status = rec.slice(0, 2)
    const path = rec.slice(3)
    if (path) out2.push({ status, path })
  }
  return out2
}

export async function gitRemoteUrlLocal(cwd: string): Promise<string | null> {
  const url = (await gitSoft(cwd, ['config', '--get', 'remote.origin.url'])).trim()
  return url || null
}

export async function gitCommitPushLocal(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A'])
  await git(cwd, ['commit', '-m', message])
  return await git(cwd, ['push'])
}
export async function gitPushLocal(cwd: string): Promise<string> {
  return await git(cwd, ['push'])
}
export async function gitFetchLocal(cwd: string): Promise<string> {
  return await git(cwd, ['fetch', '--all', '--prune'])
}
export async function gitPullLocal(cwd: string): Promise<string> {
  return await git(cwd, ['pull'])
}
export async function gitDiscardChangesLocal(cwd: string): Promise<string> {
  await git(cwd, ['reset', '--hard', 'HEAD'])
  return await git(cwd, ['clean', '-fd'])
}
export async function gitDiffSummaryLocal(cwd: string): Promise<string> {
  return await gitSoft(cwd, ['diff', '--stat'])
}

/** Wraps a local `gh` command. Returns empty list on any failure (missing
 *  gh, no auth, etc.) — same fail-soft semantics as the SSH variants. */
async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('gh', args, { cwd, maxBuffer: 1024 * 1024 })
    return stdout
  } catch {
    return ''
  }
}

/** `gh auth status` writes to stderr (even on success). execFile's default
 *  behaviour throws when stderr is non-empty on non-zero exit, but success
 *  still populates err.stdout / err.stderr. We read both and don't treat
 *  non-zero exit as fatal — `gh auth status` returns 1 when not logged in
 *  and we want to surface that as `authenticated: false` rather than throw. */
async function ghBoth(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run('gh', args, { cwd, maxBuffer: 1024 * 1024 })
    return (stdout || '') + (stderr || '')
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return (e.stdout || '') + (e.stderr || '')
  }
}

export async function checkGitHubAuthLocal(): Promise<GitHubAuthStatus> {
  try {
    // gh --version works whether or not auth is set up; missing binary throws.
    await run('gh', ['--version'], { maxBuffer: 64 * 1024 })
  } catch {
    return { authenticated: false, ghInstalled: false }
  }
  const status = await ghBoth('.', ['auth', 'status'])
  const authenticated = /Logged in to github\.com/.test(status)
  // Match both older "Logged in to github.com as USERNAME" and newer
  // "Logged in to github.com account USERNAME" output formats.
  const m = status.match(/Logged in to github\.com(?: account| as)? ([A-Za-z0-9-]+)/)
  return { authenticated, username: m?.[1], ghInstalled: true }
}

export async function ghPullRequestsLocal(cwd: string, limit = 20): Promise<GhPullRequest[]> {
  const out = await gh(cwd, [
    'pr', 'list',
    '--limit', String(Math.max(1, Math.min(50, limit))),
    '--json', 'number,title,url,state,author,createdAt,headRefName,isDraft',
  ])
  const t = out.trim()
  if (!t.startsWith('[')) return []
  try {
    const parsed = JSON.parse(t) as Array<{
      number: number; title: string; url: string; state: string
      author?: { login?: string }; createdAt: string; headRefName: string; isDraft: boolean
    }>
    return parsed.map((p) => ({
      number: p.number,
      title: p.title,
      url: p.url,
      state: p.state,
      author: p.author?.login ?? '',
      createdAt: p.createdAt,
      headRefName: p.headRefName,
      isDraft: p.isDraft,
    }))
  } catch { return [] }
}

export async function ghWorkflowRunsLocal(cwd: string, limit = 20): Promise<GhWorkflowRun[]> {
  const out = await gh(cwd, [
    'run', 'list',
    '--limit', String(Math.max(1, Math.min(50, limit))),
    '--json', 'databaseId,name,displayTitle,status,conclusion,headBranch,createdAt,url',
  ])
  const t = out.trim()
  if (!t.startsWith('[')) return []
  try { return JSON.parse(t) as GhWorkflowRun[] } catch { return [] }
}
