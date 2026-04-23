import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TerminalPanel } from '../terminal/TerminalPanel'
import { ErrorBoundary } from '../ui/ErrorBoundary'
import { useStartRoutine, useStopRoutine, useRoutineStatusChange } from '../../hooks/useRoutines'
import { useAgentStdout } from '../../hooks/useAgents'
import { useActivityStore } from '../../stores/activity-store'
import type { Routine } from '../../../shared/types'

interface Props {
  routineId: string
}

// Strip ANSI escape sequences (colors, cursor, OSC, anything starting with ESC[…)
// so we can surface Claude's plain text in the status strip. Covers the CSI
// forms routines emit (`\e[36m…\e[0m` from the loop script) and Claude's
// spinner / reset sequences. Control chars ≤ 0x1F (except newline/tab) get
// stripped too — they'd otherwise leak as weird glyphs in React text nodes.
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

/** Markers emitted by the routine's loop script (routine-manager.ts).
 *  Recognising them lets us show an iteration counter + "last run" clock
 *  without the user having to read the terminal. */
const RUN_MARKER_RE = /\[routine\] (?:running|manual run) at /
const FINISH_MARKER_RE = /\[routine\] run finished \(exit (-?\d+)\)/

/** Keywords Claude / CLI tools print when they actually need the user to
 *  do something (login, wait for quota, fix an API key). Routines run with
 *  `-p` non-interactive, so we can't auto-resolve — we just raise a banner. */
const ATTENTION_RE = /\b(rate[- ]?limit|quota|claude login|please (?:run|log ?in|authenticate)|unauthori[sz]ed|invalid api key|forbidden|401|403|not logged in|expired|captcha)\b/i

