import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type {
  CreateAppDTO,
  CreateIssueDTO,
  CreateReleaseDTO,
  CreateWebhookDTO,
  Issue,
  IssueEvent,
  IssueListFilters,
  NotificationSubscription,
  Release,
  ReportingApp,
  UpdateAppDTO,
  UpdateIssueDTO,
  UpdateWebhookDTO,
  UpsertNotificationSubDTO,
  WebhookConfig,
} from '../../shared/types'

const api = () => window.electronAPI

// ---- Apps ------------------------------------------------------------------

export function useApps(projectId: string | null) {
  return useQuery<ReportingApp[]>({
    queryKey: ['apps', projectId],
    queryFn: () => api().apps.list(projectId!),
    enabled: !!projectId,
  })
}

export function useApp(id: string | null) {
  return useQuery<ReportingApp | null>({
    queryKey: ['app', id],
    queryFn: () => api().apps.get(id!),
    enabled: !!id,
  })
}

export function useCreateApp(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateAppDTO) => api().apps.create(projectId, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['apps', projectId] }) },
  })
}

export function useUpdateApp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateAppDTO }) => api().apps.update(id, data),
    onSuccess: (app) => {
      qc.invalidateQueries({ queryKey: ['apps', app.project_id] })
      qc.invalidateQueries({ queryKey: ['app', app.id] })
    },
  })
}

export function useDeleteApp(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().apps.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['apps', projectId] }) },
  })
}

export function useRotateAppKey() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().apps.rotateKey(id),
    onSuccess: (app) => { qc.invalidateQueries({ queryKey: ['app', app.id] }) },
  })
}

// ---- Issues ----------------------------------------------------------------

interface Paginated<T> {
  data: T[]
  current_page: number
  last_page: number
  total: number
}

export function useIssues(appId: string | null, filters?: IssueListFilters) {
  return useQuery<Paginated<Issue>>({
    queryKey: ['issues', appId, filters ?? null],
    queryFn: () => api().issues.list(appId!, filters),
    enabled: !!appId,
    refetchInterval: 15_000, // Reverb pushes are best-effort; poll as a safety net.
  })
}

interface IssueDetail {
  issue: Issue
  app: Pick<ReportingApp, 'id' | 'name' | 'platform'> & {
    project_id?: string
    environment_id?: string | null
  }
  latest_event: IssueEvent | null
}

export function useIssue(id: string | null) {
  return useQuery<IssueDetail | null>({
    queryKey: ['issue', id],
    queryFn: () => api().issues.get(id!),
    enabled: !!id,
  })
}

export function useIssueEvents(issueId: string | null, page = 1) {
  return useQuery<Paginated<IssueEvent>>({
    queryKey: ['issue-events', issueId, page],
    queryFn: () => api().issues.listEvents(issueId!, page, 25),
    enabled: !!issueId,
  })
}

/**
 * Optimistically decrement the cached open-count for `appId` by `delta`.
 * Used after a local resolve/reopen/delete so the sidebar badge updates
 * at click-time instead of after the server round-trip + invalidation.
 * Runs across every `['issues-open-counts', …]` query the cache has,
 * which is one per distinct project/stack appIds list.
 */
function patchOpenCount(qc: QueryClient, appId: string, delta: number): void {
  const entries = qc.getQueriesData<Record<string, number>>({ queryKey: ['issues-open-counts'] })
  for (const [key, val] of entries) {
    if (!val || !(appId in val)) continue
    qc.setQueryData<Record<string, number>>(key, {
      ...val,
      [appId]: Math.max(0, (val[appId] ?? 0) + delta),
    })
  }
}

/**
 * Optimistically remove `issueId` from every cached issue list for `appId`
 * whose filter is `status: 'open'`. This is what makes a resolved issue
 * disappear from the list the instant the user clicks Resolve — without
 * it, we had a visible lag (sometimes multiple seconds) where the user
 * thought the action hadn't registered.
 */
