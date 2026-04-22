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
export type StackPinKey = 'overview' | 'issues' | 'tasks' | 'settings'

export interface UnreadScope {
  projectId?: string
  stackId?: string
  environmentId?: string
  /** Key like `${envId}::${pinKey}` — marks a pin row inside a specific env. */
  envPin?: { environmentId: string; pinKey: EnvPinKey }
  /** Key like `${stackId}::${pinKey}` — marks a pin row inside a specific stack.
   *  Used for Issues (which is stack-level, not env-level) and Tasks. */
  stackPin?: { stackId: string; pinKey: StackPinKey }
  /** Leaf-level: a specific session (agent) row needs attention. */
  agentId?: string
  /** Leaf-level: a specific routine row. */
  routineId?: string
}

interface UnreadEntryWithContext extends UnreadEntry {
  /** Denormalized parent chain so project-level rollups don't need to walk
   *  the env/stack tree at read time. Set when the caller has the info (all
   *  issue/agent/routine events do); left undefined for orphan entries. */
  projectId?: string
  stackId?: string
  environmentId?: string
}

interface PersistedState {
  /** Kept for events that truly only apply at the project level (rare —
   *  most events roll up into stacks / envs / pins). Never auto-cleared by
   *  navigation; project dot visibility is computed as `byProject[id] OR
   *  any sub-scope entry whose projectId === id`. */
  byProject: Record<string, UnreadEntryWithContext>
  byStack: Record<string, UnreadEntryWithContext>
  byEnvironment: Record<string, UnreadEntryWithContext>
  byEnvPin: Record<string, UnreadEntryWithContext>
  byStackPin: Record<string, UnreadEntryWithContext>
  /** Leaf scopes — cleared by clicking the specific row. Parents read-through
   *  these for rollup: byStack / byEnvironment / byEnvPin are effectively
   *  "any leaf with a matching parent id". We keep them denormalized
   *  (explicit byStack entries etc.) for O(1) reads on the hot path; the
   *  leaves are here so a per-row dot can clear itself without nuking the
   *  parent's state. */
  byAgent: Record<string, UnreadEntryWithContext>
  byRoutine: Record<string, UnreadEntryWithContext>
}

interface UnreadState extends PersistedState {
  mark: (scope: UnreadScope, reason: UnreadReason) => void
  clear: (scope: UnreadScope) => void
  clearAll: () => void
  hasProject: (projectId: string) => boolean
  hasStack: (stackId: string) => boolean
  hasEnvironment: (environmentId: string) => boolean
  hasEnvPin: (environmentId: string, pinKey: EnvPinKey) => boolean
  hasStackPin: (stackId: string, pinKey: StackPinKey) => boolean
  hasAgent: (agentId: string) => boolean
  hasRoutine: (routineId: string) => boolean
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
        byStackPin: loadRecord(JSON.stringify(parsed.byStackPin ?? {})),
        byAgent: loadRecord(JSON.stringify(parsed.byAgent ?? {})),
        byRoutine: loadRecord(JSON.stringify(parsed.byRoutine ?? {})),
      }
    }
    // Migrate from v1 (project-only schema) so existing users don't lose
    // their pending unread state on the first app boot after the upgrade.
    const legacy = loadRecord(localStorage.getItem(LEGACY_KEY))
    return {
      byProject: legacy,
      byStack: {}, byEnvironment: {}, byEnvPin: {}, byStackPin: {},
      byAgent: {}, byRoutine: {},
    }
  } catch {
    return {
      byProject: {}, byStack: {}, byEnvironment: {}, byEnvPin: {}, byStackPin: {},
      byAgent: {}, byRoutine: {},
    }
  }
}

function save(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* quota exhaustion / private mode — not fatal */ }
}

