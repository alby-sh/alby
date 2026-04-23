import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../../stores/auth-store'
import { UserAvatar } from './UserAvatar'

interface TeamDetail {
  id: string
  name: string
  members: Array<{ id: number; name: string; email: string; avatar_url: string | null; pivot: { role: string } }>
}

interface Props {
  value: number[] | null
  onChange: (next: number[] | null) => void
}

/**
 * Small multi-select for delegating a manual routine's Start button to
 * specific team members. An empty array / null selection means "no
 * delegation — role-based access applies"; a populated selection means
 * "these users can Start even if their role wouldn't normally let them".
 *
 * Appears only for team-workspace environments. On the Personal workspace
 * there are no members to delegate to and the picker renders an info card
 * instead.
 */
export function RoutineAllowlistPicker({ value, onChange }: Props) {
  const currentTeamId = useAuthStore((s) => s.currentTeamId)

  const { data: team, isLoading } = useQuery<TeamDetail | null>({
    queryKey: ['team', currentTeamId, 'for-allowlist'],
    queryFn: () => currentTeamId
      ? (window.electronAPI.teams.get(currentTeamId) as Promise<TeamDetail | null>)
      : Promise.resolve(null),
    enabled: !!currentTeamId,
    staleTime: 30_000,
  })

  if (!currentTeamId) {
    return (
      <div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded px-3 py-2">
        Delegation requires a team workspace — personal-workspace routines
        always respect role-based access only.
      </div>
    )
  }
  if (isLoading || !team) {
    return <div className="text-xs text-[var(--text-secondary)] px-1 py-2">Loading members…</div>
  }

  const selected = new Set(value ?? [])
  const toggle = (userId: number) => {
    const next = new Set(selected)
    if (next.has(userId)) next.delete(userId)
    else next.add(userId)
    const arr = Array.from(next).sort((a, b) => a - b)
    onChange(arr.length === 0 ? null : arr)
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-[var(--text-secondary)]">
        Leave empty to fall back to role-based access. Pick members to let
        them Start this routine even if their role doesn't grant it.
      </div>
      <div className="max-h-56 overflow-y-auto rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] divide-y divide-[var(--border-color)]/50">
        {team.members.length === 0 && (
          <div className="px-3 py-2 text-xs text-[var(--text-secondary)]">No team members yet.</div>
        )}
        {team.members.map((m) => {
          const checked = selected.has(m.id)
          return (
            <label
              key={m.id}
              className={`flex items-center gap-2.5 px-2.5 py-1.5 cursor-pointer hover:bg-white/[0.03] ${checked ? 'bg-[var(--accent)]/5' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(m.id)}
                className="accent-[var(--accent)]"
              />
              <UserAvatar url={m.avatar_url} name={m.name} size={22} />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] text-[var(--text-primary)] truncate leading-tight">{m.name}</div>
                <div className="text-[10.5px] text-[var(--text-secondary)] truncate leading-tight">{m.email}</div>
              </div>
              <span className="text-[10px] text-[var(--text-secondary)] uppercase tracking-wide">{m.pivot.role}</span>
            </label>
          )
        })}
      </div>
      {selected.size > 0 && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline-offset-2 hover:underline"
        >
          Clear delegation ({selected.size} selected)
        </button>
      )}
    </div>
  )
}
