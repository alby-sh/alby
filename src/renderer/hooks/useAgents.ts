import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useCallback } from 'react'
import type { Agent, AgentStatus } from '../../shared/types'
import { useToastStore } from '../stores/toast-store'

const api = () => window.electronAPI

export function useAgents(taskId: string | null) {
  return useQuery<Agent[]>({
    queryKey: ['agents', taskId],
    queryFn: () => api().agents.list(taskId!),
    enabled: !!taskId
  })
}

export function useAllAgents() {
  return useQuery<Agent[]>({
    queryKey: ['agents-all'],
    queryFn: () => api().agents.listAll(),
    // v0.8.3: tightened the safety-net poll from 15 s → 5 s. Reverb is the
    // primary path (`entity.changed` with entity=agent invalidates this
    // key instantly), but the poll catches the edge cases:
    //   (a) Reverb disconnected (flaky wifi, laptop sleep) — the app still
    //       needs to discover a teammate's new session in a few seconds,
    //       not wait half a minute.
    //   (b) A local agent spawned on another Mac: the server broadcasts it,
    //       but if the socket is stale the only way to see the row is the
    //       poll-driven `listAllRunningAgents` call below.
    // 5 s × N clients is still cheap: the endpoint is a single indexed
    // query, returns at most a few dozen rows per user. Combined with
    // `refetchOnWindowFocus` below the live-feel is effectively instant
    // when you switch to the app tab.
    refetchInterval: 5000,
    staleTime: 3000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  })
}

export function useSpawnAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, agentType, autoInstall }: { taskId: string; agentType?: string; autoInstall?: boolean }) =>
      api().agents.spawn(taskId, agentType, autoInstall),
    onSuccess: (agent) => {
      // The sidebar's session counts + "No sessions" placeholder both read from
      // useAllAgents, so we must invalidate that key too — otherwise a freshly
      // spawned agent is invisible in the sidebar until the next Reverb poke
      // (which can lag 1-2 seconds and is also skipped when the user is
      // offline / between reconnects).
      qc.invalidateQueries({ queryKey: ['agents', agent.task_id] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
    }
  })
}

export function useUpdateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, data }: { agentId: string; data: { tab_name?: string } }) =>
      api().agents.update(agentId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
    },
  })
}

export function useKillAgent() {
  const qc = useQueryClient()
  const pushToast = useToastStore((s) => s.push)
  return useMutation({
    mutationFn: (agentId: string) => api().agents.kill(agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
    },
    // v0.8.3: the main-process guard throws a friendly string when the
    // user tries to kill a foreign-local agent. Surface it as a toast so
    // the click has visible feedback instead of silently failing.
    onError: (err: unknown) => {
      pushToast({ message: err instanceof Error ? err.message : String(err) })
    },
  })
}

export function useDeleteAgent() {
  const qc = useQueryClient()
  const pushToast = useToastStore((s) => s.push)
  return useMutation({
    mutationFn: (agentId: string) => api().agents.delete(agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
    },
    onError: (err: unknown) => {
      pushToast({ message: err instanceof Error ? err.message : String(err) })
    },
  })
}

export function useReorderAgents() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (orderedIds: string[]) => api().agents.reorder(orderedIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
    },
  })
}

export function useAgentStdout(callback: (data: { agentId: string; data: string }) => void) {
  useEffect(() => {
    const unsub = api().agents.onStdout(callback)
    return unsub
  }, [callback])
}

export function useAgentStatusChange(
  onStatusChange: (data: { agentId: string; status: AgentStatus; exitCode?: number }) => void
) {
  const qc = useQueryClient()

  const handler = useCallback(
    (data: { agentId: string; status: string; exitCode?: number }) => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      onStatusChange(data as { agentId: string; status: AgentStatus; exitCode?: number })
    },
    [qc, onStatusChange]
  )

  useEffect(() => {
    const unsub = api().agents.onStatusChange(handler)
    return unsub
  }, [handler])
}
