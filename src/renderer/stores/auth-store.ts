import { create } from 'zustand'

export interface AuthUser {
  id: number
  name: string
  email: string
  avatar_url: string | null
}

/** Slugs of the 6 built-in roles. Every team gets these seeded on creation
 *  so the Laravel side can store them in the `team_roles` table alongside
 *  user-defined roles and resolve `team_members.role` consistently. */
export type BuiltinRole = 'owner' | 'admin' | 'developer' | 'viewer' | 'analyst' | 'member' | 'issuer'

/** What the effective role on a workspace ultimately is. Historically a
 *  closed enum of builtins; from v0.8.1 onward it's any slug that exists
 *  in the owning team's `roles` list — i.e. any builtin OR any custom
 *  role the team admin defined. Typed as a plain string here so the
 *  compiler doesn't scream every time we read it, while still letting
 *  the builtin literals participate in narrowing via BuiltinRole. */
export type WorkspaceRole = BuiltinRole | (string & {})

/** A capability flag on a team role. Kept as a string union so adding a
 *  new one is a one-line change propagated through the codebase via
 *  grep. Stored on team_roles.capabilities as a JSON array. */
export type WorkspaceCapability =
  | 'launch_agents'        // spawn terminal/agent sessions, write to stdin
  | 'edit_projects'        // create / rename / delete projects, envs, stacks, tasks
  | 'see_reports'          // open activity reports, analytics
  | 'manage_workspace'     // edit team + members + billing; invite/remove
  | 'report_issue'         // POST /api/apps/{id}/issues (manual issue submit)
  | 'view_issues'          // see the Issues tab at all — separate from report
  | 'resolve_issues'       // change issue status, delete resolved
  | 'run_deploy'           // press Deploy now on a deploy-role env
  | 'manage_routines'      // create / edit / start / stop routines
  | 'manage_roles'         // CRUD on team_roles (custom roles)

/** Full shape of a team role — either a builtin or a custom one. The
 *  only field that varies across teams is `capabilities` (custom roles)
 *  and `name` (team admin can label "Frontend Lead" however they like).
 *  `is_builtin=true` means capabilities are hardcoded server-side and
 *  cannot be edited; the slug is one of BuiltinRole. */
export interface TeamRole {
  id: string
  team_id: string
  slug: WorkspaceRole
  name: string
  description: string | null
  capabilities: WorkspaceCapability[]
  is_builtin: boolean
}

export interface AuthTeam {
  id: string
  name: string
  slug: string
  avatar_url: string | null
  /** The effective role slug of the current user on this team. References
   *  a `TeamRole.slug` in `roles` below. */
  role: WorkspaceRole
  /** All roles defined on this team — builtins + customs. Populated by
   *  /api/me on login and refreshed on `entity.changed` type='team_role'.
   *  Used by useWorkspaceRole to look up the current user's capabilities
   *  without an extra fetch every time the dependency list changes. */
  roles?: TeamRole[]
}

// 'all' = aggregate every workspace the user has access to.
// 'personal' = projects owned directly by the user (no team).
// string  = a specific team UUID.
export type WorkspaceFilter = 'all' | 'personal' | string

interface AuthState {
  initialized: boolean
  user: AuthUser | null
  teams: AuthTeam[]
  currentTeamId: string | null
  workspace: WorkspaceFilter
  busy: boolean
  error: string | null

  init: () => Promise<void>
  loginWithProvider: (provider: 'google' | 'microsoft') => Promise<void>
  loginWithEmail: (email: string, password: string) => Promise<void>
  registerWithEmail: (email: string, password: string, name: string) => Promise<void>
  verifyOtp: (email: string, code: string) => Promise<void>
  logout: () => Promise<void>
  setCurrentTeam: (teamId: string | null) => Promise<void>
  setWorkspace: (w: WorkspaceFilter) => void
  clearError: () => void
}

const api = () => window.electronAPI.auth

const WORKSPACE_KEY = 'workspace-filter'

function loadWorkspace(): WorkspaceFilter {
  try {
    const v = localStorage.getItem(WORKSPACE_KEY)
    if (v === 'all' || v === 'personal') return v
    if (v) return v
  } catch { /* ignore */ }
  return 'all'
}

export const useAuthStore = create<AuthState>((set) => ({
  initialized: false,
  user: null,
  teams: [],
  currentTeamId: null,
  workspace: loadWorkspace(),
  busy: false,
  error: null,

  init: async () => {
    try {
      const data = await api().current()
      if (data) {
        set({
          initialized: true,
          user: data.user,
          teams: data.teams ?? [],
          currentTeamId: data.current_team_id ?? null,
        })
      } else {
        set({ initialized: true, user: null, teams: [], currentTeamId: null })
      }
    } catch (e) {
      set({ initialized: true, user: null, error: (e as Error).message })
    }
  },

  loginWithProvider: async (provider) => {
    set({ busy: true, error: null })
    try {
      const data = await api().oauth(provider)
      set({
        user: data.user,
        teams: data.teams ?? [],
        currentTeamId: data.current_team_id ?? null,
        busy: false,
      })
    } catch (e) {
      set({ busy: false, error: (e as Error).message })
    }
  },

  loginWithEmail: async (email, password) => {
    set({ busy: true, error: null })
    try {
      const data = await api().loginEmail({ email, password })
      set({
        user: data.user,
        teams: data.teams ?? [],
        currentTeamId: data.current_team_id ?? null,
        busy: false,
      })
    } catch (e) {
      set({ busy: false, error: (e as Error).message })
    }
  },

  registerWithEmail: async (email, password, name) => {
    set({ busy: true, error: null })
    try {
      await api().register({ email, password, name })
    } catch (e) {
      set({ error: (e as Error).message })
      throw e
    } finally {
      set({ busy: false })
    }
  },

  verifyOtp: async (email, code) => {
    set({ busy: true, error: null })
    try {
      const data = await api().verifyOtp({ email, code })
      set({
        user: data.user,
        teams: data.teams ?? [],
        currentTeamId: data.current_team_id ?? null,
        busy: false,
      })
    } catch (e) {
      set({ busy: false, error: (e as Error).message })
      throw e
    }
  },

  logout: async () => {
    await api().logout()
    set({ user: null, teams: [], currentTeamId: null })
  },

  setCurrentTeam: async (teamId) => {
    await api().setCurrentTeam(teamId)
    set({ currentTeamId: teamId })
  },

  setWorkspace: (w) => {
    try { localStorage.setItem(WORKSPACE_KEY, w) } catch { /* ignore */ }
    set({ workspace: w })
  },

  clearError: () => set({ error: null }),
}))
