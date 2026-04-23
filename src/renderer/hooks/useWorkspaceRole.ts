import { useMemo } from 'react'
import { useAuthStore, type WorkspaceRole } from '../stores/auth-store'
import { useAllProjects } from './useProjects'
import { useAppStore } from '../stores/app-store'

interface WorkspacePermissions {
  role: WorkspaceRole
  isPersonal: boolean
  canLaunchAgents: boolean
  canEdit: boolean
  canSeeReports: boolean
  canManageWorkspace: boolean
  /** True when the user is allowed to submit a new manual issue via the
   *  "Report issue" form. Everyone except pure 'analyst' gets this today;
   *  'issuer' exists specifically to grant ONLY this capability. */
  canReportIssue: boolean
  /** True when the effective role is the restricted 'issuer' and the whole
   *  app should render the minimal IssuerShell instead of the normal
   *  sidebar + main area. Pre-computed here so consumers don't duplicate
   *  the check. */
  isIssuerOnly: boolean
}

const PERSONAL: WorkspacePermissions = {
  role: 'owner',
  isPersonal: true,
  canLaunchAgents: true,
  canEdit: true,
  canSeeReports: true,
  canManageWorkspace: true,
  canReportIssue: true,
  isIssuerOnly: false,
}

// Resolve the effective role for the **current interaction context** — either
// the active workspace filter when specific, or the role on the owning team
// of whatever project is currently selected in the sidebar.
export function useWorkspaceRole(): WorkspacePermissions {
  const workspace = useAuthStore((s) => s.workspace)
  const teams = useAuthStore((s) => s.teams)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const { data: projects } = useAllProjects()

  return useMemo(() => {
    let role: WorkspaceRole | null = null

    if (workspace !== 'all' && workspace !== 'personal') {
      role = teams.find((t) => t.id === workspace)?.role ?? null
    } else if (workspace === 'personal') {
      return PERSONAL
    } else {
      // 'all' mode: use the selected project's owner team, if any.
      const project = projects?.find((p) => p.id === selectedProjectId)
      if (project && project.owner_type === 'team') {
        role = teams.find((t) => t.id === project.owner_id)?.role ?? null
      } else {
        return PERSONAL
      }
    }

    if (!role) return PERSONAL

    const isOwner = role === 'owner'
    const isAdmin = role === 'admin'
    const isDeveloper = role === 'developer' || role === 'member'
    const isViewer = role === 'viewer'
    const isAnalyst = role === 'analyst'
    const isIssuer = role === 'issuer'

    return {
      role,
      isPersonal: false,
      // Issuer is deliberately locked out of EVERY capability except the
      // one below. Any new capability added in the future must default to
      // false for issuer — the role is "can report, nothing else".
      canLaunchAgents: isOwner || isAdmin || isDeveloper,
      canEdit: isOwner || isAdmin || isDeveloper,
      canSeeReports: isOwner || isAdmin || isViewer || isAnalyst,
      canManageWorkspace: isOwner || isAdmin,
      canReportIssue: isOwner || isAdmin || isDeveloper || isViewer || isIssuer,
      isIssuerOnly: isIssuer,
    }
  }, [workspace, teams, selectedProjectId, projects])
}
