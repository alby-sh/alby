import { useEffect, useRef, useState } from 'react'
import { Logout, Renew } from '@carbon/icons-react'
import { useAuthStore } from '../../stores/auth-store'
import { UserAvatar } from '../ui/UserAvatar'

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string }
  | { kind: 'dev' }

export function UserMenu({ trigger }: { trigger: React.ReactElement }) {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)

  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)

  const [version, setVersion] = useState<string>('')
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: 'idle' })

  useEffect(() => {
    window.electronAPI.updater.getVersion().then(setVersion).catch(() => {})
    const unsub = window.electronAPI.updater.onDownloaded(({ version }) => {
      setUpdateState({ kind: 'ready', version })
    })
    return unsub
  }, [])

  // Auto-clear the transient "up to date" / error message after a few seconds.
  useEffect(() => {
    if (updateState.kind === 'up-to-date' || updateState.kind === 'error' || updateState.kind === 'dev') {
      const t = window.setTimeout(() => setUpdateState({ kind: 'idle' }), 4000)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [updateState])

  const handleCheckForUpdates = async () => {
    setUpdateState({ kind: 'checking' })
    try {
      const result = await window.electronAPI.updater.check()
      switch (result.status) {
        case 'dev':
          setUpdateState({ kind: 'dev' })
          break
        case 'up-to-date':
          setUpdateState({ kind: 'up-to-date' })
          break
        case 'downloading':
          setUpdateState({ kind: 'downloading', version: result.version || '' })
          break
        case 'downloaded':
          setUpdateState({ kind: 'ready', version: result.version || '' })
          break
        case 'checking':
          // already running — leave the spinner up
          break
        default:
          setUpdateState({ kind: 'error', message: result.message || 'Update check failed' })
      }
    } catch (err) {
      setUpdateState({ kind: 'error', message: (err as Error).message })
    }
  }

  const handleInstallUpdate = async () => {
    const ok = window.confirm(
      `Install Alby ${updateState.kind === 'ready' ? updateState.version : ''} now? The app will restart.`
    )
    if (!ok) return
    await window.electronAPI.updater.install()
  }

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!user) return trigger

  return (
    <div ref={wrapperRef} className="relative">
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-64 rounded-xl bg-neutral-900 border border-neutral-700 shadow-2xl py-2 z-50">
          <div className="px-3 pb-2 mb-2 border-b border-neutral-800 flex items-center gap-2">
            <UserAvatar url={user.avatar_url} name={user.name} size={32} />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-neutral-100 truncate">{user.name}</div>
              <div className="text-[11px] text-neutral-500 truncate">{user.email}</div>
            </div>
          </div>

          <div className="px-2">
            <button
              type="button"
              onClick={() => { setOpen(false); logout() }}
              className="w-full text-left px-2 h-8 rounded-md flex items-center gap-2 text-[13px] text-neutral-300 hover:bg-neutral-800"
            >
              <Logout size={14} />
              Log out
            </button>

            <div className="mt-2 pt-2 border-t border-neutral-800 px-2">
              {updateState.kind === 'ready' ? (
                <button
                  type="button"
                  onClick={handleInstallUpdate}
                  className="w-full h-7 px-2 rounded-md flex items-center justify-between text-[12px] text-blue-300 bg-blue-900/30 hover:bg-blue-900/50 transition-colors"
                  title="Restart and install update"
                >
                  <span className="truncate">Update {updateState.version} ready</span>
                  <span className="text-[10px] opacity-80">Install →</span>
                </button>
              ) : (
                <div className="flex items-center justify-between text-[11px] text-neutral-500">
                  <span className="truncate">
                    {updateState.kind === 'checking'
                      ? 'Checking for updates…'
                      : updateState.kind === 'downloading'
                      ? `Downloading ${updateState.version}…`
                      : updateState.kind === 'up-to-date'
                      ? "You're up to date"
                      : updateState.kind === 'error'
                      ? `Update check failed`
                      : updateState.kind === 'dev'
                      ? 'Updates run only in packaged builds'
                      : version
                      ? `v${version}`
                      : ''}
                  </span>
                  <button
                    type="button"
                    onClick={handleCheckForUpdates}
                    disabled={updateState.kind === 'checking' || updateState.kind === 'downloading'}
                    className="size-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors disabled:opacity-50"
                    title="Check for updates"
                  >
                    <Renew
                      size={12}
                      className={updateState.kind === 'checking' || updateState.kind === 'downloading' ? 'animate-spin' : ''}
                    />
                  </button>
                </div>
              )}
              {updateState.kind === 'error' && (
                <div className="mt-1 text-[10px] text-red-400 truncate" title={updateState.message}>
                  {updateState.message}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