function bumpEntry(
  prev: UnreadEntryWithContext | undefined,
  reason: UnreadReason,
  context: { projectId?: string; stackId?: string; environmentId?: string } = {},
): UnreadEntryWithContext {
  const nextReasons = [reason, ...(prev?.reasons ?? []).filter((r) => r !== reason)].slice(0, 10)
  return {
    at: Date.now(),
    reasons: nextReasons,
    projectId: context.projectId ?? prev?.projectId,
    stackId: context.stackId ?? prev?.stackId,
    environmentId: context.environmentId ?? prev?.environmentId,
  }
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
        byStackPin: s.byStackPin,
        byAgent: s.byAgent,
        byRoutine: s.byRoutine,
      }
      let dirty = false
      const ctx = {
        projectId: scope.projectId,
        stackId: scope.stackId ?? scope.stackPin?.stackId,
        environmentId: scope.environmentId ?? scope.envPin?.environmentId,
      }
      if (scope.projectId) {
        next.byProject = { ...s.byProject, [scope.projectId]: bumpEntry(s.byProject[scope.projectId], reason, ctx) }
        dirty = true
      }
      if (scope.stackId) {
        next.byStack = { ...s.byStack, [scope.stackId]: bumpEntry(s.byStack[scope.stackId], reason, ctx) }
        dirty = true
      }
      if (scope.environmentId) {
        next.byEnvironment = { ...s.byEnvironment, [scope.environmentId]: bumpEntry(s.byEnvironment[scope.environmentId], reason, ctx) }
        dirty = true
      }
      if (scope.envPin) {
        const key = `${scope.envPin.environmentId}::${scope.envPin.pinKey}`
        next.byEnvPin = { ...s.byEnvPin, [key]: bumpEntry(s.byEnvPin[key], reason, ctx) }
        dirty = true
      }
      if (scope.stackPin) {
        const key = `${scope.stackPin.stackId}::${scope.stackPin.pinKey}`
        next.byStackPin = { ...s.byStackPin, [key]: bumpEntry(s.byStackPin[key], reason, ctx) }
        dirty = true
      }
      if (scope.agentId) {
        next.byAgent = { ...s.byAgent, [scope.agentId]: bumpEntry(s.byAgent[scope.agentId], reason, ctx) }
        dirty = true
      }
      if (scope.routineId) {
        next.byRoutine = { ...s.byRoutine, [scope.routineId]: bumpEntry(s.byRoutine[scope.routineId], reason, ctx) }
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
        byStackPin: s.byStackPin,
        byAgent: s.byAgent,
        byRoutine: s.byRoutine,
      }
      let dirty = false
      const drop = (rec: Record<string, UnreadEntryWithContext>, key: string): Record<string, UnreadEntryWithContext> | null => {
        if (!rec[key]) return null
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { [key]: _drop, ...rest } = rec
        return rest
      }
      if (scope.projectId) {
        const r = drop(s.byProject, scope.projectId); if (r) { next.byProject = r; dirty = true }
      }
      if (scope.stackId) {
        const r = drop(s.byStack, scope.stackId); if (r) { next.byStack = r; dirty = true }
      }
      if (scope.environmentId) {
        const r = drop(s.byEnvironment, scope.environmentId); if (r) { next.byEnvironment = r; dirty = true }
      }
      if (scope.envPin) {
        const r = drop(s.byEnvPin, `${scope.envPin.environmentId}::${scope.envPin.pinKey}`)
        if (r) { next.byEnvPin = r; dirty = true }
      }
      if (scope.stackPin) {
        const r = drop(s.byStackPin, `${scope.stackPin.stackId}::${scope.stackPin.pinKey}`)
        if (r) { next.byStackPin = r; dirty = true }
      }
      if (scope.agentId) {
        const r = drop(s.byAgent, scope.agentId); if (r) { next.byAgent = r; dirty = true }
      }
      if (scope.routineId) {
        const r = drop(s.byRoutine, scope.routineId); if (r) { next.byRoutine = r; dirty = true }
      }
      if (!dirty) return s
      save(next)
      return next
    })
  },

  clearAll: () => {
    const empty: PersistedState = {
      byProject: {}, byStack: {}, byEnvironment: {}, byEnvPin: {}, byStackPin: {},
      byAgent: {}, byRoutine: {},
    }
    save(empty)
    set(empty)
  },

  /** Project has unread if EITHER a direct project-level entry exists OR any
   *  sub-scope entry (stack / env / pin / agent / routine) denormalized a
   *  matching projectId. This rollup is what keeps the primary-sidebar dot
   *  lit until every dot inside the secondary sidebar has been acknowledged. */
  hasProject: (id) => {
    const s = get()
    if (s.byProject[id]) return true
    const scan = (rec: Record<string, UnreadEntryWithContext>): boolean =>
      Object.values(rec).some((e) => e.projectId === id)
    return scan(s.byStack) || scan(s.byEnvironment) || scan(s.byEnvPin)
      || scan(s.byStackPin) || scan(s.byAgent) || scan(s.byRoutine)
  },
  hasStack: (id) => !!get().byStack[id],
  hasEnvironment: (id) => !!get().byEnvironment[id],
  hasEnvPin: (envId, pinKey) => !!get().byEnvPin[`${envId}::${pinKey}`],
  hasStackPin: (stackId, pinKey) => !!get().byStackPin[`${stackId}::${pinKey}`],
  hasAgent: (id) => !!get().byAgent[id],
  hasRoutine: (id) => !!get().byRoutine[id],
}))
