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

export function useStartRoutine() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().routines.start(id) as Promise<Routine>,
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
