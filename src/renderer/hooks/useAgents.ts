import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useCallback } from 'react'
import type { Agent, AgentStatus } from '../../shared/types'

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
    refetchInterval: 15000,
    staleTime: 8000
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
  return useMutation({
    mutationFn: (agentId: string) => api().agents.kill(agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
    }
  })
}

export function useDeleteAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (agentId: string) => api().agents.delete(agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      qc.invalidateQueries({ queryKey: ['agents-all'] })
    }
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
