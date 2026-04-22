import type { EnvironmentPlatform } from '../../shared/types'

/**
 * Wrap a user-supplied command for the target platform so we can run it via
 * SSH's exec channel (not a PTY) with predictable quoting.
 *
 * Linux  → `bash -l -c '…'` (login shell so PATH from ~/.bashrc / ~/.profile
 *           is available for tools like `composer`, `php`, `node`).
 * Windows → `powershell -NoProfile -Command "…"` (no profile so user scripts
 *           don't pollute the environment; quoting is PowerShell-safe).
 */
export function wrapCommand(
  platform: EnvironmentPlatform,
  command: string,
  opts?: { cwd?: string }
): string {
  if (platform === 'windows') {
    const cwdPart = opts?.cwd ? `Set-Location -LiteralPath '${psSingleQuote(opts.cwd)}'; ` : ''
    // Use $ErrorActionPreference=Stop so non-terminating errors become fatal;
    // otherwise a failed step would silently continue.
    const wrapped = `$ErrorActionPreference='Stop'; ${cwdPart}${command}`
    return `powershell -NoProfile -NonInteractive -Command ${psDoubleQuote(wrapped)}`
  }

  const cwdPart = opts?.cwd ? `cd ${bashSingleQuote(opts.cwd)} && ` : ''
  // `set -e` aborts the chain as soon as something fails so exit code reflects
  // the real status — users expect a deploy to stop on the first error.
  const script = `set -e; ${cwdPart}${command}`
  return `bash -l -c ${bashSingleQuote(script)}`
}

/** bash-style single-quote escape: wrap, close-escape-open for inner quotes. */
export function bashSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** PowerShell single-quote escape: inner single quotes are doubled. */
export function psSingleQuote(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * PowerShell double-quote wrap.
 *
 * Escape backticks (PS escape char), double quotes, $, and drop newlines —
 * the resulting string is consumed by the outer `powershell -Command "..."`
 * invocation, and must survive the surrounding cmd.exe layer SSH uses on
 * Windows. Stripping literal newlines keeps multi-step scripts on one line;
 * callers should chain with `;` or `&&` not actual CRLFs.
 */
export function psDoubleQuote(s: string): string {
  const cleaned = s.replace(/\r?\n/g, '; ')
  const escaped = cleaned
    .replace(/`/g, '``')
    .replace(/"/g, '`"')
    .replace(/\$/g, '`$')
  return `"${escaped}"`
}

/** Human-readable description of the platform for log lines. */
export function platformLabel(p: EnvironmentPlatform): string {
  return p === 'windows' ? 'Windows (PowerShell)' : 'Linux (bash)'
}
