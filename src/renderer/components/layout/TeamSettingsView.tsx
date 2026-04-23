import { useEffect, useMemo, useState } from 'react'
import { Add, Close, Edit, TrashCan, Copy } from '@carbon/icons-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAppStore } from '../../stores/app-store'
import { useAuthStore, type TeamRole } from '../../stores/auth-store'
import { UserAvatar } from '../ui/UserAvatar'
import { useTeamRoles, useUpdateMemberRole, useDeleteTeamRole } from '../../hooks/useTeams'
import { RoleEditorDialog } from '../dialogs/RoleEditorDialog'

interface TeamDetail {
  id: string
  name: string
  slug: string
  avatar_url: string | null
  members: Array<{ id: number; name: string; email: string; avatar_url: string | null; pivot: { role: string } }>
  invites: Array<{ id: number; email: string | null; role: string; token: string; expires_at: string; accepted_at: string | null }>
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-4 py-8 md:grid-cols-10 border-b border-neutral-800 last:border-b-0">
      <div className="w-full space-y-1.5 md:col-span-4">
        <h3 className="text-[15px] font-semibold leading-none text-neutral-50">{title}</h3>
        <p className="text-[13px] text-neutral-400 text-balance">{description}</p>
      </div>
      <div className="md:col-span-6">{children}</div>
    </div>
  )
}

