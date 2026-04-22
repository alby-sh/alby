import { create } from 'zustand'

interface PaneLayout {
  panes: string[]
  sizes: number[]
}

/** Snapshot of "where was I" inside a specific project. Saved per-project
 *  so switching projects preserves each project's own selection + active
 *  agent + stack/task/routine pick. Other pieces of state (envTabs,
 *  pinOrder, collapsedPins, etc.) are already keyed by env/stack id so
 *  they survive project switches automatically. */
interface ProjectSnapshot {
  selectedStackId: string | null
  selectedEnvironmentId: string | null
  selectedTaskId: string | null
  selectedRoutineId: string | null
  activeAgentId: string | null
}

interface PersistedState {
  selectedProjectId: string | null
  selectedStackId: string | null
  selectedEnvironmentId: string | null
  selectedTaskId: string | null
  selectedRoutineId: string | null
  activeAgentId: string | null
  sidebarWidth: number
  expandedProjects: string[]
  /** Legacy field — kept so the JSON parse doesn't break on old state files
   *  written before the env-expansion refactor. Ignored on load. */
  expandedEnvironments?: string[]
  /** Absolute per-env expansion override. */
  envExpandedOverride: Record<string, boolean>
  expandedStacks: string[]
  stackTabs: Record<string, StackTabKey>
  envTabs: Record<string, EnvTabKey>
  paneLayouts: Record<string, PaneLayout>
  pinnedTabs: string[]
  /** `projectId → last-known selection inside that project`. When the user
   *  switches from project A to B, we snapshot A into this map and restore
   *  B's snapshot on top of the runtime selection fields. */
  projectStates: Record<string, ProjectSnapshot>
  /** Per-container ordered pin list. Key = `env:<envId>` / `stack:<stackId>`.
   *  Presence of a key (even with an empty array) means "user has customized
   *  pinning for this container" — absence means "never customized, use the
   *  default pins (e.g. ['sessions'] for operational envs)". */
  pinOrder: Record<string, string[]>
  /** Full pin keys (`env:<envId>:<tabKey>` / `stack:<stackId>:<tabKey>`) that
   *  the user explicitly collapsed. Absence = expanded (default). */
  collapsedPins: string[]
  /** Custom user-renamed labels for pinned tabs. */
  pinLabels: Record<string, string>
  /** Legacy (v0.4.9): unordered set of pinned shortcut keys. Migrated into
   *  `pinOrder` on load. Kept only so the JSON parse doesn't blow up on old
   *  state files. */
  pinnedTabShortcuts?: string[]
}

/** Tabs available when a stack is selected in the sidebar. */
export type StackTabKey = 'overview' | 'issues' | 'tasks' | 'settings'
/** Tabs for an operational env (Sessions is default, Files/Routines/Settings). */
export type EnvTabKey =
  | 'sessions'
  | 'files'
  | 'routines'
  | 'github'
  | 'settings'
  // deploy-env-only tabs
  | 'deploy'
  | 'terminals'

const DB_KEY = 'ui-state'

