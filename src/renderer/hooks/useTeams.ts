import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TeamRole, WorkspaceCapability } from '../stores/auth-store'

const api = () => window.electronAPI

/** Full role catalogue for a team: builtins + customs. Usually hydrated
 *  inline on /api/me (via authStore.teams[i].roles) — this hook is the
 *  authoritative refresh path used by the TeamSettings roles editor
 *  after a create/update/delete. */
export function useTeamRoles(teamId: string | null) {
  return useQuery<TeamRole[]>({
    queryKey: ['team-roles', teamId],
    queryFn: () => api().teams.listRoles(teamId!) as Promise<TeamRole[]>,
    enabled: !!teamId,
    staleTime: 10_000,
  })
}

export function useCreateTeamRole(teamId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { slug: string; name: string; description?: string | null; capabilities: WorkspaceCapability[] }) =>
      api().teams.createRole(teamId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-roles', teamId] })
      // /api/me response carries team.roles — refetching invalidates auth
      // state so useWorkspaceRole sees the new capabilities immediately.
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

export function useUpdateTeamRole(teamId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ roleId, data }: { roleId: string; data: { name?: string; description?: string | null; capabilities?: WorkspaceCapability[] } }) =>
      api().teams.updateRole(teamId, roleId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-roles', teamId] })
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

export function useDeleteTeamRole(teamId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ roleId, reassignTo }: { roleId: string; reassignTo?: string }) =>
      api().teams.deleteRole(teamId, roleId, reassignTo),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team-roles', teamId] })
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}

/** Change a specific member's role to any slug (builtin or custom). The
 *  TeamSettingsView member row uses this on every <select> change. */
export function useUpdateMemberRole(teamId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: string }) =>
      api().teams.updateMemberRole(teamId, userId, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teams', teamId] })
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      qc.invalidateQueries({ queryKey: ['auth', 'me'] })
    },
  })
}
