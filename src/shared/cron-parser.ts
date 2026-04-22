// Minimal cron → interval parser.
// v1 supports interval-only expressions. Anything else returns null so the
// caller can refuse the routine at validation time.

export interface CronParseResult {
  intervalSeconds: number
  normalized: string
}

export function parseCronToInterval(expr: string): CronParseResult | null {
  const trimmed = expr.trim()

  // Preset shorthand: "@every <N><unit>" where unit is s|m|h|d
  const everyMatch = trimmed.match(/^@every\s+(\d+)\s*([smhd])?$/i)
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10)
    const unit = (everyMatch[2] || 's').toLowerCase()
    const mult = unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400
    if (n > 0) return { intervalSeconds: n * mult, normalized: `@every ${n}${unit}` }
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) return null

  const [min, hour, dom, mon, dow] = parts
  const starPositions = [hour, dom, mon, dow].every((p) => p === '*')

  // "* * * * *" → every minute
  if (min === '*' && starPositions) return { intervalSeconds: 60, normalized: '* * * * *' }

  // "*/N * * * *" → every N minutes
  const minSlash = min.match(/^\*\/(\d+)$/)
  if (minSlash && starPositions) {
    const n = parseInt(minSlash[1], 10)
    if (n > 0 && n <= 59) return { intervalSeconds: n * 60, normalized: `*/${n} * * * *` }
  }

  // "0 */N * * *" → every N hours
  const hourSlash = hour.match(/^\*\/(\d+)$/)
  if (min === '0' && hourSlash && dom === '*' && mon === '*' && dow === '*') {
    const n = parseInt(hourSlash[1], 10)
    if (n > 0 && n <= 23) return { intervalSeconds: n * 3600, normalized: `0 */${n} * * *` }
  }

  // "0 * * * *" → hourly
  if (min === '0' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return { intervalSeconds: 3600, normalized: '0 * * * *' }
  }

  // "0 0 * * *" → daily
  if (min === '0' && hour === '0' && dom === '*' && mon === '*' && dow === '*') {
    return { intervalSeconds: 86400, normalized: '0 0 * * *' }
  }

  return null
}

export function intervalToPresetLabel(seconds: number): string {
  if (seconds < 60) return `Every ${seconds}s`
  if (seconds < 3600) {
    const m = Math.round(seconds / 60)
    return m === 1 ? 'Every minute' : `Every ${m} minutes`
  }
  if (seconds < 86400) {
    const h = Math.round(seconds / 3600)
    return h === 1 ? 'Hourly' : `Every ${h} hours`
  }
  const d = Math.round(seconds / 86400)
  return d === 1 ? 'Daily' : `Every ${d} days`
}
