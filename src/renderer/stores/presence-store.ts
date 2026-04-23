import { create } from 'zustand'
import { useEffect } from 'react'
import type Pusher from 'pusher-js'
import { useSyncStore } from './sync-store'
import { useAuthStore } from './auth-store'
import { useAppStore } from './app-store'

export interface PresenceUser {
  id: number
  name: string
  avatar_url: string | null
  /** Pusher's per-socket user info — lets the same user on multiple devices
   *  show up as distinct entries (so you see "me on desktop" + "me on laptop"
   *  instead of a single avatar that hides one of them). */
  socket_id?: string
}

/** Every sidebar level — project icon, stack header, env row, task row,
 *  agent/session tab, routine — has its own presence channel so teammates see
 *  each other live as they navigate. All of these need a matching
 *  `Broadcast::channel('presence-<entity>.{id}', …)` authorisation callback
 *  on the Laravel backend (returns `{ id, name, avatar_url }` for the user
 *  if they can access the entity, `false` otherwise). */
export type PresenceEntity =
  | 'project'
  | 'stack'
  | 'environment'
  | 'task'
  | 'agent'
  | 'routine'

interface PresenceState {
  /** Key: `${entity}.${id}` (e.g. `agent.abc123`). Values: everyone currently
   *  subscribed to that presence channel, the local user included. */
  viewers: Map<string, PresenceUser[]>
  _channels: Map<string, unknown>

  join: (entity: PresenceEntity, id: string) => void
  leave: (entity: PresenceEntity, id: string) => void
  clear: () => void
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  viewers: new Map(),
  _channels: new Map(),

  join: (entity, id) => {
    const key = `${entity}.${id}`
    const existing = get()._channels.get(key)
    if (existing) return

    const pusher = useSyncStore.getState()._pusher as Pusher | null
    if (!pusher) return

    const channelName = `presence-${entity}.${id}`
    interface PresenceMember { id: string | number; info: PresenceUser | null }
    interface PresenceChannel {
      name: string
      bind: (event: string, handler: (...args: unknown[]) => void) => void
      members?: { each: (cb: (m: PresenceMember) => void) => void }
    }
    const channel = pusher.subscribe(channelName) as unknown as PresenceChannel

    const apply = (next: PresenceUser[]): void => {
      const map = new Map(get().viewers)
      map.set(key, next)
      set({ viewers: map })
    }

    channel.bind('pusher:subscription_succeeded', (...args: unknown[]) => {
      const members = args[0] as { each?: (cb: (m: PresenceMember) => void) => void } | undefined
      const list: PresenceUser[] = []
      members?.each?.((m: PresenceMember) => {
        if (m.info) list.push({ ...m.info, socket_id: String(m.id) })
      })
      apply(list)
    })
    channel.bind('pusher:member_added', (...args: unknown[]) => {
      const m = args[0] as PresenceMember
      if (!m?.info) return
      apply([...(get().viewers.get(key) ?? []), { ...m.info, socket_id: String(m.id) }])
    })
    channel.bind('pusher:member_removed', (...args: unknown[]) => {
      const m = args[0] as PresenceMember
      const current = get().viewers.get(key) ?? []
      apply(current.filter((u) => u.socket_id !== String(m.id)))
    })

    const nextChannels = new Map(get()._channels)
    nextChannels.set(key, channel)
    set({ _channels: nextChannels })
  },

  leave: (entity, id) => {
    const key = `${entity}.${id}`
    const channel = get()._channels.get(key)
    if (!channel) return
    const pusher = useSyncStore.getState()._pusher as Pusher | null
    try { pusher?.unsubscribe(`presence-${entity}.${id}`) } catch { /* ignore */ }
    const nextChannels = new Map(get()._channels)
    nextChannels.delete(key)
    const nextViewers = new Map(get().viewers)
    nextViewers.delete(key)
    set({ _channels: nextChannels, viewers: nextViewers })
  },

  clear: () => {
    const pusher = useSyncStore.getState()._pusher as Pusher | null
    get()._channels.forEach((_, key) => {
      const [entity, id] = key.split('.')
      try { pusher?.unsubscribe(`presence-${entity}.${id}`) } catch { /* ignore */ }
    })
    set({ viewers: new Map(), _channels: new Map() })
  },
}))

