import { ipcMain } from 'electron'
import { cloudClient } from '../cloud/cloud-client'
import { loadToken } from '../auth/keychain'

export function registerTeamsIPC(): void {
  const guarded = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (!(await loadToken())) return fallback
    try { return await fn() } catch (err) {
      console.error('[teams]', (err as Error).message)
      return fallback
    }
  }

  ipcMain.handle('teams:list', () => guarded(() => cloudClient.listTeams(), [] as unknown[]))
  ipcMain.handle('teams:get', (_, id: string) => guarded(() => cloudClient.getTeam(id), null as unknown))
  ipcMain.handle('teams:create', (_, data: { name: string; avatar_url?: string }) => cloudClient.createTeam(data))
  ipcMain.handle('teams:update', (_, id: string, data: { name?: string; avatar_url?: string | null }) => cloudClient.updateTeam(id, data))
  ipcMain.handle('teams:delete', (_, id: string) => cloudClient.deleteTeam(id))
  // invite/update-member-role accept ANY role slug (builtin or team-custom)
  // from v0.8.1 — the backend validates against the team's roles table.
  ipcMain.handle('teams:invite', (_, id: string, data: { email?: string; role: string }) => cloudClient.inviteTeamMember(id, data))
  ipcMain.handle('teams:remove-member', (_, id: string, userId: number) => cloudClient.removeTeamMember(id, userId))
  ipcMain.handle('teams:update-member-role', (_, id: string, userId: number, role: string) => cloudClient.updateTeamMemberRole(id, userId, role))

  // --- v0.8.1: team custom-role CRUD. The renderer reads the role list
  // primarily from the inline `teams[i].roles` shipped on /api/me, and
  // only hits these endpoints on explicit refresh or mutation. ---
  ipcMain.handle('teams:roles:list', (_, teamId: string) =>
    guarded(() => cloudClient.listTeamRoles(teamId), [] as unknown[])
  )
  ipcMain.handle('teams:roles:create', (_, teamId: string, data: { slug: string; name: string; description?: string | null; capabilities: string[] }) =>
    cloudClient.createTeamRole(teamId, data)
  )
  ipcMain.handle('teams:roles:update', (_, teamId: string, roleId: string, data: { name?: string; description?: string | null; capabilities?: string[] }) =>
    cloudClient.updateTeamRole(teamId, roleId, data)
  )
  ipcMain.handle('teams:roles:delete', (_, teamId: string, roleId: string, reassignTo?: string) =>
    cloudClient.deleteTeamRole(teamId, roleId, reassignTo)
  )
}
