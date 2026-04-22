import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { CheckmarkFilled, Edit, LogoSlack, Email, Close, Notification } from '@carbon/icons-react'
import { useAuthStore } from '../../stores/auth-store'
import { useWorkspaceRole } from '../../hooks/useWorkspaceRole'
import type {
  NotificationSubscription,
  Project,
  UserSlackWebhook,
} from '../../../shared/types'

type Trigger = 'new_issue' | 'regression' | 'every_event'

interface TeamDetail {
  id: string
  name: string
  members: Array<{
    id: number
    name: string
    email: string
    avatar_url: string | null
    pivot: { role: string }
  }>
}

interface AlertsPanelProps {
  /** The app we're editing alerts for — subscriptions are keyed on app_id. */
  appId: string
  /** Project that owns the app. Determines whether we fetch a team's members
   *  or just show the single owner (personal projects have one subscriber). */
  project: Project
}

/**
 * Per-app notifications panel. One row per person who could be notified:
 *  - Personal projects → just the owner (single row)
 *  - Team projects    → every team member
 *
 * Each row has per-channel toggles (email / slack) and a trigger picker
 * (new issue, regression). The current user's row is always editable; other
 * users' rows are editable only when the caller is owner/admin on the
 * workspace. The backend enforces the same rule.
 */
