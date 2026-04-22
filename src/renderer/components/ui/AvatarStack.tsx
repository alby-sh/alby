import type { PresenceUser } from '../../stores/presence-store'

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
  users: PresenceUser[]
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
  if (user.avatar_url) {
    return (
      <img
        src={user.avatar_url}
        alt={user.name}
        className={`rounded-full ${size.ring} ring-neutral-900 object-cover`}
        style={{ width: size.px, height: size.px, zIndex: z }}
      />
    )
  }
  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
  return (
    <span
      className={`rounded-full ${size.ring} ring-neutral-900 bg-gradient-to-br from-sky-500 to-blue-600 text-white ${size.text} font-semibold flex items-center justify-center`}
      style={{ width: size.px, height: size.px, zIndex: z }}
    >
      {initials || '?'}
    </span>
  )
}
