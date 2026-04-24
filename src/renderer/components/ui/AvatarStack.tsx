import type { PresenceUser } from '../../stores/presence-store'
import { UserAvatar } from './UserAvatar'

const SIZES = {
  xs: { px: 14, ring: 'ring-1', text: 'text-[8px]' },
  sm: { px: 18, ring: 'ring-2', text: 'text-[9px]' },
} as const

/**
 * Small stack of circular avatars. Used in the sidebar to show who else is
 * looking at the same agent / routine. Overflow ("+N" bubble) kicks in past
 * `max` viewers to keep the row readable on narrow sidebars.
 */
export function AvatarStack({
  users,
  max = 3,
  size = 'xs',
  title,
}: {
  users: readonly PresenceUser[]
  max?: number
  size?: keyof typeof SIZES
  title?: string
}) {
  if (users.length === 0) return null
  const cfg = SIZES[size]
  const visible = users.slice(0, max)
  const overflow = users.length - visible.length
  const tip = title ?? users.map((u) => u.name).join(', ')
  return (
    <div className="flex items-center -space-x-1 shrink-0" title={tip}>
      {visible.map((u, i) => (
        <Bubble key={u.socket_id ?? `${u.id}-${i}`} user={u} size={cfg} z={visible.length - i} />
      ))}
      {overflow > 0 && (
        <span
          className={`rounded-full ring-2 ring-neutral-900 bg-neutral-700 text-neutral-200 ${cfg.text} font-semibold flex items-center justify-center tabular-nums`}
          style={{ width: cfg.px, height: cfg.px }}
        >
          +{overflow}
        </span>
      )}
    </div>
  )
}

function Bubble({ user, size, z }: { user: PresenceUser; size: typeof SIZES[keyof typeof SIZES]; z: number }) {
  // Delegate to UserAvatar so this bubble shares the exact same
  // image-with-initials-fallback path used by the primary sidebar's bottom
  // CurrentUserAvatar and the user menu popup. Without this the same user
  // rendered in two places would diverge the moment Google's
  // lh3.googleusercontent.com token expired on one of them: UserAvatar swaps
  // to a name-deterministic gradient bubble, while this used to keep an <img>
  // around and show the broken-image glyph. The outer <span> carries the ring
  // + zIndex that the parent stack expects.
  return (
    <span
      className={`inline-block rounded-full ${size.ring} ring-neutral-900`}
      style={{ zIndex: z, lineHeight: 0 }}
    >
      <UserAvatar url={user.avatar_url} name={user.name} size={size.px} />
    </span>
  )
}
