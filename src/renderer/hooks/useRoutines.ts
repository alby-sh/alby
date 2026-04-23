import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { Routine, CreateRoutineDTO, UpdateRoutineDTO } from '../../shared/types'

const api = () => window.electronAPI

export function useRoutines(environmentId: string | null) {
  return useQuery<Routine[]>({
    queryKey: ['routines', environmentId],
    queryFn: () => api().routines.listByEnv(environmentId!),
    enabled: !!environmentId
  })
}

export function useAllRoutines() {
  return useQuery<Routine[]>({
    queryKey: ['routines-all'],
    queryFn: () => api().routines.list(),
    refetchInterval: 20000,
    staleTime: 10000
  })
}

export function useCreateRoutine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateRoutineDTO) => api().routines.create(data) as Promise<Routine>,
    onSuccess: (routine) => {
      qc.invalidateQueries({ queryKey: ['routines', routine.environment_id] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
    }
  })
}

export function useUpdateRoutine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateRoutineDTO }) =>
      api().routines.update(id, data) as Promise<Routine>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routines'] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
    }
  })
}

export function useDeleteRoutine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().routines.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routines'] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
    }
  })
}

export function useReorderRoutines() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ envId, orderedIds }: { envId: string; orderedIds: string[] }) =>
      api().routines.reorder(envId, orderedIds),
    onSuccess: (_, { envId }) => {
      qc.invalidateQueries({ queryKey: ['routines', envId] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
    },
  })
}

/**
 * Start a routine. Accepts either a plain routine id (the common case used by
 * the quick-start Play buttons in the sidebar) or `{ id, extraInput }` when
 * the user typed one-off context into the RoutineView textarea before
 * pressing Start. `extraInput` is appended to the stored prompt and only
 * honoured for manual routines — the backend ignores it for cron/interval ones.
 */
export function useStartRoutine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (variables: string | { id: string; extraInput?: string }) => {
      const { id, extraInput } = typeof variables === 'string'
        ? { id: variables, extraInput: undefined }
        : variables
      return api().routines.start(id, extraInput) as Promise<Routine>
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routines'] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
    }
  })
}

export function useStopRoutine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().routines.stop(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['routines'] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
    }
  })
}

export function useRoutineStatusChange(callback: (data: { routineId: string; running: boolean; exitCode?: number }) => void) {
  const qc = useQueryClient()
  useEffect(() => {
    const unsub = api().routines.onStatusChange((data) => {
      qc.invalidateQueries({ queryKey: ['routines'] })
      qc.invalidateQueries({ queryKey: ['routines-all'] })
      callback(data)
    })
    return unsub
  }, [callback, qc])
}