export function TeamSettingsView({ teamId }: { teamId: string }) {
  const close = useAppStore((s) => s.closeTeamSettings)
  const authInit = useAuthStore((s) => s.init)
  const qc = useQueryClient()

  const { data: team } = useQuery<TeamDetail | null>({
    queryKey: ['team', teamId],
    queryFn: () => window.electronAPI.teams.get(teamId) as Promise<TeamDetail | null>,
  })

  const [name, setName] = useState('')
  const [newInviteEmail, setNewInviteEmail] = useState('')
  const [newInviteRole, setNewInviteRole] = useState<string>('developer')
  const [savedKey, setSavedKey] = useState<string | null>(null)
  const [lastLink, setLastLink] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // v0.8.1 — team role catalogue. Builtins are seeded server-side so the
  // select always has at least the 7 standard options even before the
  // admin creates any custom roles.
  const { data: roles = [] } = useTeamRoles(teamId)
  const updateMemberRole = useUpdateMemberRole(teamId)
  const deleteRole = useDeleteTeamRole(teamId)
  const [editingRole, setEditingRole] = useState<TeamRole | null>(null)
  const [creatingRole, setCreatingRole] = useState(false)
  // Builtins first (in the standard hierarchy), then customs alphabetically.
  // Used for both the members-row <select> and the invite-row <select>.
  const BUILTIN_ORDER = ['owner', 'admin', 'developer', 'viewer', 'analyst', 'issuer']
  const sortedRoles = useMemo(() => {
    const rank = (r: TeamRole): number => {
      if (!r.is_builtin) return 100
      const i = BUILTIN_ORDER.indexOf(r.slug)
      return i === -1 ? 50 : i
    }
    return [...roles].sort((a, b) => {
      const d = rank(a) - rank(b)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })
  }, [roles])
  // Roles valid for INVITING someone. Owner can't be invited (there's only
  // one per team, transferred via a separate flow). Everything else is fair
  // game, including custom roles the team just defined.
  const invitableRoles = useMemo(() => sortedRoles.filter((r) => r.slug !== 'owner'), [sortedRoles])
  useEffect(() => {
    // Keep invite role valid if the admin deleted the one selected.
    if (!invitableRoles.some((r) => r.slug === newInviteRole) && invitableRoles[0]) {
      setNewInviteRole(invitableRoles[0].slug)
    }
  }, [invitableRoles, newInviteRole])

  useEffect(() => { if (team) setName(team.name) }, [team])

  const flashSaved = (k: string): void => {
    setSavedKey(k)
    window.setTimeout(() => setSavedKey((x) => (x === k ? null : x)), 1800)
  }

  const updateTeam = useMutation({
    mutationFn: (data: { name?: string }) => window.electronAPI.teams.update(teamId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['team', teamId] })
      authInit()
      flashSaved('name')
    },
  })
  const inviteMutation = useMutation({
    mutationFn: (data: { email?: string; role: string }) =>
      window.electronAPI.teams.invite(teamId, data) as Promise<{ url: string }>,
    onSuccess: (data) => {
      setLastLink(data.url)
      setNewInviteEmail('')
      qc.invalidateQueries({ queryKey: ['team', teamId] })
    },
  })
  const removeMember = useMutation({
    mutationFn: (userId: number) => window.electronAPI.teams.removeMember(teamId, userId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team', teamId] }),
  })
  const deleteTeam = useMutation({
    mutationFn: () => window.electronAPI.teams.delete(teamId),
    onSuccess: () => {
      authInit()
      close()
    },
  })

  if (!team) {
    return (
      <div className="flex-1 flex items-center justify-center bg-[var(--bg-primary)] text-neutral-500 text-sm">
        Loading team…
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-[var(--bg-primary)] overflow-hidden">
      <div className="h-12 flex items-center px-4 border-b border-neutral-800 shrink-0">
        <div className="text-[14px] text-neutral-400 truncate">
          Team <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200 truncate">{team.name}</span>{' '}
          <span className="text-neutral-600">/</span>{' '}
          <span className="text-neutral-200">Settings</span>
        </div>
        <div className="flex-1" />
        <button type="button" onClick={close} className="size-8 flex items-center justify-center rounded-lg hover:bg-neutral-800 text-neutral-400 hover:text-neutral-200" title="Close"><Close size={16} /></button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-8 py-8">
          <div className="flex flex-col mb-6">
            <h2 className="text-2xl font-bold text-neutral-50">Team Settings</h2>
            <p className="text-[14px] text-neutral-400">Members, invites, and permissions for this team.</p>
          </div>

          <div className="border-t border-neutral-800">
            <Section title="Name" description="Display name for this team.">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-[13px] text-neutral-50 focus:outline-none focus:border-neutral-500"
                />
                <button
                  type="button"
                  onClick={() => updateTeam.mutate({ name: name.trim() })}
                  disabled={updateTeam.isPending || !name.trim() || name.trim() === team.name}
                  className="inline-flex items-center justify-center whitespace-nowrap rounded-lg h-9 px-4 text-[13px] font-medium border border-neutral-700 bg-neutral-800 text-neutral-50 hover:bg-neutral-700 disabled:opacity-50"
                >
                  Save
                </button>
                {savedKey === 'name' && <span className="text-[11px] text-emerald-400">Saved</span>}
              </div>
            </Section>

            <Section title="Members" description="Everyone with access to projects owned by this team.">
              <div className="space-y-2">
                {team.members.length === 0 && <p className="text-[13px] text-neutral-500">No members yet.</p>}
                {team.members.map((m) => {
                  const isOwner = m.pivot.role === 'owner'
                  return (
                    <div key={m.id} className="flex items-center gap-3 px-3 h-11 rounded-md bg-neutral-900 border border-neutral-800">
                      <UserAvatar url={m.avatar_url} name={m.name} size={28} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-neutral-100 truncate">{m.name}</div>
                        <div className="text-[11px] text-neutral-500 truncate">{m.email}</div>
                      </div>
                      {/* Owner stays static — transferring ownership needs a
                       *  dedicated flow, not an accidental dropdown change.
                       *  Everyone else gets the role picker in-row. */}
                      {isOwner ? (
                        <div className="text-[11px] text-neutral-500 uppercase tracking-wider">owner</div>
                      ) : sortedRoles.length > 0 ? (
                        <select
                          value={m.pivot.role}
                          onChange={(e) => {
                            if (e.target.value === m.pivot.role) return
                            updateMemberRole.mutate({ userId: m.id, role: e.target.value })
                          }}
                          disabled={updateMemberRole.isPending}
                          className="text-[11.5px] bg-neutral-950 border border-neutral-800 rounded px-2 py-1 text-neutral-200 hover:border-neutral-700 focus:outline-none focus:border-neutral-500"
                          title={sortedRoles.find((r) => r.slug === m.pivot.role)?.description ?? undefined}
                        >
                          {!sortedRoles.some((r) => r.slug === m.pivot.role) && (
                            // Defensive: a legacy role slug we no longer have
                            // in the catalogue (custom role deleted without
                            // re-assignment finishing, or backend lagging).
                            <option value={m.pivot.role}>{m.pivot.role}</option>
                          )}
                          {sortedRoles
                            .filter((r) => r.slug !== 'owner')
                            .map((r) => (
                              <option key={r.id} value={r.slug}>
                                {r.name}
                                {!r.is_builtin ? ' · custom' : ''}
                              </option>
                            ))}
                        </select>
                      ) : (
                        <div className="text-[11px] text-neutral-500 uppercase tracking-wider">{m.pivot.role}</div>
                      )}
                      <button
                        type="button"
                        onClick={() => { if (confirm(`Remove ${m.name} from ${team.name}?`)) removeMember.mutate(m.id) }}
                        className="size-7 flex items-center justify-center rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800"
                        title="Remove"
                      >
                        <TrashCan size={14} />
                      </button>
                    </div>
                  )
                })}
              </div>
            </Section>

            <Section
              title="Roles"
              description="Built-in roles give common permission presets. Create custom roles to grant exactly the capabilities a team member needs."
            >
              <div className="space-y-2">
                {sortedRoles.map((r) => (
                  <div key={r.id} className="flex items-start gap-3 px-3 py-2.5 rounded-md bg-neutral-900 border border-neutral-800">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] text-neutral-100 truncate">{r.name}</span>
                        <span className="text-[10px] text-neutral-600 font-mono">{r.slug}</span>
                        {r.is_builtin ? (
                          <span className="text-[9px] uppercase tracking-wider text-neutral-500 border border-neutral-700 rounded px-1 py-[1px]">
                            built-in
                          </span>
                        ) : (
                          <span className="text-[9px] uppercase tracking-wider text-blue-300 border border-blue-900/50 rounded px-1 py-[1px]">
                            custom
                          </span>
                        )}
                      </div>
                      {r.description && (
                        <div className="text-[11px] text-neutral-500 truncate mt-0.5">{r.description}</div>
                      )}
                      <div className="text-[10.5px] text-neutral-600 mt-1.5 flex flex-wrap gap-1">
                        {r.capabilities.length === 0 ? (
                          <span className="italic text-neutral-700">No capabilities</span>
                        ) : (
                          r.capabilities.map((c) => (
                            <span
                              key={c}
                              className="border border-neutral-800 rounded px-1 py-[1px] font-mono"
                            >
                              {c}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setEditingRole(r)}
                      title={r.is_builtin ? 'View / rename built-in role' : 'Edit capabilities'}
                      className="size-7 flex items-center justify-center rounded text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800"
                    >
                      <Edit size={14} />
                    </button>
                    {!r.is_builtin && (
                      <button
                        type="button"
                        onClick={() => {
                          const ok = confirm(
                            `Delete role "${r.name}"?\n\nMembers using this role will be moved to "viewer" automatically.`,
                          )
                          if (!ok) return
                          deleteRole.mutate({ roleId: r.id })
                        }}
                        className="size-7 flex items-center justify-center rounded text-neutral-500 hover:text-red-400 hover:bg-neutral-800"
                        title="Delete role"
                      >
                        <TrashCan size={14} />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setCreatingRole(true)}
                  className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded border border-dashed border-neutral-700 text-neutral-400 hover:text-neutral-100 hover:border-neutral-500"
                >
                  <Add size={12} />
                  New role
                </button>
              </div>
            </Section>

            {(editingRole || creatingRole) && (
              <RoleEditorDialog
                teamId={teamId}
                existing={editingRole}
                onClose={() => { setEditingRole(null); setCreatingRole(false) }}
              />
            )}

            <Section title="Invite a new member" description="Send an invite by email, or generate a shareable link.">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="email"
                    placeholder="colleague@example.com (leave blank for a link-only invite)"
                    value={newInviteEmail}
                    onChange={(e) => setNewInviteEmail(e.target.value)}
                    className="flex-1 h-10 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50 placeholder:text-neutral-500 focus:outline-none focus:border-neutral-500"
                  />
                  <select
                    value={newInviteRole}
                    onChange={(e) => setNewInviteRole(e.target.value)}
                    className="h-10 rounded-md border border-neutral-700 bg-neutral-900 px-3 text-[13px] text-neutral-50"
                  >
                    {invitableRoles.map((r) => (
                      <option key={r.id} value={r.slug}>
                        {r.name}
                        {!r.is_builtin ? ' · custom' : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => inviteMutation.mutate({ email: newInviteEmail.trim() || undefined, role: newInviteRole })}
                    disabled={inviteMutation.isPending}
                    className="inline-flex items-center justify-center whitespace-nowrap rounded-lg h-9 px-4 text-[13px] font-medium border border-neutral-700 bg-neutral-800 hover:bg-neutral-700"
                  >
                    {inviteMutation.isPending ? 'Sending…' : 'Invite'}
                  </button>
                </div>
                {lastLink && (
                  <div className="flex items-center gap-2 text-[12px] text-neutral-400">
                    <span>Invite link:</span>
                    <code className="flex-1 truncate text-neutral-300 font-mono">{lastLink}</code>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(lastLink)}
                      className="size-7 flex items-center justify-center rounded hover:bg-neutral-800 text-neutral-400"
                      title="Copy"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                )}

                {team.invites.filter((i) => !i.accepted_at).length > 0 && (
                  <div className="mt-3">
                    <p className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2">Pending invites</p>
                    <div className="space-y-1">
                      {team.invites.filter((i) => !i.accepted_at).map((i) => (
                        <div key={i.id} className="flex items-center gap-2 px-3 h-9 rounded-md bg-neutral-900/50 border border-neutral-800/60 text-[12px] text-neutral-300">
                          <span className="flex-1 truncate">{i.email ?? '(link-only)'}</span>
                          <span className="text-neutral-500 uppercase">{i.role}</span>
                          <button
                            type="button"
                            onClick={() => navigator.clipboard.writeText(`https://alby.sh/invite/${i.token}`)}
                            className="size-7 flex items-center justify-center rounded hover:bg-neutral-800 text-neutral-400"
                            title="Copy link"
                          >
                            <Copy size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>

            <div className="py-8">
              <div className="rounded-lg border border-red-900/60 bg-red-950/20 p-4">
                <h3 className="text-[14px] font-semibold text-red-300 mb-1">Delete Team</h3>
                <p className="text-[13px] text-red-400/80 mb-4">
                  Removes the team and all its projects, environments and agents permanently.
                  Running tmux sessions on remote servers are NOT killed automatically.
                </p>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-[13px] font-medium bg-red-600/90 hover:bg-red-600 text-white"
                >
                  <TrashCan size={14} /> Delete Team
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60" onClick={() => setConfirmDelete(false)}>
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-5 w-[420px]" onClick={(e) => e.stopPropagation()}>
            <div className="text-[15px] font-semibold text-neutral-50 mb-2">Delete "{team.name}"?</div>
            <p className="text-[13px] text-neutral-400 mb-4">This cannot be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(false)} className="h-8 px-3 rounded-lg text-[13px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800">Cancel</button>
              <button onClick={() => deleteTeam.mutate()} className="h-8 px-4 rounded-lg text-[13px] text-white bg-red-600 hover:bg-red-500">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
