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
  ipcMain.handle('teams:invite', (_, id: string, data: { email?: string; role: 'admin' | 'developer' | 'viewer' | 'analyst' }) => cloudClient.inviteTeamMember(id, data))
  ipcMain.handle('teams:remove-member', (_, id: string, userId: number) => cloudClient.removeTeamMember(id, userId))
  ipcMain.handle('teams:update-member-role', (_, id: string, userId: number, role: 'admin' | 'developer' | 'viewer' | 'analyst') => cloudClient.updateTeamMemberRole(id, userId, role))
}