function patchIssueListRemove(qc: QueryClient, appId: string, issueId: string): void {
  const entries = qc.getQueriesData<{ data: Issue[]; total: number } & Record<string, unknown>>({
    queryKey: ['issues', appId],
  })
  for (const [key, page] of entries) {
    if (!page?.data) continue
    const filtered = page.data.filter((i) => i.id !== issueId)
    if (filtered.length === page.data.length) continue
    qc.setQueryData(key, {
      ...page,
      data: filtered,
      total: Math.max(0, (page.total ?? filtered.length) - 1),
    })
  }
}

export function useUpdateIssue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateIssueDTO }) => api().issues.update(id, data),
    // Optimistic patch: before the server round-trip finishes, pull the
    // resolving issue out of the "open" list and decrement the badge.
    // The server is authoritative — if the PUT fails we invalidate on
    // error to refetch truth.
    onMutate: async ({ id, data }) => {
      if (data.status && data.status !== 'open') {
        // Find the issue's app_id so we can patch the right caches. Pulled
        // from the currently-cached detail (the user is almost always
        // viewing the issue when they click Resolve).
        const detail = qc.getQueryData<IssueDetail>(['issue', id])
        const appId = detail?.issue.app_id
        if (appId) {
          patchIssueListRemove(qc, appId, id)
          patchOpenCount(qc, appId, -1)
        }
      } else if (data.status === 'open') {
        // Reopen: bump counter; the list refetch will drop the row into
        // place. We don't try to splice it into the list cache because we
        // don't have the full row shape on hand here.
        const detail = qc.getQueryData<IssueDetail>(['issue', id])
        const appId = detail?.issue.app_id
        if (appId) patchOpenCount(qc, appId, +1)
      }
    },
    onSuccess: (issue) => {
      // Force a live refetch (not just "mark stale") so the optimistic
      // patch gets replaced by server truth quickly, and any list with
      // a filter we didn't patch (status=resolved / all) catches up too.
      qc.invalidateQueries({ queryKey: ['issues', issue.app_id], refetchType: 'active' })
      qc.invalidateQueries({ queryKey: ['issue', issue.id], refetchType: 'active' })
      qc.invalidateQueries({ queryKey: ['issues-open-counts'], refetchType: 'active' })
    },
    onError: () => {
      // Optimistic patch was wrong — roll back to server truth.
      qc.invalidateQueries({ queryKey: ['issues'] })
      qc.invalidateQueries({ queryKey: ['issues-open-counts'] })
    },
  })
}

/** Manual issue creation. Spiritually a sibling of useUpdateIssue — the
 *  only mutation that can INCREASE open counts on the user's own action.
 *  After success we invalidate the app's list + the global open-counts so
 *  the new row pops into view without waiting for a Reverb push. */
export function useCreateIssue(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateIssueDTO) => api().issues.create(appId, data) as Promise<Issue>,
    onSuccess: (issue) => {
      qc.invalidateQueries({ queryKey: ['issues', issue.app_id], refetchType: 'active' })
      qc.invalidateQueries({ queryKey: ['issues-open-counts'], refetchType: 'active' })
      // The issuer's "My reports" list wants to see it right away.
      qc.invalidateQueries({ queryKey: ['issues-mine'], refetchType: 'active' })
    },
  })
}

/** Issues the current user filed manually, across every app they can
 *  see. Used by the IssuerShell + (future) a "My reports" view for
 *  regular users. Short polling because an issuer filing reports is
 *  high-intent and they want instant feedback. */
export function useMyReportedIssues() {
  return useQuery<Paginated<Issue>>({
    queryKey: ['issues-mine'],
    queryFn: () =>
      (api().issues.listMine() as unknown) as Promise<Paginated<Issue>>,
    refetchInterval: 20_000,
    staleTime: 5_000,
  })
}

