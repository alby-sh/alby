import { contextBridge, ipcRenderer } from 'electron'

// The renderer subscribes to IPC events per-component (per TerminalPanel
// mounts an agent:reattach listener, every IssueListView subscribes to
// issues:live, etc.) and Node's EventEmitter warns at 10 listeners. With a
// dozen+ open tabs that limit gets hit and clutters the console even though
// each component cleans up on unmount. 0 = unlimited.
ipcRenderer.setMaxListeners(0)

interface TaskListParams {
  q?: string
  status?: 'open' | 'done' | 'all'
  stack_id?: string
  env_id?: string
  include_default?: 0 | 1
  per_page?: number
  page?: number
}

const api = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    get: (id: string) => ipcRenderer.invoke('projects:get', id),
    create: (data: unknown) => ipcRenderer.invoke('projects:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('projects:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('projects:delete', id),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke('projects:reorder', orderedIds),
    transfer: (id: string, ownerType: 'user' | 'team', ownerId: string) =>
      ipcRenderer.invoke('projects:transfer', id, ownerType, ownerId)
  },
  stacks: {
    list: (projectId: string) => ipcRenderer.invoke('stacks:list', projectId),
    get: (id: string) => ipcRenderer.invoke('stacks:get', id),
    create: (data: unknown) => ipcRenderer.invoke('stacks:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('stacks:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('stacks:delete', id),
    reorder: (projectId: string, orderedIds: string[]) => ipcRenderer.invoke('stacks:reorder', projectId, orderedIds)
  },
  environments: {
    list: (projectId: string) => ipcRenderer.invoke('environments:list', projectId),
    get: (id: string) => ipcRenderer.invoke('environments:get', id),
    create: (data: unknown) => ipcRenderer.invoke('environments:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('environments:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('environments:delete', id),
    reorder: (projectId: string, orderedIds: string[]) => ipcRenderer.invoke('environments:reorder', projectId, orderedIds),
    enableMonitoring: (id: string) => ipcRenderer.invoke('environments:enable-monitoring', id),
    disableMonitoring: (id: string) => ipcRenderer.invoke('environments:disable-monitoring', id),
    // Reads a private-key file from disk and returns its contents so the
    // renderer can hand it to the "Sync to cloud" upload without pulling
    // the file into a React input (which would leak through React devtools
    // and form state).
    readPrivateKey: (absolutePath: string): Promise<string | null> =>
      ipcRenderer.invoke('environments:read-private-key', absolutePath)
  },
  tasks: {
    list: (environmentId: string) => ipcRenderer.invoke('tasks:list', environmentId),
    listByProject: (projectId: string, params?: TaskListParams) =>
      ipcRenderer.invoke('tasks:by-project', projectId, params),
    listByStack: (stackId: string, params?: TaskListParams) =>
      ipcRenderer.invoke('tasks:by-stack', stackId, params),
    create: (data: unknown) => ipcRenderer.invoke('tasks:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('tasks:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('tasks:delete', id),
    reorder: (environmentId: string, orderedIds: string[]) => ipcRenderer.invoke('tasks:reorder', environmentId, orderedIds)
  },
  audit: {
    project: (projectId: string) => ipcRenderer.invoke('audit:project', projectId),
    record: (payload: {
      project_id: string
      entity_type: string
      entity_id: string
      action: string
      summary?: string
      diff?: unknown
    }) => ipcRenderer.invoke('audit:record', payload)
  },
  agents: {
    list: (taskId: string) => ipcRenderer.invoke('agents:list', taskId),
    listAll: () => ipcRenderer.invoke('agents:list-all'),
    spawn: (taskId: string, agentType?: string, autoInstall?: boolean, initialPrompt?: string) => ipcRenderer.invoke('agents:spawn', taskId, agentType, autoInstall, initialPrompt),
    getContext: (agentId: string) => ipcRenderer.invoke('agents:get-context', agentId),
    kill: (agentId: string) => ipcRenderer.invoke('agents:kill', agentId),
    delete: (agentId: string) => ipcRenderer.invoke('agents:delete', agentId),
    reorder: (orderedIds: string[]) => ipcRenderer.invoke('agents:reorder', orderedIds),
    update: (agentId: string, data: { tab_name?: string }) =>
      ipcRenderer.invoke('agents:update', agentId, data),
    ensureAttached: (agentId: string) => ipcRenderer.invoke('agents:ensure-attached', agentId),
    onReattach: (
      callback: (data: { agentId: string; state: 'connecting' | 'connected' | 'failed'; message?: string }) => void
    ) => {
      const listener = (
        _: unknown,
        payload: { agentId: string; state: 'connecting' | 'connected' | 'failed'; message?: string }
      ) => callback(payload)
      ipcRenderer.on('agent:reattach', listener)
      return () => { ipcRenderer.removeListener('agent:reattach', listener) }
    },
    writeStdin: (agentId: string, data: string) =>
      ipcRenderer.invoke('agents:write-stdin', agentId, data),
    resize: (agentId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('agents:resize', agentId, cols, rows),
    chatSend: (agentId: string, text: string) =>
      ipcRenderer.invoke('agents:chat-send', agentId, text),
    chatHistory: (agentId: string): Promise<Record<string, unknown>[]> =>
      ipcRenderer.invoke('agents:chat-history', agentId),
    chatRestart: (agentId: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('agents:chat-restart', agentId),
    chatDelete: (agentId: string): Promise<void> =>
      ipcRenderer.invoke('agents:chat-delete', agentId),
    onChatEvent: (
      callback: (data: { agentId: string; event: Record<string, unknown> }) => void
    ) => {
      const listener = (
        _: unknown,
        payload: { agentId: string; event: Record<string, unknown> }
      ) => callback(payload)
      ipcRenderer.on('agent:chat-event', listener)
      return () => {
        ipcRenderer.removeListener('agent:chat-event', listener)
      }
    },
    heartbeat: (agentId: string, deltas: { working_delta?: number; viewed_delta?: number }) =>
      ipcRenderer.invoke('agents:heartbeat', agentId, deltas),
    onStdout: (callback: (data: { agentId: string; data: string }) => void) => {
      const listener = (_: unknown, payload: { agentId: string; data: string }) =>
        callback(payload)
      ipcRenderer.on('agent:stdout', listener)
      return () => {
        ipcRenderer.removeListener('agent:stdout', listener)
      }
    },
    onStatusChange: (
      callback: (data: { agentId: string; status: string; exitCode?: number }) => void
    ) => {
      const listener = (
        _: unknown,
        payload: { agentId: string; status: string; exitCode?: number }
      ) => callback(payload)
      ipcRenderer.on('agent:status-change', listener)
      return () => {
        ipcRenderer.removeListener('agent:status-change', listener)
      }
    },
    onDeleted: (callback: (data: { agentId: string }) => void) => {
      const listener = (_: unknown, payload: { agentId: string }) => callback(payload)
      ipcRenderer.on('agent:deleted', listener)
      return () => {
        ipcRenderer.removeListener('agent:deleted', listener)
      }
    },
    onActivity: (
      callback: (data: { agentId: string; activity: string }) => void
    ) => {
      const listener = (
        _: unknown,
        payload: { agentId: string; activity: string }
      ) => callback(payload)
      ipcRenderer.on('agent:activity', listener)
      return () => {
        ipcRenderer.removeListener('agent:activity', listener)
      }
    }
  },
  routines: {
    list: () => ipcRenderer.invoke('routines:list'),
    listByEnv: (envId: string) => ipcRenderer.invoke('routines:list-by-env', envId),
    get: (id: string) => ipcRenderer.invoke('routines:get', id),
    create: (data: unknown) => ipcRenderer.invoke('routines:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('routines:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('routines:delete', id),
    reorder: (envId: string, orderedIds: string[]) => ipcRenderer.invoke('routines:reorder', envId, orderedIds),
    start: (id: string) => ipcRenderer.invoke('routines:start', id),
    stop: (id: string) => ipcRenderer.invoke('routines:stop', id),
    writeStdin: (id: string, data: string) => ipcRenderer.invoke('routines:write-stdin', id, data),
    resize: (id: string, cols: number, rows: number) => ipcRenderer.invoke('routines:resize', id, cols, rows),
    onStatusChange: (
      callback: (data: { routineId: string; running: boolean; exitCode?: number }) => void
    ) => {
      const listener = (
        _: unknown,
        payload: { routineId: string; running: boolean; exitCode?: number }
      ) => callback(payload)
      ipcRenderer.on('routine:status-change', listener)
      return () => { ipcRenderer.removeListener('routine:status-change', listener) }
    },
  },
  ssh: {
    listHosts: () => ipcRenderer.invoke('ssh:list-hosts'),
    testConnection: (envId: string) => ipcRenderer.invoke('ssh:test-connection', envId),
    testPreflight: (params: unknown) => ipcRenderer.invoke('ssh:test-preflight', params),
    connectProject: (projectId: string) => ipcRenderer.invoke('ssh:connect-project', projectId),
    connectionStatus: (envId: string) => ipcRenderer.invoke('ssh:connection-status', envId),
    checkCommand: (envId: string, command: string) => ipcRenderer.invoke('ssh:check-command', envId, command),
    reconnectAll: () => ipcRenderer.invoke('ssh:reconnect-all'),
    onConnectionStatusChanged: (callback: (data: { envId: string; connected: boolean }) => void) => {
      const listener = (_: unknown, payload: { envId: string; connected: boolean }) => callback(payload)
      ipcRenderer.on('ssh:connection-status-changed', listener)
      return () => { ipcRenderer.removeListener('ssh:connection-status-changed', listener) }
    },
  },
  git: {
    status: (envId: string) => ipcRenderer.invoke('git:status', envId),
    diffSummary: (envId: string) => ipcRenderer.invoke('git:diff-summary', envId),
    commitPush: (envId: string, message: string) => ipcRenderer.invoke('git:commit-push', envId, message),
    fetch: (envId: string) => ipcRenderer.invoke('git:fetch', envId),
    pull: (envId: string) => ipcRenderer.invoke('git:pull', envId),
    discard: (envId: string) => ipcRenderer.invoke('git:discard', envId),
    remoteUrl: (envId: string) => ipcRenderer.invoke('git:remote-url', envId),
    log: (envId: string, limit?: number) => ipcRenderer.invoke('git:log', envId, limit),
    changedFiles: (envId: string) => ipcRenderer.invoke('git:changed-files', envId),
    prList: (envId: string, limit?: number) => ipcRenderer.invoke('gh:pr-list', envId, limit),
    runList: (envId: string, limit?: number) => ipcRenderer.invoke('gh:run-list', envId, limit),
    checkGitHubAuth: (envId: string) => ipcRenderer.invoke('git:check-github-auth', envId),
    installGh: (envId: string) => ipcRenderer.invoke('git:install-gh', envId),
    startGitHubAuth: (envId: string) => ipcRenderer.invoke('git:github-auth-start', envId),
    onGitHubAuthComplete: (callback: (data: { envId: string; success: boolean; username?: string; error?: string }) => void) => {
      const listener = (_: unknown, payload: { envId: string; success: boolean; username?: string; error?: string }) => callback(payload)
      ipcRenderer.on('git:github-auth-complete', listener)
      return () => { ipcRenderer.removeListener('git:github-auth-complete', listener) }
    },
  },
  deploy: {
    test: (envId: string) => ipcRenderer.invoke('deploy:test', envId),
    run: (envId: string) => ipcRenderer.invoke('deploy:run', envId),
    dryRun: (envId: string) => ipcRenderer.invoke('deploy:dry-run', envId),
    cancel: (runId: string) => ipcRenderer.invoke('deploy:cancel', runId),
    onInfo: (callback: (data: { runId: string; envId: string; line: string }) => void) => {
      const listener = (_: unknown, payload: { runId: string; envId: string; line: string }) => callback(payload)
      ipcRenderer.on('deploy:info', listener)
      return () => { ipcRenderer.removeListener('deploy:info', listener) }
    },
    onStep: (callback: (data: { runId: string; envId: string; step: { kind: 'pre' | 'pull' | 'post'; index: number; command: string } }) => void) => {
      const listener = (_: unknown, payload: { runId: string; envId: string; step: { kind: 'pre' | 'pull' | 'post'; index: number; command: string } }) => callback(payload)
      ipcRenderer.on('deploy:step', listener)
      return () => { ipcRenderer.removeListener('deploy:step', listener) }
    },
    onData: (callback: (data: { runId: string; envId: string; step: { kind: 'pre' | 'pull' | 'post'; index: number; command: string }; stream: 'stdout' | 'stderr'; data: string }) => void) => {
      const listener = (_: unknown, payload: { runId: string; envId: string; step: { kind: 'pre' | 'pull' | 'post'; index: number; command: string }; stream: 'stdout' | 'stderr'; data: string }) => callback(payload)
      ipcRenderer.on('deploy:data', listener)
      return () => { ipcRenderer.removeListener('deploy:data', listener) }
    },
    onStepDone: (callback: (data: { runId: string; envId: string; step: { kind: 'pre' | 'pull' | 'post'; index: number; command: string }; exitCode: number }) => void) => {
      const listener = (_: unknown, payload: { runId: string; envId: string; step: { kind: 'pre' | 'pull' | 'post'; index: number; command: string }; exitCode: number }) => callback(payload)
      ipcRenderer.on('deploy:step-done', listener)
      return () => { ipcRenderer.removeListener('deploy:step-done', listener) }
    },
    onDone: (callback: (data: { runId: string; envId: string; dryRun: boolean; ok: boolean; exitCode?: number; error?: string; failedAt?: { kind: 'pre' | 'pull' | 'post'; index: number; command: string } }) => void) => {
      const listener = (_: unknown, payload: { runId: string; envId: string; dryRun: boolean; ok: boolean; exitCode?: number; error?: string; failedAt?: { kind: 'pre' | 'pull' | 'post'; index: number; command: string } }) => callback(payload)
      ipcRenderer.on('deploy:done', listener)
      return () => { ipcRenderer.removeListener('deploy:done', listener) }
    },
  },
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value)
  },
  dialog: {
    pickFolder: (title?: string): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pick-folder', title)
  },
  app: {
    // Bring the Alby window to the foreground — used when the user clicks a
    // native notification while the app is hidden / behind other windows.
    focus: () => ipcRenderer.invoke('app:focus'),
  },
  deepLink: {
    /** Subscribe to `alby://issues/<uuid>` events arriving while the app is
     *  already running. Returns an unsubscribe fn. */
    onIssueOpen: (callback: (data: { issueId: string }) => void) => {
      const listener = (_: unknown, payload: { issueId: string }) => callback(payload)
      ipcRenderer.on('deep-link:issue-open', listener)
      return () => { ipcRenderer.removeListener('deep-link:issue-open', listener) }
    },
    /** Drain the queue of deep links that fired before the renderer was
     *  listening (cold-start argv on Win/Linux, or pre-load macOS open-url). */
    consumePending: (): Promise<Array<{ issueId: string }>> =>
      ipcRenderer.invoke('deep-link:consume-pending'),
  },
  notifications: {
    /** Fire a native macOS notification via the main-process Notification API.
     *  Preferred over `new Notification(...)` in the renderer because the DOM
     *  version needs a permission grant that swallows the first event — the
     *  Electron Notification class runs against Notification Center directly.
     *  Click navigates the renderer to the issue detail view. */
    issue: (payload: { title: string; body: string; tag?: string; issueId?: string }) =>
      ipcRenderer.invoke('notifications:issue', payload),
    /** Agent finish / idle notification. Click focuses Alby, opens the
     *  project's sidebar, and selects the specific session. */
    agent: (payload: { title: string; body: string; tag?: string; agentId: string; projectId: string }) =>
      ipcRenderer.invoke('notifications:agent', payload),
    onAgentClick: (cb: (data: { agentId: string; projectId: string }) => void) => {
      const listener = (_: unknown, data: { agentId: string; projectId: string }): void => cb(data)
      ipcRenderer.on('notification:agent-click', listener)
      return () => { ipcRenderer.removeListener('notification:agent-click', listener) }
    },
  },
  teams: {
    list: () => ipcRenderer.invoke('teams:list'),
    get: (id: string) => ipcRenderer.invoke('teams:get', id),
    create: (data: { name: string; avatar_url?: string }) => ipcRenderer.invoke('teams:create', data),
    update: (id: string, data: { name?: string; avatar_url?: string | null }) => ipcRenderer.invoke('teams:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('teams:delete', id),
    invite: (id: string, data: { email?: string; role: string }) => ipcRenderer.invoke('teams:invite', id, data),
    removeMember: (id: string, userId: number) => ipcRenderer.invoke('teams:remove-member', id, userId),
    updateMemberRole: (id: string, userId: number, role: string) =>
      ipcRenderer.invoke('teams:update-member-role', id, userId, role),
    // v0.8.1 — custom team roles.
    listRoles: (teamId: string) => ipcRenderer.invoke('teams:roles:list', teamId),
    createRole: (teamId: string, data: { slug: string; name: string; description?: string | null; capabilities: string[] }) =>
      ipcRenderer.invoke('teams:roles:create', teamId, data),
    updateRole: (teamId: string, roleId: string, data: { name?: string; description?: string | null; capabilities?: string[] }) =>
      ipcRenderer.invoke('teams:roles:update', teamId, roleId, data),
    deleteRole: (teamId: string, roleId: string, reassignTo?: string) =>
      ipcRenderer.invoke('teams:roles:delete', teamId, roleId, reassignTo),
  },
  errors: {
    report: (payload: {
      error: string
      stack?: string
      path?: string
      line?: number
      context?: Record<string, unknown>
    }): void => { ipcRenderer.send('errors:report', payload) }
  },
  updater: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('updater:get-version'),
    check: (): Promise<{ status: string; version?: string; message?: string }> =>
      ipcRenderer.invoke('updater:check'),
    install: (): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('updater:install'),
    onDownloaded: (callback: (data: { version: string }) => void) => {
      const listener = (_: unknown, payload: { version: string }) => callback(payload)
      ipcRenderer.on('updater:update-downloaded', listener)
      return () => { ipcRenderer.removeListener('updater:update-downloaded', listener) }
    },
  },
  auth: {
    current: () => ipcRenderer.invoke('auth:current'),
    oauth: (provider: 'google' | 'microsoft') => ipcRenderer.invoke('auth:oauth', provider),
    register: (data: { email: string; password: string; name: string }) =>
      ipcRenderer.invoke('auth:register', data),
    verifyOtp: (data: { email: string; code: string }) =>
      ipcRenderer.invoke('auth:verify-otp', data),
    loginEmail: (data: { email: string; password: string }) =>
      ipcRenderer.invoke('auth:login-email', data),
    logout: () => ipcRenderer.invoke('auth:logout'),
    setCurrentTeam: (teamId: string | null) => ipcRenderer.invoke('auth:set-current-team', teamId)
  },

  // Error tracking: "apps" are the integrations receiving events from customer SDKs.
  apps: {
    list: (projectId: string) => ipcRenderer.invoke('apps:list', projectId),
    get: (id: string) => ipcRenderer.invoke('apps:get', id),
    create: (projectId: string, data: { name: string; platform?: string }) =>
      ipcRenderer.invoke('apps:create', projectId, data),
    update: (id: string, data: { name?: string; platform?: string; is_active?: boolean }) =>
      ipcRenderer.invoke('apps:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('apps:delete', id),
    rotateKey: (id: string) => ipcRenderer.invoke('apps:rotate-key', id),
    sendTestEvent: (args: { dsn: string; environment?: string }) =>
      ipcRenderer.invoke('apps:send-test-event', args),
  },
  issues: {
    list: (appId: string, filters?: unknown) => ipcRenderer.invoke('issues:list', appId, filters),
    get: (id: string) => ipcRenderer.invoke('issues:get', id),
    listEvents: (id: string, page?: number, perPage?: number) =>
      ipcRenderer.invoke('issue-events:list', id, page, perPage),
    update: (id: string, data: unknown) => ipcRenderer.invoke('issues:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('issues:delete', id),
    create: (appId: string, data: unknown) => ipcRenderer.invoke('issues:create', appId, data),
    listMine: (page?: number, perPage?: number) => ipcRenderer.invoke('issues:list-mine', page, perPage),
    mintResolveUrl: (id: string) => ipcRenderer.invoke('issues:mint-resolve-url', id),
    openCounts: (appIds: string[]) => ipcRenderer.invoke('issues:open-counts', appIds),
    onLive: (callback: (event: unknown) => void) => {
      const listener = (_: unknown, payload: unknown) => callback(payload)
      ipcRenderer.on('issues:live', listener)
      return () => { ipcRenderer.removeListener('issues:live', listener) }
    },
  },
  releases: {
    list: (appId: string) => ipcRenderer.invoke('releases:list', appId),
    create: (appId: string, data: { version: string; environment?: string | null; released_at?: string | null }) =>
      ipcRenderer.invoke('releases:create', appId, data),
  },
  webhooks: {
    list: (appId: string) => ipcRenderer.invoke('webhooks:list', appId),
    create: (appId: string, data: { url: string; events: string[]; is_active?: boolean }) =>
      ipcRenderer.invoke('webhooks:create', appId, data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('webhooks:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('webhooks:delete', id),
    rotateSecret: (id: string) => ipcRenderer.invoke('webhooks:rotate-secret', id),
  },
  broadcast: {
    /** Proxy the /broadcasting/auth POST through main so the browser's CORS
     *  check on localhost dev origins doesn't block Reverb channel auth. */
    authorize: (token: string, socketId: string, channelName: string) =>
      ipcRenderer.invoke('broadcast:authorize', { token, socketId, channelName }),
  },
  ports: {
    /** Return forwarded ports for a single launch agent. Empty array for
     *  non-launch agents and agents whose tunnels were torn down. */
    listByAgent: (agentId: string) => ipcRenderer.invoke('ports:list-by-agent', agentId),
    /** Aggregate of every forwarded port in an env (across all of its
     *  launch agents). Used by the env-level UI badge. */
    listByEnv: (envId: string) => ipcRenderer.invoke('ports:list-by-env', envId),
    /** Push: one entry per local server bound. Comes once per port; the
     *  forwarder also auto-opens the URL in the user's default browser. */
    onPortOpened: (
      callback: (port: {
        agent_id: string
        environment_id: string
        remote_port: number
        local_port: number
        opened_at: string
      }) => void,
    ) => {
      const listener = (_: unknown, payload: {
        agent_id: string
        environment_id: string
        remote_port: number
        local_port: number
        opened_at: string
      }) => callback(payload)
      ipcRenderer.on('ports:port-opened', listener)
      return () => { ipcRenderer.removeListener('ports:port-opened', listener) }
    },
    /** Push: full snapshot of an agent's currently-active ports. Fires on
     *  every open + on dispose (with an empty `ports` array). */
    onChange: (
      callback: (data: {
        agentId: string
        environmentId: string | null
        ports: Array<{
          agent_id: string
          environment_id: string
          remote_port: number
          local_port: number
          opened_at: string
        }>
      }) => void,
    ) => {
      const listener = (_: unknown, payload: {
        agentId: string
        environmentId: string | null
        ports: Array<{
          agent_id: string
          environment_id: string
          remote_port: number
          local_port: number
          opened_at: string
        }>
      }) => callback(payload)
      ipcRenderer.on('ports:change', listener)
      return () => { ipcRenderer.removeListener('ports:change', listener) }
    },
  },
  notificationSubs: {
    list: (appId: string) => ipcRenderer.invoke('notification-subs:list', appId),
    listMine: () => ipcRenderer.invoke('notification-subs:list-mine'),
    upsert: (
      appId: string,
      data: { user_id?: number; triggers: string[]; channels?: { email?: boolean; slack?: boolean; push?: boolean } },
    ) => ipcRenderer.invoke('notification-subs:upsert', appId, data),
    delete: (appId: string, userId: number) =>
      ipcRenderer.invoke('notification-subs:delete', appId, userId),
  },
  slackWebhook: {
    get: () => ipcRenderer.invoke('slack-webhook:get'),
    set: (webhookUrl: string) => ipcRenderer.invoke('slack-webhook:set', webhookUrl),
    delete: () => ipcRenderer.invoke('slack-webhook:delete'),
    presence: (userIds: number[]) => ipcRenderer.invoke('slack-webhook:presence', userIds),
  },
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