interface AppState {
  initialized: boolean
  selectedProjectId: string | null
  /** When set (and no env/task/routine selected) the MainArea renders the
   * StackTabsView for this stack (Overview/Issues/Tasks/Settings). */
  selectedStackId: string | null
  selectedEnvironmentId: string | null
  selectedTaskId: string | null
  selectedRoutineId: string | null
  activeAgentId: string | null
  editingProjectSettingsId: string | null
  editingTaskSettingsId: string | null
  editingRoutineSettingsId: string | null
  editingTeamSettingsId: string | null
  editingEnvironmentId: string | null
  editingStackId: string | null
  addingStackForProjectId: string | null
  addingEnvironmentForProjectId: string | null
  addingEnvironmentForStackId: string | null
  activityProjectId: string | null
  issuesProjectId: string | null
  issuesStackId: string | null
  appsProjectId: string | null
  selectedIssueId: string | null
  showAllProjects: boolean
  sidebarWidth: number
  expandedProjects: Set<string>
  /** Legacy XOR-against-default Set; kept for migration but unused.
   *  Replaced by `envExpandedOverride`. */
  expandedEnvironments: Set<string>
  /** Absolute per-env expansion override: present = use the stored
   *  boolean, missing = fall back to the caller's base (hasRunning). */
  envExpandedOverride: Record<string, boolean>
  /** Sidebar collapse state for stack groups. */
  expandedStacks: Set<string>
  /** Per-stack last-selected tab; keyed by stackId. Default = 'overview'. */
  stackTabs: Record<string, StackTabKey>
  /** Per-env last-selected tab; keyed by envId. Default = 'overview' for
   * operational envs, 'deploy' for deploy envs. */
  envTabs: Record<string, EnvTabKey>
  paneLayouts: Record<string, PaneLayout>
  pinnedTabs: Set<string>
  /** Ordered pins per container. Key = `env:<envId>` / `stack:<stackId>`.
   *  Missing key = "never customized" — the UI overlays default pins (e.g.
   *  Sessions for operational envs) on top.  Empty array = "user explicitly
   *  cleared all pins" (including the defaults).
   *  Distinct from `pinnedTabs` which tracks agent panes kept alive on Cmd+W. */
  pinOrder: Record<string, string[]>
  /** Full pin keys (`env:<envId>:<tabKey>` / `stack:<stackId>:<tabKey>`)
   *  that the user explicitly collapsed. Default = expanded. */
  collapsedPins: Set<string>
  /** Custom user-renamed labels for pins, keyed by full pin key. */
  pinLabels: Record<string, string>
  /** `projectId → last-known selection inside that project`. Kept so
   *  switching back to a project restores the env/task/agent the user
   *  was looking at. See `selectProject`. */
  projectStates: Record<string, ProjectSnapshot>

  init: () => Promise<void>
  selectProject: (id: string | null) => void
  selectStack: (id: string | null) => void
  selectEnvironment: (id: string | null) => void
  selectTask: (id: string | null, environmentId?: string) => void
  selectRoutine: (id: string | null, environmentId?: string) => void
  setActiveAgent: (id: string | null) => void
  setSidebarWidth: (w: number) => void
  toggleProjectExpanded: (id: string) => void
  toggleEnvironmentExpanded: (id: string, currentIsExpanded: boolean) => void
  toggleStackExpanded: (id: string) => void
  setStackTab: (stackId: string, tab: StackTabKey) => void
  setEnvTab: (envId: string, tab: EnvTabKey) => void
  savePaneLayout: (taskId: string, layout: PaneLayout | null) => void
  getPaneLayout: (taskId: string) => PaneLayout | null
  togglePinTab: (agentId: string) => void
  isPinned: (agentId: string) => boolean
  /** Toggle `tabKey` in `pinOrder[containerKey]`. Materializes defaults on
   *  first write so that reorders/unpins behave predictably.  */
  togglePin: (containerKey: string, tabKey: string, defaults: string[]) => void
  /** Replace the ordered pin list for a container in one shot (used by drag
   *  reorder + undo). */
  setPinOrder: (containerKey: string, order: string[]) => void
  togglePinCollapsed: (pinKey: string) => void
  setPinLabel: (pinKey: string, label: string | null) => void
  openProjectSettings: (id: string) => void
  closeProjectSettings: () => void
  openTaskSettings: (id: string) => void
  closeTaskSettings: () => void
  openRoutineSettings: (id: string) => void
  closeRoutineSettings: () => void
  openTeamSettings: (id: string) => void
  closeTeamSettings: () => void
  openAddEnvironment: (projectId: string, stackId?: string) => void
  closeAddEnvironment: () => void
  openEditEnvironment: (id: string) => void
  closeEditEnvironment: () => void
  openEditStack: (id: string) => void
  closeEditStack: () => void
  openAddStack: (projectId: string) => void
  closeAddStack: () => void
  openActivity: (projectId: string) => void
  closeActivity: () => void
  openIssues: (projectId: string, stackId?: string | null) => void
  closeIssues: () => void
  openIssueDetail: (issueId: string) => void
  closeIssueDetail: () => void
  openAppsSettings: (projectId: string) => void
  closeAppsSettings: () => void
  openAllProjects: () => void
  closeAllProjects: () => void
}