export function useDeleteIssue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().issues.delete(id),
    onMutate: async (id) => {
      const detail = qc.getQueryData<IssueDetail>(['issue', id])
      const appId = detail?.issue.app_id
      if (appId) {
        patchIssueListRemove(qc, appId, id)
        if (detail?.issue.status === 'open') patchOpenCount(qc, appId, -1)
      }
    },
    onSuccess: (_void, id) => {
      qc.invalidateQueries({ queryKey: ['issues'], refetchType: 'active' })
      qc.invalidateQueries({ queryKey: ['issue', id] })
      qc.invalidateQueries({ queryKey: ['issues-open-counts'], refetchType: 'active' })
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: ['issues'] })
      qc.invalidateQueries({ queryKey: ['issues-open-counts'] })
    },
  })
}

// ---- Releases --------------------------------------------------------------

export function useReleases(appId: string | null) {
  return useQuery<Release[]>({
    queryKey: ['releases', appId],
    queryFn: () => api().releases.list(appId!),
    enabled: !!appId,
  })
}

export function useCreateRelease(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateReleaseDTO) => api().releases.create(appId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['releases', appId] })
      qc.invalidateQueries({ queryKey: ['issues', appId] }) // server may auto-resolve staged issues
    },
  })
}

// ---- Webhooks --------------------------------------------------------------

export function useWebhooks(appId: string | null) {
  return useQuery<WebhookConfig[]>({
    queryKey: ['webhooks', appId],
    queryFn: () => api().webhooks.list(appId!),
    enabled: !!appId,
  })
}

export function useCreateWebhook(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateWebhookDTO) => api().webhooks.create(appId, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['webhooks', appId] }) },
  })
}

export function useUpdateWebhook(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateWebhookDTO }) => api().webhooks.update(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['webhooks', appId] }) },
  })
}

export function useDeleteWebhook(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().webhooks.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['webhooks', appId] }) },
  })
}

// ---- Notification subscriptions --------------------------------------------

export function useNotificationSubs(appId: string | null) {
  return useQuery<NotificationSubscription[]>({
    queryKey: ['notification-subs', appId],
    queryFn: () => api().notificationSubs.list(appId!),
    enabled: !!appId,
  })
}

export function useUpsertNotificationSub(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: UpsertNotificationSubDTO) => api().notificationSubs.upsert(appId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subs', appId] })
      qc.invalidateQueries({ queryKey: ['notification-subs-mine'] })
    },
  })
}

export function useDeleteNotificationSub(appId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (userId: number) => api().notificationSubs.delete(appId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notification-subs', appId] })
      // My own sub might have been dropped — re-fetch the "mine" cache too
      // so the push-notification gate reflects it immediately.
      qc.invalidateQueries({ queryKey: ['notification-subs-mine'] })
    },
  })
}

/** Return all of the current user's notification subs across every app.
 *  Used by the sync-store to gate native push notifications on issue events
 *  and by the Alby user menu to show a "X apps alert me" summary. */
export function useMyNotificationSubs() {
  return useQuery<Array<Pick<NotificationSubscription, 'app_id' | 'triggers' | 'channels'>>>({
    queryKey: ['notification-subs-mine'],
    queryFn: () => api().notificationSubs.listMine(),
    // Refetch on every focus so a push toggle on another device shows up here.
    refetchOnWindowFocus: 'always',
    staleTime: 60_000,
  })
}

// ---- Sidebar badge counts --------------------------------------------------

export function useOpenIssueCounts(appIds: string[]) {
  return useQuery<Record<string, number>>({
    queryKey: ['issues-open-counts', appIds.join(',')],
    queryFn: async () => api().issues.openCounts(appIds) as unknown as Record<string, number>,
    enabled: appIds.length > 0,
    staleTime: 5_000,
    // Safety-net polling. Reverb push is best-effort and sometimes misses
    // on reconnects / flaky wifi; without this, a resolved issue could
    // stay "visible" in the sidebar badge until the user reloads. 30s is
    // a good compromise between freshness and cloud-request volume for
    // a tiny payload like `{appId: count}`.
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}