/** Shared sentinel for "no viewers" so every subscribed component sees the
 *  SAME reference on miss. Returning a fresh `[]` inside the selector was the
 *  cause of "getSnapshot should be cached" — zustand's useSyncExternalStore
 *  compares by identity, a new array every call looks like constant churn and
 *  triggers an infinite re-render loop. */
const EMPTY_VIEWERS: readonly PresenceUser[] = Object.freeze([])

/** Selector: list of viewers on a given entity. Stable across renders unless
 *  the viewer set actually changes — React-friendly to use in sidebar rows. */
export function usePresenceFor(entity: PresenceEntity, id: string | null | undefined): readonly PresenceUser[] {
  return usePresenceStore((s) => {
    if (!id) return EMPTY_VIEWERS
    return s.viewers.get(`${entity}.${id}`) ?? EMPTY_VIEWERS
  })
}

/**
 * Joins presence channels for everything the user is currently looking at:
 * project → stack → environment → task → agent/routine. Auto-leaves when the
 * selection changes or the user logs out.
 *
 * Mount this once high up (e.g. App.tsx) so the global "who's here" state
 * updates the sidebar regardless of which route is active. A teammate on
 * another client sees the local user's avatar appear on every sidebar row
 * along the selection chain the moment Reverb reports `member_added`, and
 * disappear on `member_removed` when the local user navigates away — no
 * polling, no manual refresh.
 *
 * Pusher's presence model auto-publishes this client's membership on
 * subscribe (via the `/broadcasting/auth` payload the Laravel backend
 * returns), so there's no explicit "announce my presence" IPC — subscribing
 * IS announcing. Conversely, `leave()` → `pusher.unsubscribe` fires a
 * `member_removed` to everyone else. Closed tabs / app quits / network
 * drops are handled server-side by Pusher's heartbeat on socket close.
 */
export function usePresenceSubscriptions(): void {
  const connected = useSyncStore((s) => s.connected)
  const user = useAuthStore((s) => s.user)
  const selectedProjectId = useAppStore((s) => s.selectedProjectId)
  const selectedStackId = useAppStore((s) => s.selectedStackId)
  const selectedEnvironmentId = useAppStore((s) => s.selectedEnvironmentId)
  const selectedTaskId = useAppStore((s) => s.selectedTaskId)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const selectedRoutineId = useAppStore((s) => s.selectedRoutineId)
  const join = usePresenceStore((s) => s.join)
  const leave = usePresenceStore((s) => s.leave)
  const clear = usePresenceStore((s) => s.clear)

  // Log out → dump every subscription so we don't leak channels across users.
  useEffect(() => { if (!user) clear() }, [user, clear])

  // Each selection level gets its own effect so a change to (say)
  // `selectedTaskId` doesn't tear down and re-open the project / stack / env
  // channels — only the task one flips. Keeps teammate avatars stable on
  // the unchanged rows.
  useEffect(() => {
    if (!connected || !user || !selectedProjectId) return
    join('project', selectedProjectId)
    return () => leave('project', selectedProjectId)
  }, [connected, user, selectedProjectId, join, leave])

  useEffect(() => {
    if (!connected || !user || !selectedStackId) return
    join('stack', selectedStackId)
    return () => leave('stack', selectedStackId)
  }, [connected, user, selectedStackId, join, leave])

  useEffect(() => {
    if (!connected || !user || !selectedEnvironmentId) return
    join('environment', selectedEnvironmentId)
    return () => leave('environment', selectedEnvironmentId)
  }, [connected, user, selectedEnvironmentId, join, leave])

  useEffect(() => {
    if (!connected || !user || !selectedTaskId) return
    join('task', selectedTaskId)
    return () => leave('task', selectedTaskId)
  }, [connected, user, selectedTaskId, join, leave])

  useEffect(() => {
    if (!connected || !user || !activeAgentId) return
    join('agent', activeAgentId)
    return () => leave('agent', activeAgentId)
  }, [connected, user, activeAgentId, join, leave])

  useEffect(() => {
    if (!connected || !user || !selectedRoutineId) return
    join('routine', selectedRoutineId)
    return () => leave('routine', selectedRoutineId)
  }, [connected, user, selectedRoutineId, join, leave])
}
