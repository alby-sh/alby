import { useCallback, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useStartRoutine, useStopRoutine, useRoutineStatusChange } from '../../hooks/useRoutines'
import { useAgentStdout } from '../../hooks/useAgents'
import type { Routine } from '../../../shared/types'

interface Props {
  routineId: string
}

export function RoutineView({ routineId }: Props) {
  const { data: routine } = useQuery<Routine | undefined>({
    queryKey: ['routines', 'get', routineId],
    queryFn: () => window.electronAPI.routines.get(routineId) as Promise<Routine | undefined>,
    refetchInterval: 5000,
  })

  const startRoutine = useStartRoutine()
  const stopRoutine = useStopRoutine()

  const writersRef = useRef<Map<string, (data: string) => void>>(new Map())
  const registerWriter = useCallback((id: string, writer: (data: string) => void) => {
    writersRef.current.set(id, writer)
  }, [])

  // Forward agent:stdout events (routines emit on the same channel) to the registered writer.
  const handleStdout = useCallback((data: { agentId: string; data: string }) => {
    writersRef.current.get(data.agentId)?.(data.data)
  }, [])
  useAgentStdout(handleStdout)

  // React to backend status flips so the UI doesn't have to wait for the 5s refetch.
  const handleStatus = useCallback((_: { routineId: string; running: boolean; exitCode?: number }) => {
    // useRoutineStatusChange already invalidates queries; nothing to do here.
  }, [])
  useRoutineStatusChange(handleStatus)

  // When the routine is not running anymore, drop its writer so stale terminals
  // don't accumulate in memory.
  useEffect(() => {
    if (routine && !routine.tmux_session_name) {
      writersRef.current.delete(routineId)
    }
  }, [routine, routineId])

  if (!routine) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
        <p className="text-sm">Routine not found</p>
      </div>
    )
  }

  const isRunning = !!routine.tmux_session_name

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
      <div className="flex items-center h-10 px-4 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500' : 'bg-neutral-600'}`} />
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">{routine.name}</span>
          <span className="text-xs text-[var(--text-secondary)] truncate">· {routine.agent_type} · {routine.cron_expression}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isRunning ? (
            <button
              onClick={() => stopRoutine.mutate(routineId)}
              disabled={stopRoutine.isPending}
              className="px-3 py-1 text-xs rounded bg-neutral-800 hover:bg-neutral-700 border border-[var(--border-color)] disabled:opacity-50"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => startRoutine.mutate(routineId)}
              disabled={startRoutine.isPending}
              className="px-3 py-1 text-xs rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white disabled:opacity-50"
            >
              {startRoutine.isPending ? 'Starting...' : 'Start'}
            </button>
          )}
        </div>
      </div>

      {startRoutine.isError && (
        <div className="px-4 py-2 bg-red-900/40 border-b border-red-700 text-red-200 text-xs">
          Start failed: {startRoutine.error instanceof Error ? startRoutine.error.message : String(startRoutine.error)}
        </div>
      )}
      {stopRoutine.isError && (
        <div className="px-4 py-2 bg-red-900/40 border-b border-red-700 text-red-200 text-xs">
          Stop failed: {stopRoutine.error instanceof Error ? stopRoutine.error.message : String(stopRoutine.error)}
        </div>
      )}

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {isRunning ? (
          <ErrorBoundary>
            <TerminalPanel agentId={routineId} registerWriter={registerWriter} kind="routine" />
          </ErrorBoundary>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[var(--text-secondary)]">
            <div className="text-center">
              <p className="text-sm mb-2">Routine is stopped</p>
              <p className="text-xs opacity-60">Click Start to open the tmux session on the server.</p>
              {routine.last_exit_code != null && (
                <p className="text-xs text-amber-400 mt-2">Last exit code: {routine.last_exit_code}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
