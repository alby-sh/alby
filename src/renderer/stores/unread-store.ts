import { create } from 'zustand'

/**
 * Per-project "something new happened" tracker. Like Slack's per-channel
 * unread dot: when a Reverb event lands for a project the user isn't
 * currently looking at, we mark that project as having unread activity so
 * a red dot shows on the project icon in the sidebar / icon-nav. Clears
 * when the user selects the project.
 *
 * Semantics are deliberately coarse (a single boolean per project, plus a
 * short list of "what changed" reasons for tooltip). Live-updated lists
 * inside the project show the actual changes — we don't need to duplicate
 * that state here.
 *
 * Persisted to localStorage so the dot survives a window close / crash —
 * users expect a ping they didn't see to still be pingable after a reboot.
 */

type UnreadReason =
  | 'issue.created'
  | 'issue.regression'
  | 'agent.finished'
  | 'agent.activity'
  | 'chat.reply'
  | 'task.updated'
  | 'routine.finished'

interface ProjectUnread {
  /** ms since epoch of the latest trigger; also used for sort stability. */
  at: number
  /** Ordered list of recent reasons (last 10). First = most recent. */
  reasons: UnreadReason[]
}

interface UnreadState {
  byProject: Record<string, ProjectUnread>
  mark: (projectId: string, reason: UnreadReason) => void
  clear: (projectId: string) => void
  clearAll: () => void
  hasUnread: (projectId: string) => boolean
}

const STORAGE_KEY = 'alby:unread-activity-v1'

function load(): Record<string, ProjectUnread> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    // Light validation — tolerate schema drift across versions.
    const out: Record<string, ProjectUnread> = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const at = (v as { at?: number }).at
      const reasons = (v as { reasons?: unknown }).reasons
      if (typeof at !== 'number') continue
      out[id] = {
        at,
        reasons: Array.isArray(reasons) ? (reasons.filter((r) => typeof r === 'string') as UnreadReason[]) : [],
      }
    }
    return out
  } catch {
    return {}
  }
}

function save(state: Record<string, ProjectUnread>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* quota exhaustion / private mode — not fatal */ }
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  byProject: load(),

  mark: (projectId, reason) => {
    if (!projectId) return
    set((s) => {
      const prev = s.byProject[projectId]
      const nextReasons = [reason, ...(prev?.reasons ?? []).filter((r) => r !== reason)].slice(0, 10)
      const next: Record<string, ProjectUnread> = {
        ...s.byProject,
        [projectId]: { at: Date.now(), reasons: nextReasons },
      }
      save(next)
      return { byProject: next }
    })
  },

  clear: (projectId) => {
    set((s) => {
      if (!s.byProject[projectId]) return s
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [projectId]: _removed, ...rest } = s.byProject
      save(rest)
      return { byProject: rest }
    })
  },

  clearAll: () => {
    save({})
    set({ byProject: {} })
  },

  hasUnread: (projectId) => !!get().byProject[projectId],
}))