export function AlertsPanel({ appId, project }: AlertsPanelProps): React.ReactElement {
  const qc = useQueryClient()
  const currentUser = useAuthStore((s) => s.user)
  const perms = useWorkspaceRole()
  const canEditOthers = perms.canManageWorkspace

  const { data: subs = [], isLoading: subsLoading } = useQuery<NotificationSubscription[]>({
    queryKey: ['notification-subs', appId],
    queryFn: () => window.electronAPI.notificationSubs.list(appId),
    enabled: !!appId,
  })

  const { data: team } = useQuery<TeamDetail | null>({
    queryKey: ['team', project.owner_id ?? ''],
    queryFn: () =>
      window.electronAPI.teams.get(project.owner_id!) as Promise<TeamDetail | null>,
    enabled: project.owner_type === 'team' && !!project.owner_id,
  })

  // Set of members to show. Personal projects: just the current user (who IS
  // the owner). Team projects: every team member.
  const members = useMemo(() => {
    if (project.owner_type === 'user') {
      if (!currentUser) return []
      return [
        {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email,
          avatar_url: currentUser.avatar_url ?? null,
          role: 'owner',
        },
      ]
    }
    return (team?.members ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      avatar_url: m.avatar_url,
      role: m.pivot.role,
    }))
  }, [project, team, currentUser])

  // Presence map: user_id → has a Slack webhook configured. Lets the UI show
  // a small check next to members who can actually receive Slack alerts.
  const memberIds = useMemo(() => members.map((m) => m.id), [members])
  const { data: slackPresence = {} } = useQuery<Record<number, true>>({
    queryKey: ['slack-webhook-presence', memberIds.sort().join(',')],
    queryFn: () => window.electronAPI.slackWebhook.presence(memberIds),
    enabled: memberIds.length > 0,
  })

  const subByUser = useMemo(() => {
    const m = new Map<number, NotificationSubscription>()
    for (const s of subs) m.set(s.user_id, s)
    return m
  }, [subs])

  const upsert = useMutation({
    mutationFn: (data: {
      user_id: number
      triggers: Trigger[]
      channels: { email: boolean; slack: boolean }
    }) => window.electronAPI.notificationSubs.upsert(appId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-subs', appId] }),
  })
  const remove = useMutation({
    mutationFn: (userId: number) => window.electronAPI.notificationSubs.delete(appId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notification-subs', appId] }),
  })

  // Helper: produce the next state for a toggle + persist. Creates a new sub
  // with sensible defaults when the user hadn't subscribed before.
  const toggleChannel = (userId: number, channel: 'email' | 'slack' | 'push', value: boolean): void => {
    const existing = subByUser.get(userId)
    const triggers: Trigger[] = existing?.triggers?.length
      ? (existing.triggers as Trigger[])
      : ['new_issue', 'regression']
    const channels = {
      email: existing?.channels?.email ?? true,
      slack: existing?.channels?.slack ?? false,
      push: existing?.channels?.push ?? false,
      [channel]: value,
    }
    // If every channel is off, drop the subscription entirely — cleaner than
    // keeping a row with "nothing on".
    if (!channels.email && !channels.slack && !channels.push) {
      remove.mutate(userId)
      return
    }
    upsert.mutate({ user_id: userId, triggers, channels })
  }

  const toggleTrigger = (userId: number, trigger: Trigger, value: boolean): void => {
    const existing = subByUser.get(userId)
    const currentTriggers = new Set<Trigger>((existing?.triggers as Trigger[]) ?? [])
    if (value) currentTriggers.add(trigger)
    else currentTriggers.delete(trigger)
    if (currentTriggers.size === 0) {
      // Can't have zero triggers; removing the last one is equivalent to
      // unsubscribing from the whole app.
      remove.mutate(userId)
      return
    }
    const channels = {
      email: existing?.channels?.email ?? true,
      slack: existing?.channels?.slack ?? false,
    }
    upsert.mutate({
      user_id: userId,
      triggers: Array.from(currentTriggers),
      channels,
    })
  }

  const [slackDialogOpen, setSlackDialogOpen] = useState(false)

  return (
    <div className="py-6 border-b border-neutral-800">
      <div className="flex items-center mb-3">
        <div className="flex-1">
          <h3 className="text-[14px] font-medium text-neutral-100">Alerts</h3>
          <p className="text-[12px] text-neutral-500 mt-0.5">
            Pick who gets pinged when this app fires a new issue or a regression.
            {project.owner_type === 'team' && !canEditOthers && (
              <> You can only edit your own row — ask an owner/admin to change others.</>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSlackDialogOpen(true)}
          className="inline-flex items-center gap-1.5 text-[12px] px-3 h-8 rounded-md border border-neutral-800 bg-neutral-900 hover:bg-neutral-800 text-neutral-200"
        >
          <LogoSlack size={14} />
          {currentUser && slackPresence[currentUser.id]
            ? 'Change Slack webhook'
            : 'Set up Slack webhook'}
        </button>
      </div>

      {subsLoading && <div className="text-[12px] text-neutral-500">Loading…</div>}

      <div className="rounded-md border border-neutral-800 divide-y divide-neutral-900 overflow-hidden">
        <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-500 bg-neutral-950">
          <div>Member</div>
          <div className="w-36 text-center" title="When to notify — new = first time this fingerprint is seen; regr. = a resolved issue started firing again; every = each individual occurrence (noisy).">Triggers</div>
          <div className="w-20 text-center">Email</div>
          <div className="w-20 text-center">Slack</div>
          <div className="w-20 text-center" title="Native desktop notification in Alby. Each user controls their own.">Push</div>
        </div>
        {members.length === 0 && !subsLoading && (
          <div className="px-3 py-6 text-center text-[12px] text-neutral-500">
            No team members to notify yet.
          </div>
        )}
        {members.map((m) => {
          const isSelf = currentUser?.id === m.id
          const editable = isSelf || canEditOthers
          const sub = subByUser.get(m.id) ?? null
          const triggers = new Set<Trigger>((sub?.triggers as Trigger[]) ?? [])
          const channels = {
            email: sub?.channels?.email ?? false,
            slack: sub?.channels?.slack ?? false,
            push: sub?.channels?.push ?? false,
          }
          const slackOnButNoHook = channels.slack && !slackPresence[m.id]
          // Push is intrinsically per-device: only the user themself can
          // toggle their own push preference, because no-one else's desktop
          // is involved. Admins can edit email/slack for others but not push.
          const canEditPush = isSelf

          return (
            <div
              key={m.id}
              className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-3 py-3 items-center"
              data-alerts-row={m.id}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Avatar name={m.name} url={m.avatar_url} />
                <div className="min-w-0">
                  <div className="text-[13px] text-neutral-100 truncate">
                    {m.name}
                    {isSelf && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-neutral-500">
                        you
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-neutral-500 truncate">{m.email}</div>
                </div>
              </div>

              <div className="w-36 flex items-center justify-center gap-1">
                <TriggerToggle
                  label="new"
                  active={triggers.has('new_issue')}
                  disabled={!editable}
                  onChange={(v) => toggleTrigger(m.id, 'new_issue', v)}
                />
                <TriggerToggle
                  label="regr."
                  active={triggers.has('regression')}
                  disabled={!editable}
                  onChange={(v) => toggleTrigger(m.id, 'regression', v)}
                />
                <TriggerToggle
                  label="every"
                  active={triggers.has('every_event')}
                  disabled={!editable}
                  onChange={(v) => toggleTrigger(m.id, 'every_event', v)}
                />
              </div>

              <div className="w-20 flex items-center justify-center">
                <Toggle
                  icon={<Email size={14} />}
                  active={channels.email}
                  disabled={!editable}
                  onChange={(v) => toggleChannel(m.id, 'email', v)}
                  title="Email"
                />
              </div>

              <div className="w-20 flex items-center justify-center">
                <Toggle
                  icon={<LogoSlack size={14} />}
                  active={channels.slack}
                  disabled={!editable}
                  onChange={(v) => toggleChannel(m.id, 'slack', v)}
                  title={
                    slackOnButNoHook
                      ? 'No Slack webhook configured — open the dialog above to add one'
                      : 'Slack'
                  }
                  warn={slackOnButNoHook}
                />
              </div>

              <div className="w-20 flex items-center justify-center">
                <Toggle
                  icon={<Notification size={14} />}
                  active={channels.push}
                  disabled={!canEditPush}
                  onChange={(v) => toggleChannel(m.id, 'push', v)}
                  title={
                    isSelf
                      ? 'Native desktop notification in Alby when an issue fires'
                      : "Only this user can toggle their own push — no-one else's desktop can receive it"
                  }
                />
              </div>
            </div>
          )
        })}
      </div>

      {slackDialogOpen && (
        <SlackWebhookDialog onClose={() => setSlackDialogOpen(false)} />
      )}
    </div>
  )
}

function Avatar({ name, url }: { name: string; url: string | null }): React.ReactElement {
  if (url) {
    return <img src={url} alt={name} className="size-7 rounded-full shrink-0 object-cover" />
  }
  const initial = (name?.[0] ?? '?').toUpperCase()
  return (
    <div className="size-7 rounded-full shrink-0 bg-neutral-800 text-neutral-300 flex items-center justify-center text-[12px] font-medium">
      {initial}
    </div>
  )
}

function Toggle({
  icon,
  active,
  disabled,
  onChange,
  title,
  warn,
}: {
  icon: React.ReactNode
  active: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  title?: string
  warn?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      onClick={() => !disabled && onChange(!active)}
      disabled={disabled}
      className={`inline-flex items-center justify-center size-8 rounded-md border transition-colors ${
        active
          ? warn
            ? 'border-amber-500/60 bg-amber-500/10 text-amber-300'
            : 'border-blue-500/60 bg-blue-500/10 text-blue-300'
          : 'border-neutral-800 bg-neutral-950 text-neutral-500 hover:border-neutral-700'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {icon}
    </button>
  )
}

function TriggerToggle({
  label,
  active,
  disabled,
  onChange,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!active)}
      disabled={disabled}
      className={`text-[10px] uppercase tracking-wider px-1.5 h-6 rounded border ${
        active
          ? 'border-neutral-500 bg-neutral-700 text-neutral-100'
          : 'border-neutral-800 bg-neutral-950 text-neutral-500'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:border-neutral-600'}`}
    >
      {label}
    </button>
  )
}

/**
 * Modal for setting / updating / clearing the current user's Slack incoming
 * webhook URL. The backend only lets users edit their OWN webhook — admins
 * cannot impersonate DM targets, by design.
 */
function SlackWebhookDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const qc = useQueryClient()
  const currentUser = useAuthStore((s) => s.user)
  const { data: existing } = useQuery<UserSlackWebhook | null>({
    queryKey: ['slack-webhook-self'],
    queryFn: () => window.electronAPI.slackWebhook.get(),
  })
  const [url, setUrl] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (existing?.webhook_url) setUrl(existing.webhook_url)
  }, [existing])

  const save = useMutation({
    mutationFn: () => window.electronAPI.slackWebhook.set(url.trim()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['slack-webhook-self'] })
      if (currentUser) {
        qc.invalidateQueries({ queryKey: ['slack-webhook-presence'] })
      }
      onClose()
    },
    onError: (e) => setErr(e instanceof Error ? e.message : String(e)),
  })
  const clear = useMutation({
    mutationFn: () => window.electronAPI.slackWebhook.delete(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['slack-webhook-self'] })
      qc.invalidateQueries({ queryKey: ['slack-webhook-presence'] })
      setUrl('')
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[520px] bg-neutral-950 border border-neutral-800 rounded-xl p-5">
        <div className="flex items-center mb-4">
          <LogoSlack size={18} className="text-neutral-300" />
          <h3 className="ml-2 text-[14px] font-medium text-neutral-100">Slack webhook</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="ml-auto size-7 flex items-center justify-center rounded-md hover:bg-neutral-800 text-neutral-400"
          >
            <Close size={14} />
          </button>
        </div>
        <p className="text-[12px] text-neutral-400 mb-3">
          Paste an incoming-webhook URL from a Slack workspace you manage. The
          webhook points at a single channel (or your DMs) — Alby will POST
          messages there whenever an issue fires and you have Slack enabled for
          that app.
        </p>
        <label className="block text-[11px] uppercase tracking-wider text-neutral-500 mb-1">
          Webhook URL
        </label>
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setErr(null)
          }}
          placeholder="https://hooks.slack.com/services/T…/B…/…"
          className="w-full h-9 px-3 rounded-md bg-neutral-900 border border-neutral-800 text-[13px] text-neutral-100 focus:outline-none focus:border-neutral-600"
        />
        {err && <div className="mt-2 text-[12px] text-red-300">{err}</div>}
        <div className="text-[11px] text-neutral-500 mt-2">
          Get one via <code className="text-neutral-300">slack.com/apps/new</code>{' '}
          → Incoming Webhooks → Add to workspace → pick a channel → copy the URL.
        </div>

        <div className="flex items-center gap-2 mt-5">
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={!url.trim() || save.isPending}
            className="h-9 px-4 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-[13px] font-medium"
          >
            <span className="inline-flex items-center gap-1.5">
              <Edit size={14} />
              {existing ? 'Update' : 'Save'}
            </span>
          </button>
          {existing && (
            <button
              type="button"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
              className="h-9 px-4 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-[13px]"
            >
              Remove
            </button>
          )}
          <div className="flex-1" />
          {existing && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
              <CheckmarkFilled size={12} /> Active
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
