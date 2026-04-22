import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  CreateAppDTO,
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

export function useUpdateIssue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateIssueDTO }) => api().issues.update(id, data),
    onSuccess: (issue) => {
      qc.invalidateQueries({ queryKey: ['issues', issue.app_id] })
      qc.invalidateQueries({ queryKey: ['issue', issue.id] })
      // Resolving or reopening flips the open-count. Previous revision didn't
      // invalidate this, so the sidebar badge would stay stale until the next
      // 30-second refresh (and after that hook got migrated to React Query,
      // until the next forced refetch). Invalidate here + sync-store also
      // invalidates on Reverb so other devices pick up the change.
      qc.invalidateQueries({ queryKey: ['issues-open-counts'] })
    },
  })
}

export function useDeleteIssue() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api().issues.delete(id),
    onSuccess: (_void, id) => {
      qc.invalidateQueries({ queryKey: ['issues'] })
      qc.invalidateQueries({ queryKey: ['issue', id] })
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
  })
}
