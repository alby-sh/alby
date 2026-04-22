import type { Client } from 'ssh2'

export interface GitStatus {
  modified: number    // files with changes (staged + unstaged + untracked)
  staged: number      // files staged for commit
  ahead: number       // commits ahead of remote
  behind: number      // commits behind remote
  hasRepo: boolean    // is a git repo
}

function execSSH(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, channel) => {
      if (err) { reject(err); return }
      let out = ''
      channel.on('data', (d: Buffer) => { out += d.toString() })
      channel.stderr.on('data', (d: Buffer) => { out += d.toString() })
      channel.on('close', () => resolve(out))
    })
  })
}

export async function getGitStatus(client: Client, remotePath: string): Promise<GitStatus> {
  const empty: GitStatus = { modified: 0, staged: 0, ahead: 0, behind: 0, hasRepo: false }

  try {
    // Check if it's a git repo
    const isRepo = await execSSH(client, `cd "${remotePath}" && git rev-parse --is-inside-work-tree 2>/dev/null`)
    if (isRepo.trim() !== 'true') return empty

    // Get porcelain status (modified + untracked + staged)
    const porcelain = await execSSH(client, `cd "${remotePath}" && git status --porcelain 2>/dev/null`)
    const lines = porcelain.trim().split('\n').filter((l) => l.length > 0)

    let modified = 0
    let staged = 0
    for (const line of lines) {
      const x = line[0] // index (staged) status
      const y = line[1] // worktree status
      if (x !== ' ' && x !== '?' && x !== '!') staged++
      modified++
    }

    // Get ahead/behind
    let ahead = 0
    let behind = 0
    const revList = await execSSH(client, `cd "${remotePath}" && git rev-list --count --left-right HEAD...@{upstream} 2>/dev/null`)
    const match = revList.trim().match(/^(\d+)\s+(\d+)$/)
    if (match) {
      ahead = parseInt(match[1], 10)
      behind = parseInt(match[2], 10)
    }

    return { modified, staged, ahead, behind, hasRepo: true }
  } catch {
    return empty
  }
}

export async function gitDiffSummary(client: Client, remotePath: string): Promise<string> {
  // Get a compact summary of changes: file names with status (M/A/D/?)
  const out = await execSSH(client, `cd "${remotePath}" && git status --porcelain 2>/dev/null`)
  const lines = out.trim().split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return ''

  const modified: string[] = []
  const added: string[] = []
  const deleted: string[] = []

  for (const line of lines) {
    const status = line.substring(0, 2).trim()
    const file = line.substring(3).trim()
    const name = file.split('/').pop() || file
    if (status === 'D') deleted.push(name)
    else if (status === '??' || status === 'A') added.push(name)
    else modified.push(name)
  }

  const parts: string[] = []
  if (modified.length > 0) parts.push(`Update ${modified.slice(0, 3).join(', ')}${modified.length > 3 ? ` +${modified.length - 3} more` : ''}`)
  if (added.length > 0) parts.push(`Add ${added.slice(0, 3).join(', ')}${added.length > 3 ? ` +${added.length - 3} more` : ''}`)
  if (deleted.length > 0) parts.push(`Remove ${deleted.slice(0, 3).join(', ')}${deleted.length > 3 ? ` +${deleted.length - 3} more` : ''}`)

  return parts.join('; ')
}

