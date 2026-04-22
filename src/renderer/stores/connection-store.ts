import { create } from 'zustand'

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

interface ConnectionState {
  statuses: Map<string, ConnectionStatus>
  errors: Map<string, string>
  connectingProjects: Set<string>

  setStatus: (envId: string, status: ConnectionStatus, error?: string) => void
  connectProject: (projectId: string) => Promise<void>
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  statuses: new Map(),
  errors: new Map(),
  connectingProjects: new Set(),

  setStatus: (envId, status, error) => {
    set((state) => {
      const statuses = new Map(state.statuses)
      const errors = new Map(state.errors)
      statuses.set(envId, status)
      if (error) errors.set(envId, error)
      else errors.delete(envId)
      return { statuses, errors }
    })
  },

  connectProject: async (projectId) => {
    if (get().connectingProjects.has(projectId)) return

    set((s) => {
      const next = new Set(s.connectingProjects)
      next.add(projectId)
      return { connectingProjects: next }
    })

    try {
      // The IPC handler connects all environments and returns results
      const results = await window.electronAPI.ssh.connectProject(projectId) as Record<string, { ok: boolean; error?: string }>

      if (results && typeof results === 'object') {
        for (const [envId, result] of Object.entries(results)) {
          if (result && result.ok) {
            get().setStatus(envId, 'connected')
          } else {
            get().setStatus(envId, 'error', result?.error || 'Connection failed')
          }
        }
      }
    } catch (err) {
      console.error('[ConnectionStore] connectProject failed:', err)
      // Don't set all to error — just log. Individual env results handle their own status.
    }

    set((s) => {
      const next = new Set(s.connectingProjects)
      next.delete(projectId)
      return { connectingProjects: next }
    })
  },
}))