function formatRuntime(ms: number): string {
  if (ms < 1000) return '0s'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`
}

export function RoutineView({ routineId }: Props) {
  const { data: routine } = useQuery<Routine | undefined>({
    queryKey: ['routines', 'get', routineId],
    queryFn: () => window.electronAPI.routines.get(routineId) as Promise<Routine | undefined>,
    refetchInterval: 5000,
  })

  const startRoutine = useStartRoutine()
  const stopRoutine = useStopRoutine()

  // Activity state ('working' | 'idle' | undefined). RemoteAgent emits
  // `agent:activity` with agentId=routineId, and the global listener in
  // App.tsx populates the store — we just read it.
  const activity = useActivityStore((s) => s.activities.get(routineId))

  // Live state driven by the stdout stream. We keep it *outside* xterm so we
  // don't have to reach into the terminal buffer — every chunk gets parsed
  // once and the extracted facts flow into tiny React states.
  const [lastLine, setLastLine] = useState<string>('')
  const [iterCount, setIterCount] = useState<number>(0)
  const [lastRunStartedAt, setLastRunStartedAt] = useState<number | null>(null)
  const [lastRunFinishedAt, setLastRunFinishedAt] = useState<number | null>(null)
  const [lastExitCode, setLastExitCode] = useState<number | null>(null)
  const [needsAttention, setNeedsAttention] = useState<string | null>(null)
  // Partial-line buffer: stdout arrives in arbitrary chunks, the "last line"
  // we care about is the last fully-terminated line, not the fragment still
  // being typed. Keeping the trailing fragment here lets us reconstruct
  // across chunk boundaries without touching xterm.
  const pendingLineRef = useRef<string>('')

  const writersRef = useRef<Map<string, (data: string) => void>>(new Map())
  const registerWriter = useCallback((id: string, writer: (data: string) => void) => {
    writersRef.current.set(id, writer)
  }, [])

  // Forward stdout to the terminal AND tap it for the status strip.
  // We intentionally don't buffer everything — only the last line + a few
  // metadata facts — so this stays cheap even on chatty routines.
  const handleStdout = useCallback((data: { agentId: string; data: string }) => {
    writersRef.current.get(data.agentId)?.(data.data)
    if (data.agentId !== routineId) return

    const combined = pendingLineRef.current + data.data
    const parts = combined.split(/\r?\n/)
    pendingLineRef.current = parts.pop() ?? ''

    let latest = ''
    for (const rawLine of parts) {
      const line = stripAnsi(rawLine).trim()
      if (!line) continue
      latest = line
      // Loop-script markers → bump iteration + timestamps.
      if (RUN_MARKER_RE.test(line)) {
        setIterCount((n) => n + 1)
        setLastRunStartedAt(Date.now())
        setLastRunFinishedAt(null)
        setLastExitCode(null)
        setNeedsAttention(null)
        continue
      }
      const finish = FINISH_MARKER_RE.exec(line)
      if (finish) {
        setLastRunFinishedAt(Date.now())
        setLastExitCode(parseInt(finish[1], 10))
        continue
      }
      // Attention detection only on non-marker lines — the markers themselves
      // can contain "exit 1" which would otherwise trip the 401/403 regex.
      const match = ATTENTION_RE.exec(line)
      if (match) {
        setNeedsAttention(line.slice(0, 240))
      }
    }
    if (latest) setLastLine(latest)
  }, [routineId])
  useAgentStdout(handleStdout)

  // React to backend status flips so the UI doesn't have to wait for the 5s refetch.
  const handleStatus = useCallback((_: { routineId: string; running: boolean; exitCode?: number }) => {
    // useRoutineStatusChange already invalidates queries; nothing to do here.
  }, [])
  useRoutineStatusChange(handleStatus)

  // When the routine is not running anymore, drop its writer + live facts
  // so stale terminals don't accumulate in memory and the next start shows
  // a clean slate instead of the previous session's "last line".
  useEffect(() => {
    if (routine && !routine.tmux_session_name) {
      writersRef.current.delete(routineId)
      setLastLine('')
      setIterCount(0)
      setLastRunStartedAt(null)
      setLastRunFinishedAt(null)
      setLastExitCode(null)
      setNeedsAttention(null)
      pendingLineRef.current = ''
    }
  }, [routine, routineId])

  // Tick once a second while a run is in progress so the runtime clock
  // advances without us having to re-render on every stdout chunk.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!lastRunStartedAt || lastRunFinishedAt) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [lastRunStartedAt, lastRunFinishedAt])

  const isRunning = !!routine?.tmux_session_name
  const isLoop = (routine?.interval_seconds ?? 0) > 0

  // Derive what the status pill should say. The hierarchy is:
  //   attention > waiting-for-activity-signal > working > idle > default.
  // `working` and `idle` come from the tmux title poller in RemoteAgent;
  // when we haven't received one yet we fall back to a generic "Starting…"
  // so the pill doesn't look dead during the first few seconds.
  const statusPill = useMemo(() => {
    if (!isRunning) return null
    if (needsAttention) {
      return { label: 'Needs attention', color: 'amber', spinning: false }
    }
    if (activity === 'working') {
      return { label: 'Claude is working…', color: 'blue', spinning: true }
    }
    if (activity === 'idle') {
      if (isLoop && lastRunFinishedAt) {
        return { label: 'Idle — waiting for next run', color: 'neutral', spinning: false }
      }
      return { label: 'Idle', color: 'neutral', spinning: false }
    }
    return { label: 'Starting…', color: 'blue', spinning: true }
  }, [isRunning, needsAttention, activity, isLoop, lastRunFinishedAt])

  const pillColorClass = useMemo(() => {
    const c = statusPill?.color
    if (c === 'amber') return 'text-amber-300 bg-amber-500/10 border-amber-500/30'
    if (c === 'blue') return 'text-blue-300 bg-blue-500/10 border-blue-500/30'
    return 'text-neutral-300 bg-neutral-500/10 border-neutral-500/25'
  }, [statusPill])

  // Runtime of the CURRENT (or last) run. For loops we show the current
  // iteration's elapsed time; for manual runs this is "total time".
  const runtimeLabel = useMemo(() => {
    if (!lastRunStartedAt) return null
    const end = lastRunFinishedAt ?? Date.now()
    return formatRuntime(end - lastRunStartedAt)
  }, [lastRunStartedAt, lastRunFinishedAt])

  if (!routine) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
        <p className="text-sm">Routine not found</p>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, minHeight: 0 }}>
      {/* Top header row — unchanged semantics, same Start/Stop ergonomics. */}
      <div className="flex items-center h-10 px-4 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`w-2 h-2 rounded-full ${isRunning ? 'bg-green-500' : 'bg-neutral-600'}`} />
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">{routine.name}</span>
          <span className="text-xs text-[var(--text-secondary)] truncate">
            · {routine.agent_type}
            {routine.cron_expression ? ` · ${routine.cron_expression}` : isLoop ? ` · every ${routine.interval_seconds}s` : ' · manual'}
          </span>
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

      {/* Live status strip — "what Claude is doing right now". Only shown
       *  while the routine is running; otherwise the terminal placeholder
       *  already communicates "stopped". */}
      {isRunning && statusPill && (
        <div className="flex items-center gap-3 h-9 px-4 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 min-w-0">
          <span className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium ${pillColorClass}`}>
            {statusPill.spinning ? (
              <svg viewBox="0 0 16 16" className="w-3 h-3 animate-spin" fill="none" aria-hidden>
                <circle cx="8" cy="8" r="6" strokeWidth="2" stroke="currentColor" opacity="0.25" />
                <path d="M8 2a6 6 0 0 1 6 6" strokeWidth="2" stroke="currentColor" strokeLinecap="round" />
              </svg>
            ) : (
              <span className="w-1.5 h-1.5 rounded-full bg-current" />
            )}
            {statusPill.label}
          </span>
          {lastLine && (
            <span
              className="flex-1 min-w-0 truncate text-[12px] text-neutral-400 font-mono"
              title={lastLine}
            >
              {lastLine}
            </span>
          )}
          <div className="shrink-0 flex items-center gap-3 text-[11px] text-neutral-500 tabular-nums">
            {isLoop && iterCount > 0 && (
              <span title={`${iterCount} run${iterCount === 1 ? '' : 's'} since start`}>
                run #{iterCount}
              </span>
            )}
            {runtimeLabel && (
              <span title={lastRunFinishedAt ? 'Last run duration' : 'Elapsed in current run'}>
                {runtimeLabel}
              </span>
            )}
            {lastExitCode != null && lastRunFinishedAt && (
              <span className={lastExitCode === 0 ? 'text-emerald-400' : 'text-red-400'}>
                exit {lastExitCode}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Attention banner — only when we spotted a line like "rate limit"
       *  / "claude login" / "unauthorized" / etc. Routines run with `-p`
       *  so we can't forward a keystroke for the user; they need to fix
       *  it upstream (re-login, wait, update API key). */}
      {isRunning && needsAttention && (
        <div className="px-4 py-2 bg-amber-900/30 border-b border-amber-700/50 text-amber-200 text-xs flex items-start gap-2">
          <span className="mt-0.5">⚠</span>
          <div className="min-w-0">
            <div className="font-medium">This routine might need your attention</div>
            <div className="text-amber-300/80 font-mono truncate" title={needsAttention}>{needsAttention}</div>
          </div>
          <button
            onClick={() => setNeedsAttention(null)}
            className="ml-auto shrink-0 text-amber-300/70 hover:text-amber-100"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      )}

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
