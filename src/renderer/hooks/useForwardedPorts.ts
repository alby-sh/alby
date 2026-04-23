import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { ForwardedPort } from '../../shared/types'
import { useToastStore } from '../stores/toast-store'

const api = () => window.electronAPI

/**
 * SSH localhost-port forwards exposed by the env's launch agents.
 *
 * Source of truth lives in main (PortForwarder per launch agent). This hook:
 *   - Seeds with a one-shot fetch of the current state.
 *   - Subscribes to `ports:change` push events to keep the cache live without
 *     polling (the underlying detection is event-driven on stdout chunks).
 *
 * Why react-query instead of a Zustand store: every consumer in the renderer
 * already lives in a query client, so `invalidateQueries(['forwarded-ports'])`
 * gives us a free re-render without inventing a parallel notification layer.
 */
export function useForwardedPortsByAgent(agentId: string | null) {
  return useQuery<ForwardedPort[]>({
    queryKey: ['forwarded-ports', 'agent', agentId],
    queryFn: () => api().ports.listByAgent(agentId!),
    enabled: !!agentId,
    // No refetchInterval — we rely entirely on the `ports:change` push from
    // main. The query is just for the initial paint when a tab mounts.
    staleTime: Infinity,
  })
}

export function useForwardedPortsByEnv(envId: string | null) {
  return useQuery<ForwardedPort[]>({
    queryKey: ['forwarded-ports', 'env', envId],
    queryFn: () => api().ports.listByEnv(envId!),
    enabled: !!envId,
    staleTime: Infinity,
  })
}

/**
 * App-level subscriber: mount this once near the root so every push from
 * main turns into:
 *   1. A toast announcing "Port N → http://localhost:M" (the URL is also
 *      auto-opened in the system browser by main, so this is just a
 *      passive confirmation).
 *   2. React-Query cache invalidation so any mounted `useForwardedPorts*`
 *      hook re-fetches its slice.
 *
 * Mounting twice is fine but pointless — the listener is per-component and
 * fires per-mount. Keep this colocated with the toast root.
 */
export function useForwardedPortsBridge(): void {
  const qc = useQueryClient()
  const pushToast = useToastStore((s) => s.push)

  useEffect(() => {
    const offOpen = api().ports.onPortOpened((port) => {
      const url = `http://localhost:${port.local_port}`
      pushToast({
        message:
          port.remote_port === port.local_port
            ? `Port ${port.remote_port} forwarded → ${url}`
            : `Port ${port.remote_port} (remote) → ${url} (local was busy)`,
        durationMs: 6000,
      })
      // Re-fetch any mounted slice for this agent / env. The `change`
      // event below will fire too, but invalidating here keeps the
      // toast and the UI in lock-step in case onChange is stalled by
      // event-loop pressure.
      qc.invalidateQueries({ queryKey: ['forwarded-ports', 'agent', port.agent_id] })
      qc.invalidateQueries({ queryKey: ['forwarded-ports', 'env', port.environment_id] })
    })
    const offChange = api().ports.onChange((data) => {
      qc.invalidateQueries({ queryKey: ['forwarded-ports', 'agent', data.agentId] })
      if (data.environmentId) {
        qc.invalidateQueries({ queryKey: ['forwarded-ports', 'env', data.environmentId] })
      } else {
        // Disposal events arrive without an envId (the forwarder is
        // already gone). Bust the env-level slices defensively so any
        // open env-level badge clears too.
        qc.invalidateQueries({ queryKey: ['forwarded-ports', 'env'] })
      }
    })
    return () => {
      offOpen()
      offChange()
    }
  }, [qc, pushToast])
}
