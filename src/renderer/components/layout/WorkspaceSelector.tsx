import { useEffect, useRef, useState } from 'react'
import { Add, ChevronDown, Settings as SettingsIcon } from '@carbon/icons-react'
import { useAuthStore } from '../../stores/auth-store'
import { useAppStore } from '../../stores/app-store'

export function WorkspaceSelector() {
  const teams = useAuthStore((s) => s.teams)
  const workspace = useAuthStore((s) => s.workspace)
  const setWorkspace = useAuthStore((s) => s.setWorkspace)
  const authInit = useAuthStore((s) => s.init)
  const openTeamSettings = useAppStore((s) => s.openTeamSettings)

  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const currentLabel = (() => {
    if (workspace === 'all') return 'All workspaces'
    if (workspace === 'personal') return 'Personal'
    return teams.find((t) => t.id === workspace)?.name ?? 'Workspace'
  })()

  const createTeam = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    const team = await window.electronAPI.teams.create({ name: trimmed }) as { id: string }
    setName('')
    setCreating(false)
    setOpen(false)
    await authInit()
    setWorkspace(team.id)
    openTeamSettings(team.id)
  }

  return (
    <div ref={wrapperRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-7 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-neutral-200 hover:bg-neutral-800/80 border border-neutral-700/60 bg-neutral-900/60 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
        <span className="truncate max-w-[180px]">{currentLabel}</span>
        <ChevronDown size={12} className="text-neutral-500" />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1.5 w-64 rounded-xl bg-neutral-900 border border-neutral-700 shadow-2xl py-2 z-[60]">
          <div className="px-2 pb-1 text-[10px] uppercase tracking-wider text-neutral-500 px-3">Workspaces</div>

          <button
            type="button"
            onClick={() => { setWorkspace('all'); setOpen(false) }}
            className={`w-full text-left px-3 h-8 rounded-md flex items-center gap-2 text-[13px] hover:bg-neutral-800 ${
              workspace === 'all' ? 'text-neutral-100' : 'text-neutral-400'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            All workspaces
          </button>

          <button
            type="button"
            onClick={() => { setWorkspace('personal'); setOpen(false) }}
            className={`w-full text-left px-3 h-8 rounded-md flex items-center gap-2 text-[13px] hover:bg-neutral-800 ${
              workspace === 'personal' ? 'text-neutral-100' : 'text-neutral-400'
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />
            Personal
          </button>

          {teams.map((team) => (
            <div key={team.id} className="group flex items-center pr-1">
              <button
                type="button"
                onClick={() => { setWorkspace(team.id); setOpen(false) }}
                className={`flex-1 text-left px-3 h-8 rounded-md flex items-center gap-2 text-[13px] hover:bg-neutral-800 ${
                  workspace === team.id ? 'text-neutral-100' : 'text-neutral-400'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                <span className="truncate flex-1">{team.name}</span>
                <span className="text-[10px] text-neutral-600">{team.role}</span>
              </button>
              <button
                type="button"
                onClick={() => { setOpen(false); openTeamSettings(team.id) }}
                title="Workspace settings"
                className="size-7 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <SettingsIcon size={12} />
              </button>
            </div>
          ))}

          <div className="my-1.5 border-t border-neutral-800" />

          {!creating ? (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="w-full text-left px-3 h-8 rounded-md flex items-center gap-2 text-[12px] text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800"
            >
              <Add size={12} /> Create new workspace
            </button>
          ) : (
            <div className="px-2 py-1 flex items-center gap-1">
              <input
                autoFocus
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createTeam()
                  if (e.key === 'Escape') { setCreating(false); setName('') }
                }}
                placeholder="Workspace name"
                className="flex-1 h-7 px-2 rounded bg-neutral-800 border border-neutral-700 text-[12px] text-neutral-50 focus:outline-none focus:border-neutral-500"
              />
              <button
                type="button"
                onClick={createTeam}
                disabled={!name.trim()}
                className="h-7 px-2 rounded bg-neutral-700 text-[12px] text-neutral-50 hover:bg-neutral-600 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
