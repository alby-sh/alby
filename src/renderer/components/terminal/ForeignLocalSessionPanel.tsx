import type { Agent } from '../../../shared/types'

/**
 * Rendered in MainArea when the active agent's PTY lives on another Mac
 * (`agent.execution_mode === 'local' && agent.device_id !== ourDeviceId`).
 *
 * Keep it clearly NOT-a-terminal — no xterm, no scrollback — so the user
 * never thinks they can type into it. The big device name + the mic-drop
 * "open Alby there" instruction are the UX contract: "this tab exists so
 * you know your teammate is working on this thing; to interact with it,
 * go to their Mac."
 *
 * Sidebar already:
 *   - shows a 🔒 device-name chip on the row,
 *   - leaves the normal click path active (so clicking lands here),
 *   - hides kill / delete from the context menu (logic lives in the
 *     context-menu render in Sidebar.tsx, which skips these for foreign
 *     locals), and
 *   - blocks drag-to-reorder writing to stdin/resize through IPC guards.
 *
 * If/when a teammate closes that session on the owning Mac, the cloud
 * row's status flips to `completed` / `error` and the sidebar will remove
 * it on the next `entity.changed` broadcast — this screen disappears on
 * its own.
 */
export function ForeignLocalSessionPanel({ agent }: { agent: Agent }) {
  const deviceName = agent.device_name || 'another device'
  const kind = (agent.tab_name?.split(' ')[0] || 'Session')
  return (
    <div className="w-full h-full flex items-center justify-center bg-neutral-950 p-6">
      <div className="max-w-md text-center space-y-4">
        <div className="mx-auto size-14 rounded-2xl bg-neutral-800 flex items-center justify-center text-2xl">
          🔒
        </div>
        <h2 className="text-neutral-100 text-base font-semibold">
          {kind} is running on <span className="text-blue-400">{deviceName}</span>
        </h2>
        <p className="text-[13px] text-neutral-400 leading-relaxed">
          This is a <span className="text-neutral-200">local</span> agent — its PTY lives on that Mac and can't be attached from here.
          You can see it in the sidebar so the team knows it exists, but to read the output or type into it,
          open Alby on <span className="text-neutral-200">{deviceName}</span>.
        </p>
        <div className="mt-4 text-[11px] text-neutral-500">
          Started {agent.started_at ? new Date(agent.started_at).toLocaleString() : 'recently'}
          {agent.status === 'running' ? ' · still running' : ` · status: ${agent.status}`}
        </div>
        <p className="text-[11px] text-neutral-600 pt-2 border-t border-neutral-900">
          Kill, delete, rename and input are disabled on remote devices to keep the owner Mac's
          state in sync. If the owning Mac goes offline for long, the session's status will
          eventually flip to <code className="px-1 rounded bg-neutral-900">error</code> and this
          tab will vanish on its own.
        </p>
      </div>
    </div>
  )
}
