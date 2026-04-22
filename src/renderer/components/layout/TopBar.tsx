import { WorkspaceSelector } from './WorkspaceSelector'

export function TopBar() {
  return (
    <div
      className="h-12 flex items-center px-4 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Traffic light space */}
      <div className="w-20" />
      <div className="flex-1" />
      <WorkspaceSelector />
    </div>
  )
}