export async function gitCommitAndPush(client: Client, remotePath: string, message: string): Promise<string> {
  const escapedMsg = message.replace(/"/g, '\\"')

  // Stage + commit
  const commitOut = await execSSH(client, `cd "${remotePath}" && git add -A && git commit -m "${escapedMsg}" 2>&1`)

  // Push separately so we can detect push failures
  const pushOut = await execSSH(client, `cd "${remotePath}" && git push 2>&1`)
  const pushLower = pushOut.toLowerCase()
  if (pushLower.includes('fatal:') || pushLower.includes('error:') || pushLower.includes('rejected')) {
    throw new Error(`Commit succeeded but push failed:\n${pushOut.trim()}`)
  }

  return `${commitOut}\n${pushOut}`
}

export async function gitPush(client: Client, remotePath: string): Promise<string> {
  const pushOut = await execSSH(client, `cd "${remotePath}" && git push 2>&1`)
  const pushLower = pushOut.toLowerCase()
  if (pushLower.includes('fatal:') || pushLower.includes('error:') || pushLower.includes('rejected')) {
    throw new Error(`Push failed:\n${pushOut.trim()}`)
  }
  return pushOut
}

export async function gitFetch(client: Client, remotePath: string): Promise<string> {
  return execSSH(client, `cd "${remotePath}" && git fetch 2>&1`)
}

export async function gitPull(client: Client, remotePath: string): Promise<string> {
  return execSSH(client, `cd "${remotePath}" && git pull 2>&1`)
}

export async function gitDiscardChanges(client: Client, remotePath: string): Promise<string> {
  // Reset staged changes, checkout all modified files, remove untracked files
  const cmd = `cd "${remotePath}" && git checkout -- . && git clean -fd 2>&1`
  return execSSH(client, cmd)
}

/* ======================== GitHub Auth ======================== */

export interface GitHubAuthStatus {
  authenticated: boolean
  username?: string
  ghInstalled: boolean
}

export async function checkGitHubAuth(client: Client): Promise<GitHubAuthStatus> {
  // Check if gh CLI is available (try common paths including ~/.local/bin)
  const ghCheck = await execSSH(client, 'bash -l -c "command -v gh" 2>/dev/null')
  if (!ghCheck.trim()) {
    return { authenticated: false, ghInstalled: false }
  }

  const status = await execSSH(client, 'bash -l -c "gh auth status" 2>&1')
  const loggedIn = status.includes('Logged in to')
  const usernameMatch = status.match(/Logged in to github\.com[^\n]*account\s+(\S+)/)
    || status.match(/Logged in to github\.com[^\n]*as\s+(\S+)/)
  return { authenticated: loggedIn, username: usernameMatch?.[1], ghInstalled: true }
}

export async function installGhCli(client: Client): Promise<void> {
  // Install gh CLI to ~/.local/bin using prebuilt binary (no sudo needed)
  const script = [
    'set -e',
    'mkdir -p ~/.local/bin',
    'ARCH=$(uname -m)',
    'case "$ARCH" in x86_64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; esac',
    'VERSION=$(curl -sL https://api.github.com/repos/cli/cli/releases/latest | grep \'"tag_name"\' | head -1 | sed -E \'s/.*"v([^"]+)".*/\\1/\')',
    'curl -sL "https://github.com/cli/cli/releases/download/v${VERSION}/gh_${VERSION}_linux_${ARCH}.tar.gz" | tar xz -C /tmp',
    'cp "/tmp/gh_${VERSION}_linux_${ARCH}/bin/gh" ~/.local/bin/gh',
    'chmod +x ~/.local/bin/gh',
    'rm -rf "/tmp/gh_${VERSION}_linux_${ARCH}"',
    // Ensure ~/.local/bin is in PATH for future bash -l sessions
    'grep -q "/.local/bin" ~/.bashrc 2>/dev/null || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc',
  ].join(' && ')

  const out = await execSSH(client, `bash -c '${script}' 2>&1`)
  // Verify installation
  const verify = await execSSH(client, 'bash -l -c "~/.local/bin/gh --version" 2>&1')
  if (!verify.includes('gh version')) {
    throw new Error('Failed to install gh CLI: ' + out)
  }
}

export interface DeviceAuthResult {
  userCode: string
  verificationUrl: string
  waitForCompletion: () => Promise<{ success: boolean; username?: string; error?: string }>
}

export async function startGitHubDeviceAuth(client: Client): Promise<DeviceAuthResult> {
  // Step 1: Request a device code from GitHub via gh's oauth device flow (non-interactive)
  const tokenOutput = await execSSH(client,
    'bash -l -c \'gh auth login -h github.com -p https -w 2>&1\' <<< "Y" || true'
  )

  // If the simple stdin pipe didn't work, try a different approach
  // Use expect-style interaction via script command
  let output = tokenOutput
  if (!output.includes('one-time code')) {
    // Fallback: use script + printf to answer the prompt non-interactively
    output = await execSSH(client,
      'bash -l -c \'printf "Y\\n" | gh auth login -h github.com -p https -w 2>&1\' || true'
    )
  }

  if (!output.includes('one-time code')) {
    // Final fallback: use unbuffer/expect or direct device flow via gh api
    output = await execSSH(client,
      'bash -l -c \'echo Y | script -qc "gh auth login -h github.com -p https -w" /dev/null 2>&1\' || true'
    )
  }

  // Extract the one-time code
  const codeMatch = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)
  if (!codeMatch) {
    throw new Error('Failed to get GitHub device code. Output: ' + output.substring(0, 500))
  }

  const userCode = codeMatch[1]

  // The auth flow is now waiting in the background for the user to enter the code on github.com
  // Start a polling loop to check when auth completes
  const waitForCompletion = (): Promise<{ success: boolean; username?: string; error?: string }> => {
    return new Promise((resolve) => {
      let attempts = 0
      const maxAttempts = 60 // 5 minutes at 5-second intervals

      const poll = () => {
        attempts++
        execSSH(client, 'bash -l -c "gh auth status 2>&1"').then((statusOutput) => {
          if (statusOutput.includes('Logged in to')) {
            // Auth succeeded — also set up git credential helper
            execSSH(client, 'bash -l -c "gh auth setup-git 2>&1"').catch(() => {})
            const usernameMatch = statusOutput.match(/Logged in to github\.com[^\n]*(?:account\s+|as\s+)(\S+)/)
            resolve({ success: true, username: usernameMatch?.[1] })
          } else if (attempts >= maxAttempts) {
            resolve({ success: false, error: 'Timed out waiting for GitHub authorization' })
          } else {
            setTimeout(poll, 5000)
          }
        }).catch(() => {
          if (attempts >= maxAttempts) {
            resolve({ success: false, error: 'Lost connection while waiting for authorization' })
          } else {
            setTimeout(poll, 5000)
          }
        })
      }

      // Start polling after a short delay (give user time to enter code)
      setTimeout(poll, 5000)
    })
  }

  return {
    userCode,
    verificationUrl: 'https://github.com/login/device',
    waitForCompletion,
  }
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  email: string
  date: string
  subject: string
}

