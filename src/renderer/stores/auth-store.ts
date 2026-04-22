import { create } from 'zustand'

export interface AuthUser {
  id: number
  name: string
  email: string
  avatar_url: string | null
}

export type WorkspaceRole = 'owner' | 'admin' | 'developer' | 'viewer' | 'analyst' | 'member'

export interface AuthTeam {
  id: string
  name: string
  slug: string
  avatar_url: string | null
  role: WorkspaceRole
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
