import { useState, useRef } from 'react'
import type { Agent, AgentStatus } from '../../../shared/types'
import { useAppStore } from '../../stores/app-store'
import { useUpdateAgent } from '../../hooks/useAgents'

function AgentIndicator({ status, activity }: { status: AgentStatus; activity?: string }) {
  if (status === 'completed') return (<span className="flex items-center justify-center w-4 h-4"><svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-green-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 8.5L6.5 12L13 4" strokeLinecap="round" strokeLinejoin="round" /></svg></span>)
  if (status === 'error') return (<span className="flex items-center justify-center w-4 h-4"><svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-red-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4L12 12M12 4L4 12" strokeLinecap="round" /></svg></span>)
  if (status === 'running' && activity === 'working') return (<span className="flex items-center justify-center w-4 h-4"><svg viewBox="0 0 16 16" className="w-3.5 h-3.5 animate-spin" fill="none"><circle cx="8" cy="8" r="6" stroke="#3b82f6" strokeWidth="2" opacity="0.25" /><path d="M8 2a6 6 0 0 1 6 6" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" /></svg></span>)
  if (status === 'running') return (<span className="flex items-center justify-center w-4 h-4"><span className="w-2 h-2 rounded-full bg-blue-400" /></span>)
  return (<span className="flex items-center justify-center w-4 h-4"><span className="w-2 h-2 rounded-full bg-gray-500" /></span>)
}

function ActivityLabel({ status, activity }: { status: AgentStatus; activity?: string }) {
  if (status === 'completed') return <span className="text-xs text-green-400 ml-1">done</span>
  if (status === 'error') return <span className="text-xs text-red-400 ml-1">error</span>
  if (status === 'running' && activity === 'working') return <span className="text-xs text-blue-400 ml-1">working</span>
  if (status === 'running') return <span className="text-xs text-gray-400 ml-1">idle</span>
  return null
}

export interface TerminalTabsProps {
  agents: Agent[]
  tabOrder: string[]
  panes: string[]
  activePaneIndex: number
  agentActivities: Map<string, string>
  onSelectAgent: (id: string) => void
  onKillAgent: (id: string) => void
  onCloseAgent: (id: string) => void
  onNewAgent: () => void
  onReorderTabs: (fromId: string, toId: string) => void
  onDragStart: () => void
  onDragEnd: () => void
  isSpawning: boolean
  launcherOpen: boolean
  isLauncherActive: boolean
  onSelectLauncher: () => void
  onCloseLauncher: () => void
  savedSplit: { panes: string[]; sizes: number[] } | null
  onSelectSplitGroup: () => void
  onUnsplit: () => void
}

export function TerminalTabs({
  agents, tabOrder, panes, activePaneIndex, agentActivities,
  onSelectAgent, onKillAgent, onCloseAgent, onNewAgent, onReorderTabs,
  onDragStart: onDragStartCb, onDragEnd: onDragEndCb,
  isSpawning, launcherOpen, isLauncherActive, onSelectLauncher, onCloseLauncher,
  savedSplit, onSelectSplitGroup, onUnsplit
}: TerminalTabsProps) {
  const [dragOverId, setDragOverId] = useState<string | null>(null)
  const dragIdRef = useRef<string | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; agentId: string } | null>(null)
  const pinnedTabs = useAppStore((s) => s.pinnedTabs)
  const togglePinTab = useAppStore((s) => s.togglePinTab)
  const updateAgent = useUpdateAgent()
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState<string>('')
  const startRename = (agent: Agent): void => {
    setRenameDraft(agent.tab_name ?? '')
    setRenamingId(agent.id)
  }
  const commitRename = (agentId: string): void => {
    const next = renameDraft.trim()
    if (next.length > 0) {
      updateAgent.mutate({ agentId, data: { tab_name: next } })
    }
    setRenamingId(null)
  }
  const cancelRename = (): void => {
    setRenamingId(null)
  }

  // Sort agents: pinned first, then by tabOrder
  const sortedAgents = [...agents].sort((a, b) => {
    const ap = pinnedTabs.has(a.id) ? 0 : 1
    const bp = pinnedTabs.has(b.id) ? 0 : 1
    if (ap !== bp) return ap - bp
    const ai = tabOrder.indexOf(a.id)
    const bi = tabOrder.indexOf(b.id)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })

  // Determine which agents are part of the current split (in panes, >1)
  const currentSplitIds = new Set(panes.length > 1 ? panes : [])
  // Determine which agents are in the saved split (background)
  const savedSplitIds = new Set(savedSplit ? savedSplit.panes : [])
  // All agents that are in either active split or saved split — they get grouped
  const allSplitIds = new Set([...currentSplitIds, ...savedSplitIds])

  const handleDragStart = (e: React.DragEvent, agentId: string) => {
    dragIdRef.current = agentId
    e.dataTransfer.setData('text/plain', agentId)
    e.dataTransfer.effectAllowed = 'move'
    onDragStartCb()
  }

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragIdRef.current && dragIdRef.current !== targetId) {
      setDragOverId(targetId)
    }
  }

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault()
    const fromId = dragIdRef.current
    if (fromId && fromId !== targetId) {
      onReorderTabs(fromId, targetId)
    }
    setDragOverId(null)
    dragIdRef.current = null
  }

  const handleDragEnd = () => {
    setDragOverId(null)
    dragIdRef.current = null
    onDragEndCb()
  }

  // Build tab items: split agents become a grouped tab, others are individual
  type TabItem = { type: 'single'; agent: Agent } | { type: 'split'; agents: Agent[]; isActive: boolean }
  const tabItems: TabItem[] = []
  let splitInserted = false

  // Which IDs to group: if we're currently viewing the split, use currentSplitIds
  // If we have a saved split (viewing a solo tab), use savedSplitIds
  const groupIds = currentSplitIds.size > 0 ? currentSplitIds : savedSplitIds
  const isSplitCurrentlyActive = currentSplitIds.size > 0

  for (const agent of sortedAgents) {
    if (groupIds.has(agent.id)) {
      if (!splitInserted) {
        // Collect all grouped agents in order
        const groupAgents = [...groupIds]
          .map((id) => sortedAgents.find((a) => a.id === id))
          .filter(Boolean) as Agent[]
        if (groupAgents.length > 1) {
          tabItems.push({ type: 'split', agents: groupAgents, isActive: isSplitCurrentlyActive })
          splitInserted = true
        } else {
          // Only one agent left in group — show as single
          tabItems.push({ type: 'single', agent })
          splitInserted = true
        }
      }
      continue
    }
    tabItems.push({ type: 'single', agent })
  }

  return (
    <div className="flex items-center border-b border-[var(--border-color)] bg-[var(--bg-secondary)] overflow-x-auto min-h-[38px]">
      {tabItems.map((item) => {
        if (item.type === 'split') {
          const isActive = item.isActive && !isLauncherActive
          return (
            <div
              key="__split__"
              className={`flex items-center gap-0.5 px-1 py-2 cursor-pointer text-sm border-r border-[var(--border-color)] min-w-0 transition-colors select-none ${
                isActive
                  ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              onClick={() => {
                if (isActive) {
                  // Already viewing the split — focus first pane
                  onSelectAgent(item.agents[0].id)
                } else {
                  // Restore saved split
                  onSelectSplitGroup()
                }
              }}
            >
              {item.agents.map((agent, aIdx) => {
                const activity = agentActivities.get(agent.id)
                return (
                  <div key={agent.id} className="flex items-center gap-1 px-1.5">
                    <AgentIndicator status={agent.status} activity={activity} />
                    <span className="truncate text-xs">{agent.tab_name || 'Agent'}</span>
                    {aIdx < item.agents.length - 1 && (
                      <span className="text-neutral-600 ml-1">|</span>
                    )}
                  </div>
                )
              })}
              {/* Unsplit button */}
              <button
                onClick={(e) => { e.stopPropagation(); onUnsplit() }}
                className="ml-1 w-4 h-4 flex items-center justify-center rounded text-xs hover:bg-blue-500/30 hover:text-blue-300 text-[var(--text-secondary)] transition-colors shrink-0"
                title="Unsplit into separate tabs"
              >
                <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 8h8" strokeLinecap="round" /></svg>
              </button>
              {/* Close all button */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  for (const a of item.agents) {
                    if (a.status === 'running') onKillAgent(a.id)
                    else onCloseAgent(a.id)
                  }
                }}
                className="ml-0.5 w-4 h-4 flex items-center justify-center rounded text-xs hover:bg-red-500/30 hover:text-red-300 text-[var(--text-secondary)] transition-colors shrink-0"
                title="Close all"
              >x</button>
            </div>
          )
        }

        const { agent } = item
        const paneIdx = panes.indexOf(agent.id)
        const isInPane = paneIdx !== -1 && panes.length === 1
        const isActivePane = isInPane && paneIdx === activePaneIndex
        const activity = agentActivities.get(agent.id)
        const isDragOver = dragOverId === agent.id
        const isPinned = pinnedTabs.has(agent.id)

        return (
          <div
            key={agent.id}
            draggable={!isPinned}
            onDragStart={(e) => !isPinned && handleDragStart(e, agent.id)}
            onDragOver={(e) => handleDragOver(e, agent.id)}
            onDragLeave={() => setDragOverId(null)}
            onDrop={(e) => handleDrop(e, agent.id)}
            onDragEnd={handleDragEnd}
            className={`flex items-center gap-1.5 px-3 py-2 ${isPinned ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'} text-sm border-r border-[var(--border-color)] min-w-0 transition-colors select-none ${
              isDragOver ? 'border-l-2 border-l-blue-500' : ''
            } ${
              isActivePane && !isLauncherActive
                ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            onClick={() => onSelectAgent(agent.id)}
            onMouseDown={(e) => {
              if (e.button === 1 && !isPinned) { e.preventDefault(); agent.status === 'running' ? onKillAgent(agent.id) : onCloseAgent(agent.id) }
            }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setTabMenu({ x: e.clientX, y: e.clientY, agentId: agent.id }) }}
          >
            {isPinned && (
              <svg viewBox="0 0 16 16" className="w-3 h-3 text-neutral-500 shrink-0" fill="currentColor"><path d="M9.828 1.282a1 1 0 0 1 1.414 0l3.476 3.476a1 1 0 0 1 0 1.414L13.5 7.39l.914.914a.5.5 0 0 1-.353.854H10.5L7.707 12.95a.5.5 0 0 1-.707 0L5.586 11.5 2.354 14.732a.5.5 0 0 1-.708-.708L4.879 10.79 3.05 8.96a.5.5 0 0 1 0-.707L6.843 5.46V1.9a.5.5 0 0 1 .854-.354l.914.914 1.217-1.178z" /></svg>
            )}
            <AgentIndicator status={agent.status} activity={activity} />
            {renamingId === agent.id ? (
              <input
                autoFocus
                type="text"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => commitRename(agent.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename(agent.id) }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelRename() }
                }}
                onClick={(e) => e.stopPropagation()}
                className="h-5 min-w-[80px] max-w-[180px] text-sm bg-neutral-950 text-neutral-50 rounded px-1.5 border border-neutral-700 focus:outline-none focus:border-blue-500"
              />
            ) : (
              <span
                className="truncate"
                onDoubleClick={(e) => { e.stopPropagation(); startRename(agent) }}
                title="Double-click to rename"
              >
                {agent.tab_name || 'Agent'}
              </span>
            )}
            <ActivityLabel status={agent.status} activity={activity} />
            {!isPinned && (agent.status === 'running' ? (
              <button onClick={(e) => { e.stopPropagation(); onKillAgent(agent.id) }} className="ml-1 w-4 h-4 flex items-center justify-center rounded text-xs hover:bg-red-500/30 hover:text-red-300 text-[var(--text-secondary)] transition-colors" title="Kill agent">x</button>
            ) : (
              <button onClick={(e) => { e.stopPropagation(); onCloseAgent(agent.id) }} className="ml-1 w-4 h-4 flex items-center justify-center rounded text-xs hover:bg-neutral-500/30 hover:text-neutral-300 text-[var(--text-secondary)] transition-colors" title="Close tab">x</button>
            ))}
          </div>
        )
      })}

      {launcherOpen && (
        <div
          className={`flex items-center gap-1.5 px-3 py-2 cursor-pointer text-sm border-r border-[var(--border-color)] min-w-0 transition-colors ${
            isLauncherActive ? 'bg-[var(--bg-primary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
          }`}
          onClick={onSelectLauncher}
        >
          <span className="flex items-center justify-center w-4 h-4">
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-neutral-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v10M3 8h10" strokeLinecap="round" /></svg>
          </span>
          <span className="truncate">New</span>
          <button onClick={(e) => { e.stopPropagation(); onCloseLauncher() }} className="ml-1 w-4 h-4 flex items-center justify-center rounded text-xs hover:bg-neutral-500/30 hover:text-neutral-300 text-[var(--text-secondary)] transition-colors" title="Close">x</button>
        </div>
      )}

      <button
        onClick={onNewAgent}
        disabled={isSpawning || launcherOpen}
        className="flex items-center justify-center w-8 h-8 mx-1 rounded text-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 transition-colors shrink-0"
        title="New tab (⌘T)"
      >
        +
      </button>

      {/* Tab context menu */}
      {tabMenu && (() => {
        const agent = agents.find((a) => a.id === tabMenu.agentId)
        if (!agent) return null
        const isPinned = pinnedTabs.has(agent.id)
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setTabMenu(null)} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null) }} />
            <div className="fixed z-50 bg-neutral-900 border border-neutral-700 rounded-lg py-1 shadow-xl min-w-[160px]" style={{ left: tabMenu.x, top: tabMenu.y }}>
              <div className="px-3 h-8 flex items-center text-[13px] text-neutral-200 hover:bg-neutral-800 rounded mx-1 cursor-pointer transition-colors"
                onClick={() => { startRename(agent); setTabMenu(null) }}>
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-neutral-400" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M11.5 2.5l2 2-7 7-2.5.5.5-2.5z" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Rename…
              </div>
              <div className="px-3 h-8 flex items-center text-[13px] text-neutral-200 hover:bg-neutral-800 rounded mx-1 cursor-pointer transition-colors"
                onClick={() => { togglePinTab(agent.id); setTabMenu(null) }}>
                {isPinned ? (
                  <><svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-neutral-400" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>Unpin Tab</>
                ) : (
                  <><svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2 text-neutral-400" fill="currentColor"><path d="M9.828 1.282a1 1 0 0 1 1.414 0l3.476 3.476a1 1 0 0 1 0 1.414L13.5 7.39l.914.914a.5.5 0 0 1-.353.854H10.5L7.707 12.95a.5.5 0 0 1-.707 0L5.586 11.5 2.354 14.732a.5.5 0 0 1-.708-.708L4.879 10.79 3.05 8.96a.5.5 0 0 1 0-.707L6.843 5.46V1.9a.5.5 0 0 1 .854-.354l.914.914 1.217-1.178z" /></svg>Pin Tab</>
                )}
              </div>
              {!isPinned && (
                <div className="px-3 h-8 flex items-center text-[13px] text-red-400 hover:bg-red-950/40 rounded mx-1 cursor-pointer transition-colors"
                  onClick={() => {
                    if (agent.status === 'running') onKillAgent(agent.id)
                    else onCloseAgent(agent.id)
                    setTabMenu(null)
                  }}>
                  <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 mr-2" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" /></svg>
                  {agent.status === 'running' ? 'Kill & Close' : 'Close Tab'}
                </div>
              )}
            </div>
          </>
        )
      })()}
    </div>
  )
}
