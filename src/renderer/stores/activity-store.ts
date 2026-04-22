import { create } from 'zustand'

type Activity = 'idle' | 'working'

interface ActivityState {
  // agentId -> activity
  activities: Map<string, Activity>
  setActivity: (agentId: string, activity: Activity) => void
  removeActivity: (agentId: string) => void
}

export const useActivityStore = create<ActivityState>((set) => ({
  activities: new Map(),
  setActivity: (agentId, activity) =>
    set((state) => {
      const next = new Map(state.activities)
      next.set(agentId, activity)
      return { activities: next }
    }),
  removeActivity: (agentId) =>
    set((state) => {
      const next = new Map(state.activities)
      next.delete(agentId)
      return { activities: next }
    })
}))