function save(state: AppState): void {
  const data: PersistedState = {
    selectedProjectId: state.selectedProjectId,
    selectedStackId: state.selectedStackId,
    selectedEnvironmentId: state.selectedEnvironmentId,
    selectedTaskId: state.selectedTaskId,
    selectedRoutineId: state.selectedRoutineId,
    activeAgentId: state.activeAgentId,
    sidebarWidth: state.sidebarWidth,
    expandedProjects: Array.from(state.expandedProjects),
    envExpandedOverride: state.envExpandedOverride,
    expandedStacks: Array.from(state.expandedStacks),
    stackTabs: state.stackTabs,
    envTabs: state.envTabs,
    paneLayouts: state.paneLayouts,
    pinnedTabs: Array.from(state.pinnedTabs),
    pinOrder: state.pinOrder,
    collapsedPins: Array.from(state.collapsedPins),
    pinLabels: state.pinLabels,
    projectStates: state.projectStates
  }
  // Fire and forget - write to DB via IPC
  window.electronAPI.settings.set(DB_KEY, JSON.stringify(data))
}

export const useAppStore = create<AppState>((set, get) => ({
  initialized: false,
  selectedProjectId: null,
  selectedStackId: null,
  selectedEnvironmentId: null,
  selectedTaskId: null,
  selectedRoutineId: null,
  activeAgentId: null,
  editingProjectSettingsId: null,
  editingTaskSettingsId: null,
  editingRoutineSettingsId: null,
  editingTeamSettingsId: null,
  editingEnvironmentId: null,
  editingStackId: null,
  addingStackForProjectId: null,
  addingEnvironmentForProjectId: null,
  addingEnvironmentForStackId: null,
  activityProjectId: null,
  issuesProjectId: null,
  issuesStackId: null,
  appsProjectId: null,
  selectedIssueId: null,
  showAllProjects: false,
  sidebarWidth: 280,
  expandedProjects: new Set(),
  expandedEnvironments: new Set(),
  envExpandedOverride: {},
  expandedStacks: new Set(),
  stackTabs: {},
  envTabs: {},
  paneLayouts: {},
  pinnedTabs: new Set(),
  pinOrder: {},
  collapsedPins: new Set(),
  pinLabels: {},
  projectStates: {},

  init: async () => {
    try {
      const raw = await window.electronAPI.settings.get(DB_KEY)
      if (raw) {
        const data: PersistedState = JSON.parse(raw)
        // On startup: only expand the last active project, collapse everything else
        const lastProject = data.selectedProjectId
        const startExpanded = lastProject ? [lastProject] : []
        set({
          initialized: true,
          selectedProjectId: data.selectedProjectId ?? null,
          selectedStackId: data.selectedStackId ?? null,
          selectedEnvironmentId: data.selectedEnvironmentId ?? null,
          selectedTaskId: data.selectedTaskId ?? null,
          selectedRoutineId: data.selectedRoutineId ?? null,
          activeAgentId: data.activeAgentId ?? null,
          sidebarWidth: data.sidebarWidth ?? 280,
          expandedProjects: new Set(startExpanded),
          expandedEnvironments: new Set(data.expandedEnvironments ?? []),
          envExpandedOverride: data.envExpandedOverride ?? {},
          expandedStacks: new Set(data.expandedStacks ?? []),
          stackTabs: data.stackTabs ?? {},
          envTabs: data.envTabs ?? {},
          paneLayouts: data.paneLayouts ?? {},
          pinnedTabs: new Set(data.pinnedTabs ?? []),
          // One-shot migration from v0.4.9 shape: an unordered Set of full
          // shortcut keys → per-container ordered lists. We drop the legacy
          // field on the next save().
          pinOrder: (() => {
            const out: Record<string, string[]> = { ...(data.pinOrder ?? {}) }
            if (!data.pinOrder && Array.isArray(data.pinnedTabShortcuts)) {
              for (const key of data.pinnedTabShortcuts) {
                const lastColon = key.lastIndexOf(':')
                if (lastColon < 0) continue
                const container = key.slice(0, lastColon)
                const tab = key.slice(lastColon + 1)
                if (!out[container]) out[container] = []
                if (!out[container].includes(tab)) out[container].push(tab)
              }
            }
            return out
          })(),
          collapsedPins: new Set(data.collapsedPins ?? []),
          pinLabels: data.pinLabels ?? {},
          projectStates: data.projectStates ?? {}
        })
      } else {
        set({ initialized: true })
      }
    } catch {
      set({ initialized: true })
    }
  },

  selectProject: (id) => {
    set((state) => {
      // Re-clicking the same project: no-op — don't wipe the current live
      // selection with a stale snapshot. The user's sidebar click is just
      // redundant in that case.
      if (id === state.selectedProjectId) return {}
      // Snapshot the current project's selection before we switch, so that
      // coming back to it lands the user on the same env / task / agent
      // they were last looking at. Then restore the new project's own
      // snapshot (or reset to no selection if the project has never been
      // opened in this install).
      const prevId = state.selectedProjectId
      const nextStates = { ...state.projectStates }
      if (prevId) {
        nextStates[prevId] = {
          selectedStackId: state.selectedStackId,
          selectedEnvironmentId: state.selectedEnvironmentId,
          selectedTaskId: state.selectedTaskId,
          selectedRoutineId: state.selectedRoutineId,
          activeAgentId: state.activeAgentId,
        }
      }
      const restore: ProjectSnapshot = (id && nextStates[id]) || {
        selectedStackId: null,
        selectedEnvironmentId: null,
        selectedTaskId: null,
        selectedRoutineId: null,
        activeAgentId: null,
      }
      return {
        selectedProjectId: id,
        projectStates: nextStates,
        selectedStackId: restore.selectedStackId,
        selectedEnvironmentId: restore.selectedEnvironmentId,
        selectedTaskId: restore.selectedTaskId,
        selectedRoutineId: restore.selectedRoutineId,
        activeAgentId: restore.activeAgentId,
      }
    })
    // Clear the unread-activity dot for the project we just entered. This
    // runs outside the set() so we don't couple app-store to unread-store
    // state shape — dynamic import avoids an import cycle (unread-store
    // doesn't import app-store, but sync-store imports both and the build
    // would choke if this file tried to pull it eagerly at module load).
    if (id) {
      import('./unread-store').then(({ useUnreadStore }) => {
        useUnreadStore.getState().clear({ projectId: id })
      }).catch(() => { /* ignore */ })
    }
    save(get())
  },
  selectStack: (id) => {
    set({
      selectedStackId: id,
      // A stack is focused: clear env/task/routine (MainArea routes to
      // StackTabsView when only stack is set). Also clear full-page overlays.
      selectedEnvironmentId: null,
      selectedTaskId: null,
      selectedRoutineId: null,
      activeAgentId: null,
      issuesProjectId: null,
      issuesStackId: null,
      selectedIssueId: null,
      appsProjectId: null,
      activityProjectId: null,
      showAllProjects: false,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      editingEnvironmentId: null,
      editingStackId: null,
      addingStackForProjectId: null,
      addingEnvironmentForProjectId: null,
    })
    if (id) {
      import('./unread-store').then(({ useUnreadStore }) => {
        useUnreadStore.getState().clear({ stackId: id })
      }).catch(() => { /* ignore */ })
    }
    save(get())
  },
  selectEnvironment: (id) => {
    set({
      selectedEnvironmentId: id,
      // Env is focused: drop task/routine, drop stack-as-focus, clear overlays.
      selectedStackId: null,
      selectedTaskId: null,
      selectedRoutineId: null,
      activeAgentId: null,
      issuesProjectId: null,
      issuesStackId: null,
      selectedIssueId: null,
      appsProjectId: null,
      activityProjectId: null,
      showAllProjects: false,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      editingEnvironmentId: null,
      editingStackId: null,
      addingStackForProjectId: null,
      addingEnvironmentForProjectId: null,
    })
    if (id) {
      import('./unread-store').then(({ useUnreadStore }) => {
        useUnreadStore.getState().clear({ environmentId: id })
      }).catch(() => { /* ignore */ })
    }
    save(get())
  },
  selectTask: (id, environmentId) => {
    const update: Partial<AppState> = {
      selectedTaskId: id,
      selectedRoutineId: null,
      selectedStackId: null,
      // Close every settings / overlay view — users expect sidebar navigation
      // to dismiss any open settings page, not just the project one.
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      editingEnvironmentId: null,
      editingStackId: null,
      addingStackForProjectId: null,
      addingEnvironmentForProjectId: null,
      issuesProjectId: null,
      issuesStackId: null,
      selectedIssueId: null,
      appsProjectId: null,
      activityProjectId: null,
      showAllProjects: false,
    }
    if (environmentId) update.selectedEnvironmentId = environmentId
    set(update)
    save(get())
  },
  selectRoutine: (id, environmentId) => {
    const update: Partial<AppState> = {
      selectedRoutineId: id,
      selectedTaskId: null,
      selectedStackId: null,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      editingEnvironmentId: null,
      editingStackId: null,
      addingStackForProjectId: null,
      addingEnvironmentForProjectId: null,
      issuesProjectId: null,
      issuesStackId: null,
      selectedIssueId: null,
      appsProjectId: null,
      activityProjectId: null,
      showAllProjects: false,
    }
    if (environmentId) update.selectedEnvironmentId = environmentId
    set(update)
    save(get())
  },
  setActiveAgent: (id) => {
    set({ activeAgentId: id })
    save(get())
  },
  setSidebarWidth: (w) => {
    set({ sidebarWidth: w })
    save(get())
  },
  toggleProjectExpanded: (id) => {
    set((state) => {
      const next = new Set(state.expandedProjects)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      // Track last active project when expanding
      const update: Partial<AppState> = { expandedProjects: next }
      if (next.has(id)) update.selectedProjectId = id
      return update
    })
    save(get())
  },
  toggleEnvironmentExpanded: (id, currentIsExpanded) => {
    // The previous impl XOR-flipped membership in a Set against a moving
    // default (hasRunning), which caused envs to collapse the moment a
    // new session was launched inside them: the base flipped true, the
    // XOR inverted, and the row closed under the user's cursor.
    //
    // We now store an ABSOLUTE override keyed by env id: true = user
    // wants it expanded, false = user wants it collapsed. The caller
    // passes the current *visible* expansion so the toggle always flips
    // what the user sees, regardless of how that state was derived.
    set((state) => ({
      envExpandedOverride: { ...state.envExpandedOverride, [id]: !currentIsExpanded },
    }))
    save(get())
  },
  toggleStackExpanded: (id) => {
    set((state) => {
      const next = new Set(state.expandedStacks)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expandedStacks: next }
    })
    save(get())
  },
  setStackTab: (stackId, tab) => {
    set((state) => ({ stackTabs: { ...state.stackTabs, [stackId]: tab } }))
    // Clicking a stack pin (Overview / Issues / Tasks / Settings) clears its
    // unread dot — same pattern as setEnvTab.
    import('./unread-store').then(({ useUnreadStore }) => {
      useUnreadStore.getState().clear({ stackPin: { stackId, pinKey: tab } })
    }).catch(() => { /* ignore */ })
    save(get())
  },
  setEnvTab: (envId, tab) => {
    set((state) => ({ envTabs: { ...state.envTabs, [envId]: tab } }))
    // Clicking a pin row clears its unread dot — the dot's whole job is to
    // tell you "there's something new here", and you just acknowledged it.
    import('./unread-store').then(({ useUnreadStore }) => {
      useUnreadStore.getState().clear({ envPin: { environmentId: envId, pinKey: tab } })
    }).catch(() => { /* ignore */ })
    save(get())
  },
  savePaneLayout: (taskId, layout) => {
    set((state) => {
      const next = { ...state.paneLayouts }
      if (layout && layout.panes.length > 1) {
        next[taskId] = layout
      } else {
        delete next[taskId]
      }
      return { paneLayouts: next }
    })
    save(get())
  },
  getPaneLayout: (taskId) => {
    return get().paneLayouts[taskId] || null
  },
  togglePinTab: (agentId) => {
    set((state) => {
      const next = new Set(state.pinnedTabs)
      if (next.has(agentId)) next.delete(agentId)
      else next.add(agentId)
      return { pinnedTabs: next }
    })
    save(get())
  },
  isPinned: (agentId) => {
    return get().pinnedTabs.has(agentId)
  },
  togglePin: (containerKey, tabKey, defaults) => {
    set((state) => {
      // Materialize defaults on first touch so downstream reorders/removes
      // operate on a stable explicit list.
      const current = state.pinOrder[containerKey] ?? defaults
      const next = current.includes(tabKey)
        ? current.filter((t) => t !== tabKey)
        : [...current, tabKey]
      return { pinOrder: { ...state.pinOrder, [containerKey]: next } }
    })
    save(get())
  },
  setPinOrder: (containerKey, order) => {
    set((state) => ({
      pinOrder: { ...state.pinOrder, [containerKey]: order },
    }))
    save(get())
  },
  togglePinCollapsed: (pinKey) => {
    set((state) => {
      const next = new Set(state.collapsedPins)
      if (next.has(pinKey)) next.delete(pinKey)
      else next.add(pinKey)
      return { collapsedPins: next }
    })
    save(get())
  },
  setPinLabel: (pinKey, label) => {
    set((state) => {
      const next = { ...state.pinLabels }
      if (label && label.trim()) next[pinKey] = label.trim()
      else delete next[pinKey]
      return { pinLabels: next }
    })
    save(get())
  },
  openProjectSettings: (id) => {
    set({ editingProjectSettingsId: id, editingTaskSettingsId: null, editingRoutineSettingsId: null, selectedProjectId: id, selectedIssueId: null })
    save(get())
  },
  closeProjectSettings: () => {
    set({ editingProjectSettingsId: null })
    save(get())
  },
  openTaskSettings: (id) => {
    set({ editingTaskSettingsId: id, editingProjectSettingsId: null, editingRoutineSettingsId: null, selectedIssueId: null })
    save(get())
  },
  closeTaskSettings: () => {
    set({ editingTaskSettingsId: null })
    save(get())
  },
  openRoutineSettings: (id) => {
    set({ editingRoutineSettingsId: id, editingProjectSettingsId: null, editingTaskSettingsId: null, selectedIssueId: null })
    save(get())
  },
  closeRoutineSettings: () => {
    set({ editingRoutineSettingsId: null })
    save(get())
  },
  openTeamSettings: (id) => {
    set({
      editingTeamSettingsId: id,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      selectedIssueId: null,
    })
  },
  closeTeamSettings: () => {
    set({ editingTeamSettingsId: null })
  },
  openAddEnvironment: (projectId, stackId) => {
    set({
      addingEnvironmentForProjectId: projectId,
      addingEnvironmentForStackId: stackId ?? null,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      selectedProjectId: projectId,
    })
    save(get())
  },
  closeAddEnvironment: () => {
    set({ addingEnvironmentForProjectId: null, addingEnvironmentForStackId: null })
    save(get())
  },
  openEditEnvironment: (id) => {
    set({
      editingEnvironmentId: id,
      addingEnvironmentForProjectId: null,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      selectedIssueId: null,
    })
    save(get())
  },
  closeEditEnvironment: () => {
    set({ editingEnvironmentId: null })
    save(get())
  },
  openEditStack: (id) => {
    set({
      editingStackId: id,
      editingEnvironmentId: null,
      addingEnvironmentForProjectId: null,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      selectedIssueId: null,
    })
    save(get())
  },
  closeEditStack: () => {
    set({ editingStackId: null })
    save(get())
  },
  openAddStack: (projectId) => {
    set({
      addingStackForProjectId: projectId,
      editingStackId: null,
      editingEnvironmentId: null,
      addingEnvironmentForProjectId: null,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      selectedProjectId: projectId,
    })
    save(get())
  },
  closeAddStack: () => {
    set({ addingStackForProjectId: null })
    save(get())
  },
  openActivity: (projectId) => {
    set({
      activityProjectId: projectId,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      selectedIssueId: null,
    })
  },
  closeActivity: () => {
    set({ activityProjectId: null })
  },
  openIssues: (projectId, stackId) => {
    set({
      issuesProjectId: projectId,
      issuesStackId: stackId ?? null,
      appsProjectId: null,
      selectedIssueId: null,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      activityProjectId: null,
    })
  },
  closeIssues: () => {
    set({ issuesProjectId: null, issuesStackId: null, selectedIssueId: null })
  },
  openIssueDetail: (issueId) => {
    set({ selectedIssueId: issueId })
  },
  closeIssueDetail: () => {
    set({ selectedIssueId: null })
  },
  openAppsSettings: (projectId) => {
    set({
      appsProjectId: projectId,
      issuesProjectId: null,
      selectedIssueId: null,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      editingTeamSettingsId: null,
      activityProjectId: null,
    })
  },
  closeAppsSettings: () => {
    set({ appsProjectId: null })
  },
  openAllProjects: () => {
    set({
      showAllProjects: true,
      editingProjectSettingsId: null,
      editingTaskSettingsId: null,
      editingRoutineSettingsId: null,
      selectedIssueId: null,
    })
  },
  closeAllProjects: () => {
    set({ showAllProjects: false })
  }
}))
