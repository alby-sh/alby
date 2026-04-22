import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateStackDTO, Stack, UpdateStackDTO } from '../../shared/types'

const api = () => window.electronAPI

export function useStacks(projectId: string | null) {
  return useQuery<Stack[]>({
    queryKey: ['stacks', projectId],
    queryFn: () => api().stacks.list(projectId!),
    enabled: !!projectId,
  })
}

export function useStack(id: string | null) {
  return useQuery<Stack | null>({
    queryKey: ['stack', id],
    queryFn: () => api().stacks.get(id!),
    enabled: !!id,
  })
}

export function useCreateStack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateStackDTO) => api().stacks.create(data),
    onSuccess: (stack) => {
      qc.invalidateQueries({ queryKey: ['stacks', stack.project_id] })
    },
  })
}

export function useUpdateStack() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateStackDTO }) =>
      api().stacks.update(id, data),
    onSuccess: (stack) => {
      qc.invalidateQueries({ queryKey: ['stacks', stack.project_id] })
      qc.invalidateQueries({ queryKey: ['stack', stack.id] })
      // Envs render the stack's name in breadcrumb/sidebar — invalidate so they
      // pick up the rename.
      qc.invalidateQueries({ queryKey: ['environments', stack.project_id] })
    },
  })
}

export function useReorderStacks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, orderedIds }: { projectId: string; orderedIds: string[] }) =>
      api().stacks.reorder(projectId, orderedIds),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['stacks', vars.projectId] })
    },
  })
}

export function useDeleteStack(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().stacks.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['stacks', projectId] })
      qc.invalidateQueries({ queryKey: ['environments', projectId] })
    },
  })
}
