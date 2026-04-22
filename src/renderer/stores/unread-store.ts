import { create } from 'zustand'

/**
 * Hierarchical "something new happened" tracker.
 *
 * Red-dot indicators in the sidebar need to cascade: a single event (say, a
 * new issue in an app under stack S in project P) should light up:
 *   - the project icon in the primary sidebar (so the user sees it from any
 *     other project),
 *   - the stack header in the secondary sidebar (so they spot it inside the
 *     right project),
 *   - the env inside that stack (when the event is scoped there — e.g. an
 *     agent finished),
 *   - the specific pin row ("Issues" / "Sessions" / "Routines") inside the
 *     env, so they know which pane to open.
 *
 * We keep a separate map per scope. `mark()` takes a partial scope and
 * stamps every non-undefined id. `clear()` reciprocally wipes only the ids
 * you pass — navigating into a project clears the project dot but leaves
 * deeper dots intact until the user drills into them.
 *
 * Persisted to localStorage so a ping survives a window close / reboot.
 */

export type UnreadReason =
  | 'issue.created'
  | 'issue.regression'
  | 'agent.finished'
  | 'agent.activity'
  | 'chat.reply'
  | 'task.updated'
  | 'routine.finished'

interface UnreadEntry {
  /** ms since epoch of the latest trigger. */
  at: number
  /** Ordered list of recent reasons (last 10). First = most recent. */
  reasons: UnreadReason[]
}

export type EnvPinKey = 'sessions' | 'terminals' | 'routines' | 'files' | 'github' | 'deploy' | 'settings'

export interface UnreadScope {
  projectId?: string
  stackId?: string
  environmentId?: string
  /** Key like `${envId}::${pinKey}` — marks a pin row inside a specific env. */
  envPin?: { environmentId: string; pinKey: EnvPinKey }
}

interface PersistedState {
  byProject: Record<string, UnreadEntry>
  byStack: Record<string, UnreadEntry>
  byEnvironment: Record<string, UnreadEntry>
  byEnvPin: Record<string, UnreadEntry>
}

interface UnreadState extends PersistedState {
  mark: (scope: UnreadScope, reason: UnreadReason) => void
  clear: (scope: UnreadScope) => void
  clearAll: () => void
  hasProject: (projectId: string) => boolean
  hasStack: (stackId: string) => boolean
  hasEnvironment: (environmentId: string) => boolean
  hasEnvPin: (environmentId: string, pinKey: EnvPinKey) => boolean
}

const STORAGE_KEY = 'alby:unread-activity-v2'
const LEGACY_KEY = 'alby:unread-activity-v1'

function loadRecord(raw: string | null): Record<string, UnreadEntry> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, UnreadEntry> = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const at = (v as { at?: number }).at
      const reasons = (v as { reasons?: unknown }).reasons
      if (typeof at !== 'number') continue
      out[id] = {
        at,
        reasons: Array.isArray(reasons)
          ? (reasons.filter((r) => typeof r === 'string') as UnreadReason[])
          : [],
      }
    }
    return out
  } catch {
    return {}
  }
}

function loadAll(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedState>
      return {
        byProject: loadRecord(JSON.stringify(parsed.byProject ?? {})),
        byStack: loadRecord(JSON.stringify(parsed.byStack ?? {})),
        byEnvironment: loadRecord(JSON.stringify(parsed.byEnvironment ?? {})),
        byEnvPin: loadRecord(JSON.stringify(parsed.byEnvPin ?? {})),
      }
    }
    // Migrate from v1 (project-only schema) so existing users don't lose
    // their pending unread state on the first app boot after the upgrade.
    const legacy = loadRecord(localStorage.getItem(LEGACY_KEY))
    return { byProject: legacy, byStack: {}, byEnvironment: {}, byEnvPin: {} }
  } catch {
    return { byProject: {}, byStack: {}, byEnvironment: {}, byEnvPin: {} }
  }
}

function save(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* quota exhaustion / private mode — not fatal */ }
}

function bumpEntry(prev: UnreadEntry | undefined, reason: UnreadReason): UnreadEntry {
  const nextReasons = [reason, ...(prev?.reasons ?? []).filter((r) => r !== reason)].slice(0, 10)
  return { at: Date.now(), reasons: nextReasons }
}

export const useUnreadStore = create<UnreadState>((set, get) => ({
  ...loadAll(),

  mark: (scope, reason) => {
    set((s) => {
      const next: PersistedState = {
        byProject: s.byProject,
        byStack: s.byStack,
        byEnvironment: s.byEnvironment,
        byEnvPin: s.byEnvPin,
      }
      let dirty = false
      if (scope.projectId) {
        next.byProject = { ...s.byProject, [scope.projectId]: bumpEntry(s.byProject[scope.projectId], reason) }
        dirty = true
      }
      if (scope.stackId) {
        next.byStack = { ...s.byStack, [scope.stackId]: bumpEntry(s.byStack[scope.stackId], reason) }
        dirty = true
      }
      if (scope.environmentId) {
        next.byEnvironment = { ...s.byEnvironment, [scope.environmentId]: bumpEntry(s.byEnvironment[scope.environmentId], reason) }
        dirty = true
      }
      if (scope.envPin) {
        const key = `${scope.envPin.environmentId}::${scope.envPin.pinKey}`
        next.byEnvPin = { ...s.byEnvPin, [key]: bumpEntry(s.byEnvPin[key], reason) }
        dirty = true
      }
      if (!dirty) return s
      save(next)
      return next
    })
  },

  clear: (scope) => {
    set((s) => {
      const next: PersistedState = {
        byProject: s.byProject,
        byStack: s.byStack,
        byEnvironment: s.byEnvironment,
        byEnvPin: s.byEnvPin,
      }
      let dirty = false
      if (scope.projectId && s.byProject[scope.projectId]) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [scope.projectId]: _drop, ...rest } = s.byProject
        next.byProject = rest
        dirty = true
      }
      if (scope.stackId && s.byStack[scope.stackId]) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [scope.stackId]: _drop, ...rest } = s.byStack
        next.byStack = rest
        dirty = true
      }
      if (scope.environmentId && s.byEnvironment[scope.environmentId]) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [scope.environmentId]: _drop, ...rest } = s.byEnvironment
        next.byEnvironment = rest
        dirty = true
      }
      if (scope.envPin) {
        const key = `${scope.envPin.environmentId}::${scope.envPin.pinKey}`
        if (s.byEnvPin[key]) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { [key]: _drop, ...rest } = s.byEnvPin
          next.byEnvPin = rest
          dirty = true
        }
      }
      if (!dirty) return s
      save(next)
      return next
    })
  },

  clearAll: () => {
    const empty: PersistedState = { byProject: {}, byStack: {}, byEnvironment: {}, byEnvPin: {} }
    save(empty)
    set(empty)
  },

  hasProject: (id) => !!get().byProject[id],
  hasStack: (id) => !!get().byStack[id],
  hasEnvironment: (id) => !!get().byEnvironment[id],
  hasEnvPin: (envId, pinKey) => !!get().byEnvPin[`${envId}::${pinKey}`],
}))
