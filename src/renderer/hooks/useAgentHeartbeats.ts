import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/app-store'
import { useActivityStore } from '../stores/activity-store'

const TICK_MS = 1_000
const FLUSH_MS = 30_000

interface PendingDeltas {
  workingMs: number
  viewedMs: number
}

// Accumulates two cumulative time series per agent and flushes them to the
// cloud every 30 s as integer-second deltas:
//   workingSeconds — wall time the agent was producing output / actively
//                    processing (activity-store status === 'working').
//   viewedSeconds  — wall time the user was actually looking at the agent
//                    pane: app window focused AND the agent is the active
//                    one in MainArea.
export function useAgentHeartbeats(): void {
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const activities = useActivityStore((s) => s.activities)

  const pending = useRef<Map<string, PendingDeltas>>(new Map())
  const focused = useRef<boolean>(typeof document !== 'undefined' ? document.hasFocus() : true)
  const activeRef = useRef<string | null>(activeAgentId)
  activeRef.current = activeAgentId

  // Track focus
  useEffect(() => {
    const onFocus = (): void => { focused.current = true }
    const onBlur = (): void => { focused.current = false }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 1 s tick: increment deltas for whichever agent is "working" + the agent
  // currently being viewed (if window focused).
  useEffect(() => {
    const t = window.setInterval(() => {
      // Working: anyone whose activity says 'working'
      for (const [agentId, status] of activities) {
        if (status !== 'working') continue
        const cur = pending.current.get(agentId) ?? { workingMs: 0, viewedMs: 0 }
        cur.workingMs += TICK_MS
        pending.current.set(agentId, cur)
      }
      // Viewed: only if the window is focused and there is an active agent
      const active = activeRef.current
      if (active && focused.current && active !== '__launcher__') {
        const cur = pending.current.get(active) ?? { workingMs: 0, viewedMs: 0 }
        cur.viewedMs += TICK_MS
        pending.current.set(active, cur)
      }
    }, TICK_MS)
    return () => window.clearInterval(t)
  }, [activities])

  // 30 s flush: send accumulated seconds to the cloud, then reset.
  useEffect(() => {
    const flush = async (): Promise<void> => {
      if (pending.current.size === 0) return
      const snapshot = Array.from(pending.current.entries())
      pending.current.clear()
      for (const [agentId, deltas] of snapshot) {
        const working = Math.floor(deltas.workingMs / 1000)
        const viewed = Math.floor(deltas.viewedMs / 1000)
        if (working === 0 && viewed === 0) continue
        try {
          await window.electronAPI.agents.heartbeat(agentId, {
            working_delta: working || undefined,
            viewed_delta: viewed || undefined,
          })
        } catch {
          // Network blip — drop this batch; the next tick rebuilds.
        }
      }
    }
    const t = window.setInterval(() => { void flush() }, FLUSH_MS)
    // Final flush before unload so we don't lose the tail.
    const onUnload = (): void => { void flush() }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}
