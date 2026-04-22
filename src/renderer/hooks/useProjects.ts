import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useAuthStore } from '../stores/auth-store'
import type {
  Project,
  Environment,
  Task,
  CreateProjectDTO,
  CreateEnvironmentDTO,
  CreateTaskDTO,
  UpdateProjectDTO,
  UpdateEnvironmentDTO,
  UpdateTaskDTO
} from '../../shared/types'

const api = () => window.electronAPI

// Returns every project the user has access to, regardless of workspace.
export function useAllProjects() {
  return useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api().projects.list()
  })
}

// Workspace-aware projects view: filters by the current top-bar selector.
//   'all'      -> every accessible project
//   'personal' -> only projects directly owned by the current user
//   <teamId>   -> only projects owned by that team
export function useProjects() {
  const all = useAllProjects()
  const workspace = useAuthStore((s) => s.workspace)
  const userId = useAuthStore((s) => s.user?.id)

  const data = useMemo(() => {
    if (!all.data) return undefined
    if (workspace === 'all') return all.data
    if (workspace === 'personal') {
      return all.data.filter(
        (p) => p.owner_type === 'user' && (!userId || p.owner_id === String(userId))
      )
    }
    return all.data.filter((p) => p.owner_type === 'team' && p.owner_id === workspace)
  }, [all.data, workspace, userId])

  return { ...all, data }
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateProjectDTO) => api().projects.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] })
  })
}

export function useUpdateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProjectDTO }) =>
      api().projects.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] })
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().projects.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] })
  })
}

// Environments
export function useEnvironment(id: string | null) {
  return useQuery<Environment | null>({
    queryKey: ['environment', id],
    queryFn: () => api().environments.get(id!),
    enabled: !!id
  })
}

export function useEnvironments(projectId: string | null) {
  return useQuery<Environment[]>({
    queryKey: ['environments', projectId],
    queryFn: () => api().environments.list(projectId!),
    enabled: !!projectId
  })
}

export function useCreateEnvironment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateEnvironmentDTO) => api().environments.create(data),
    onSuccess: (_, vars) =>
      qc.invalidateQueries({ queryKey: ['environments', vars.project_id] })
  })
}

export function useUpdateEnvironment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateEnvironmentDTO }) =>
      api().environments.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environments'] })
  })
}

export function useDeleteEnvironment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().environments.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environments'] })
  })
}

// Tasks
export function useTasks(environmentId: string | null) {
  return useQuery<Task[]>({
    queryKey: ['tasks', environmentId],
    queryFn: () => api().tasks.list(environmentId!),
    enabled: !!environmentId
  })
}

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateTaskDTO) => api().tasks.create(data),
    onSuccess: (_, vars) =>
      qc.invalidateQueries({ queryKey: ['tasks', vars.environment_id] })
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTaskDTO }) =>
      api().tasks.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] })
  })
}

export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().tasks.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] })
  })
}

// Reorder mutations
export function useReorderProjects() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (orderedIds: string[]) => api().projects.reorder(orderedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] })
  })
}

export function useReorderEnvironments() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, orderedIds }: { projectId: string; orderedIds: string[] }) =>
      api().environments.reorder(projectId, orderedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['environments'] })
  })
}

export function useReorderTasks() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ environmentId, orderedIds }: { environmentId: string; orderedIds: string[] }) =>
      api().tasks.reorder(environmentId, orderedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] })
  })
}
