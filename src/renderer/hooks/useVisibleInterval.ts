import { useEffect, useRef, type DependencyList } from 'react'

interface Options {
  /** Skip the call on mount / dependency change. Defaults to false. */
  skipLeading?: boolean
}

/**
 * setInterval that only runs while the window is visible.
 *
 * The main process sets `webContents.backgroundThrottling = false` so terminal
 * output and the heartbeat timers survive in the background. The side effect is
 * that every other timer keeps its full rate too, and several of them reach for
 * the network on each tick — git status over SSH, task counts, deploy state.
 * Minimise Alby with a few environments open and it carries on issuing SSH
 * commands nobody asked for, around the clock.
 *
 * The interval is alive only while the document is visible, and the callback
 * fires again on the way back so the view is current by the time it is looked
 * at — a poll skipped while hidden is deferred, not lost.
 *
 * `deps` behaves like the useEffect dependency list: changing it re-runs the
 * callback immediately and restarts the interval, which is what callers relied
 * on when they keyed their effect on an id.
 *
 * Only for refreshing what the user is looking at. Anything that has to keep
 * counting or listening while hidden — heartbeats, agent activity, idle
 * notifications — must keep a plain interval.
 */
export function useVisibleInterval(
  callback: () => void,
  delayMs: number,
  deps: DependencyList = [],
  options: Options = {}
): void {
  const saved = useRef(callback)
  saved.current = callback

  const { skipLeading = false } = options

  useEffect(() => {
    let timer: number | null = null

    const stop = (): void => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }

    const start = (): void => {
      stop()
      timer = window.setInterval(() => saved.current(), delayMs)
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop()
        return
      }
      saved.current()
      start()
    }

    if (!skipLeading) saved.current()
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delayMs, skipLeading, ...deps])
}