/** Recent commits on the current branch. Uses a null-byte record separator +
 *  unit separator between fields so subject lines with newlines don't break
 *  parsing (git wraps body at 72 cols when pretty includes %b, but %s stays
 *  single-line). */
export async function gitLog(
  client: Client,
  remotePath: string,
  limit: number = 20,
): Promise<GitCommit[]> {
  try {
    const fmt = '%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x00'
    const out = await execSSH(
      client,
      `cd "${remotePath}" && git log -n ${Math.max(1, Math.min(200, limit))} --date=iso-strict --pretty=format:'${fmt}' 2>/dev/null`,
    )
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

export interface GitFileChange {
  path: string
  /** Porcelain status code. XY — X = index, Y = worktree.  '??' = untracked. */
  status: string
}

/** Parsed `git status --porcelain=v1 -z` — zero-terminated records handle paths
 *  with spaces / quotes safely. */
export async function gitChangedFiles(client: Client, remotePath: string): Promise<GitFileChange[]> {
  try {
    const out = await execSSH(
      client,
      `cd "${remotePath}" && git status --porcelain=v1 -z 2>/dev/null`,
    )
    const records = out.split('\0').filter((r) => r.length > 0)
    const changes: GitFileChange[] = []
    for (const rec of records) {
      // Each record: XY SP path (no quoting thanks to -z).
      const status = rec.slice(0, 2)
      const path = rec.slice(3)
      if (path) changes.push({ status, path })
    }
    return changes
  } catch {
    return []
  }
}

export interface GhPullRequest {
  number: number
  title: string
  url: string
  state: string
  author: string
  createdAt: string
  headRefName: string
  isDraft: boolean
}

/** Wraps `gh pr list --json`. Requires gh CLI installed + authenticated on the
 *  env. Returns an empty list on any failure (missing gh, not a repo, etc.). */
export async function ghPullRequests(client: Client, remotePath: string, limit: number = 20): Promise<GhPullRequest[]> {
  try {
    const out = await execSSH(
      client,
      `cd "${remotePath}" && PATH="$HOME/.local/bin:$PATH" gh pr list --limit ${Math.max(1, Math.min(50, limit))} --json number,title,url,state,author,createdAt,headRefName,isDraft 2>/dev/null`,
    )
    const trimmed = out.trim()
    if (!trimmed.startsWith('[')) return []
    const parsed = JSON.parse(trimmed) as Array<{
      number: number
      title: string
      url: string
      state: string
      author?: { login?: string }
      createdAt: string
      headRefName: string
      isDraft: boolean
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
  } catch {
    return []
  }
}

export interface GhWorkflowRun {
  databaseId: number
  name: string
  displayTitle: string
  status: string
  conclusion: string | null
  headBranch: string
  createdAt: string
  url: string
}

/** Wraps `gh run list --json`. Same fail-soft semantics as ghPullRequests. */
export async function ghWorkflowRuns(client: Client, remotePath: string, limit: number = 20): Promise<GhWorkflowRun[]> {
  try {
    const out = await execSSH(
      client,
      `cd "${remotePath}" && PATH="$HOME/.local/bin:$PATH" gh run list --limit ${Math.max(1, Math.min(50, limit))} --json databaseId,name,displayTitle,status,conclusion,headBranch,createdAt,url 2>/dev/null`,
    )
    const trimmed = out.trim()
    if (!trimmed.startsWith('[')) return []
    return JSON.parse(trimmed) as GhWorkflowRun[]
  } catch {
    return []
  }
}

export async function gitRemoteUrl(client: Client, remotePath: string): Promise<string | null> {
  try {
    const raw = await execSSH(client, `cd "${remotePath}" && git remote get-url origin 2>/dev/null`)
    const url = raw.trim()
    if (!url) return null
    // Convert SSH URL to HTTPS URL: git@github.com:user/repo.git -> https://github.com/user/repo
    if (url.startsWith('git@')) {
      const match = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
      if (match) return `https://${match[1]}/${match[2]}`
    }
    // Already HTTPS
    if (url.startsWith('https://')) {
      return url.replace(/\.git$/, '')
    }
    return url
  } catch {
    return null
  }
}
