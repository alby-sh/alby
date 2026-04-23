import { useMemo } from 'react'
import {
  useAuthStore,
  type BuiltinRole,
  type TeamRole,
  type WorkspaceCapability,
  type WorkspaceRole,
} from '../stores/auth-store'
import { useAllProjects } from './useProjects'
import { useAppStore } from '../stores/app-store'

interface WorkspacePermissions {
  role: WorkspaceRole
  isPersonal: boolean
  canLaunchAgents: boolean
  canEdit: boolean
  canSeeReports: boolean
  canManageWorkspace: boolean
  canReportIssue: boolean
  canManageRoles: boolean
  /** True when the ONLY capability the user has on this workspace is
   *  report_issue — triggers the minimal IssuerShell. Corresponds to
   *  the builtin 'issuer' role today, but since roles are now open-ended,
   *  we detect it by capability shape rather than by slug equality. */
  isIssuerOnly: boolean
  /** Full capability list — useful when a consumer needs a cap we didn't
   *  surface as a named boolean above (e.g. run_deploy, view_issues). */
  capabilities: Set<WorkspaceCapability>
}

/** Hardcoded fallback used when the team's `roles` list hasn't been
 *  hydrated yet (cold bootstrap) or when the backend is pre-v0.8.1 and
 *  doesn't ship them at all. Keeps the app usable — the lookup gracefully
 *  falls back to these defaults for the 7 builtin slugs. */
const BUILTIN_CAPS: Record<BuiltinRole, WorkspaceCapability[]> = {
  owner: [
    'launch_agents', 'edit_projects', 'see_reports', 'manage_workspace',
    'report_issue', 'view_issues', 'resolve_issues', 'run_deploy',
    'manage_routines', 'manage_roles',
  ],
  admin: [
    'launch_agents', 'edit_projects', 'see_reports', 'manage_workspace',
    'report_issue', 'view_issues', 'resolve_issues', 'run_deploy',
    'manage_routines', 'manage_roles',
  ],
  developer: [
    'launch_agents', 'edit_projects', 'see_reports',
    'report_issue', 'view_issues', 'resolve_issues', 'run_deploy',
    'manage_routines',
  ],
  member: [
    'launch_agents', 'edit_projects', 'see_reports',
    'report_issue', 'view_issues', 'resolve_issues', 'run_deploy',
    'manage_routines',
  ],
  viewer: ['see_reports', 'report_issue', 'view_issues'],
  analyst: ['see_reports', 'view_issues'],
  issuer: ['report_issue'],
}

/** "Personal" workspace (no team) gets every cap — this is the user
 *  acting on their own projects where role semantics don't apply. */
const PERSONAL_CAPS: WorkspaceCapability[] = [
  'launch_agents', 'edit_projects', 'see_reports', 'manage_workspace',
  'report_issue', 'view_issues', 'resolve_issues', 'run_deploy',
  'manage_routines', 'manage_roles',
]

function capsForRole(role: WorkspaceRole, teamRoles: TeamRole[] | undefined): WorkspaceCapability[] {
  // Prefer the server-shipped role definition (picks up custom roles AND
  // any future capability change on a builtin). Fall back to the hardcoded
  // builtin matrix so a cold-start / pre-v0.8.1 backend stays functional.
  const fromServer = teamRoles?.find((r) => r.slug === role)
  if (fromServer) return fromServer.capabilities
  if (role in BUILTIN_CAPS) return BUILTIN_CAPS[role as BuiltinRole]
  return []
}

function buildPerms(role: WorkspaceRole, caps: WorkspaceCapability[], isPersonal: boolean): WorkspacePermissions {
  const set = new Set(caps)
  const has = (c: WorkspaceCapability) => set.has(c)
  return {
    role,
    isPersonal,
    canLaunchAgents: has('launch_agents'),
    canEdit: has('edit_projects'),
    canSeeReports: has('see_reports'),
    canManageWorkspace: has('manage_workspace'),
    canReportIssue: has('report_issue'),
    canManageRoles: has('manage_roles'),
    // Issuer-only: exactly one capability, and it's `report_issue`. We
    // detect by shape rather than by slug='issuer' so a team-custom role
    // with the same shape also triggers the minimal shell.
    isIssuerOnly: set.size === 1 && has('report_issue'),
    capabilities: set,
  }
}

const PERSONAL = buildPerms('owner', PERSONAL_CAPS, true)

// Resolve the effective permissions for the **current interaction context** —
// either the active workspace filter when specific, or the role on the owning
// team of whatever project is currently selected in the sidebar. The
// capabilities union pulls from the server-provided `roles` list on the
// team (so custom roles work) with a hardcoded builtin fallback.
export function useWorkspaceRole(): WorkspacePermissions {
  const workspace = useAuthStore((s) => s.workspace)
  const teams = useAuthStore((s) => s.teams)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const { data: projects } = useAllProjects()

  return useMemo(() => {
    let team = null as typeof teams[number] | null

    if (workspace !== 'all' && workspace !== 'personal') {
      team = teams.find((t) => t.id === workspace) ?? null
    } else if (workspace === 'personal') {
      return PERSONAL
    } else {
      const project = projects?.find((p) => p.id === selectedProjectId)
      if (project && project.owner_type === 'team') {
        team = teams.find((t) => t.id === project.owner_id) ?? null
      } else {
        return PERSONAL
      }
    }

    if (!team) return PERSONAL
    const caps = capsForRole(team.role, team.roles)
    return buildPerms(team.role, caps, false)
  }, [workspace, teams, selectedProjectId, projects])
}
