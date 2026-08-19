import type { Client } from 'ssh2'

/**
 * Kills tmux sessions on a remote host that no longer belong to any agent.
 *
 * Several paths could strand a session: killing an agent while its SSH link
 * was down, deleting a row for an agent that was never reattached after a
 * restart, or an agent finishing while `remain-on-exit on` kept the session
 * alive around a dead pane. Each of those is fixed at the source, but the
 * failure mode is bad enough — sessions pile up for weeks with a live `claude`
 * in each one, eating the box — that it is worth a sweep that does not depend
 * on having found every path.
 *
 * Three rules keep it from killing something real:
 *
 *   1. Only `agent-<8 hex>` names are ever considered. Routines use
 *      `routine-<id>` and anything a human started is left alone.
 *   2. The cloud's running-agent list is required. Alby runs on more than one
 *      machine against the same servers, and the local database only knows
 *      about this one — reaping on local knowledge alone would kill sessions
 *      belonging to another device. If that list cannot be fetched, the sweep
 *      does nothing.
 *   3. Sessions younger than the grace period are skipped, so a session that
 *      is mid-spawn and not yet recorded anywhere is never caught.
 */

const SESSION_NAME = /^agent-[0-9a-f]{8}$/
const GRACE_MS = 10 * 60 * 1000

export interface ReapResult {
  scanned: number
  reaped: string[]
  skippedYoung: number
  abortedReason?: string
}

function exec(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve) => {
    client.exec(cmd, (err, channel) => {
      if (err) { resolve(''); return }
      let out = ''
      channel.on('data', (d: Buffer) => { out += d.toString() })
      channel.on('close', () => resolve(out))
    })
  })
}

/**
 * @param knownIds  agent ids this device knows about — local rows plus anything
 *                  currently attached. Full uuids; only the first 8 chars are
 *                  compared, matching how session names are built.
 * @param cloudIds  ids the cloud reports as running across every device, or
 *                  null when the call failed. null aborts the sweep.
 */
export async function reapOrphanSessions(
  client: Client,
  knownIds: Set<string>,
  cloudIds: Set<string> | null,
  label = 'remote'
): Promise<ReapResult> {
  if (cloudIds === null) {
    return { scanned: 0, reaped: [], skippedYoung: 0, abortedReason: 'cloud agent list unavailable' }
  }

  const raw = await exec(client, "tmux list-sessions -F '#{session_name} #{session_created}' 2>/dev/null")
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)

  const prefixes = new Set<string>()
  for (const id of knownIds) prefixes.add(id.substring(0, 8))
  for (const id of cloudIds) prefixes.add(id.substring(0, 8))

  const nowSec = Date.now() / 1000
  const result: ReapResult = { scanned: 0, reaped: [], skippedYoung: 0 }

  for (const line of lines) {
    const [name, createdRaw] = line.split(/\s+/)
    if (!name || !SESSION_NAME.test(name)) continue
    result.scanned++

    if (prefixes.has(name.slice('agent-'.length))) continue

    const created = Number(createdRaw)
    if (Number.isFinite(created) && (nowSec - created) * 1000 < GRACE_MS) {
      result.skippedYoung++
      continue
    }

    await exec(client, `tmux kill-session -t ${name} 2>/dev/null || true`)
    result.reaped.push(name)
  }

  if (result.reaped.length) {
    console.log(`[SessionReaper] ${label}: killed ${result.reaped.length} orphaned session(s): ${result.reaped.join(', ')}`)
  }
  return result
}
