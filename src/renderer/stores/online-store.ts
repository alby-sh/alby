import { create } from 'zustand'
import { useEffect } from 'react'
import { HEALTH_URL } from '../../shared/cloud-constants'

interface OnlineState {
  online: boolean
  lastCheckedAt: number
  setOnline: (v: boolean) => void
}

export const useOnlineStore = create<OnlineState>((set) => ({
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  lastCheckedAt: Date.now(),
  setOnline: (v) => set({ online: v, lastCheckedAt: Date.now() }),
}))

/**
 * React hook that tracks connectivity to alby.sh. Combines:
 *  - navigator.onLine (immediate OS signal)
 *  - a periodic ping to /api/health (catches cases where OS thinks we're online
 *    but the backend is unreachable, e.g. captive portals, VPN down, etc.)
 */
export function useOnlineBootstrap(): void {
  const setOnline = useOnlineStore((s) => s.setOnline)

  useEffect(() => {
    const onOnline = (): void => setOnline(true)
    const onOffline = (): void => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)

    let cancelled = false
    const ping = async (): Promise<void> => {
      try {
        const res = await fetch(HEALTH_URL, { cache: 'no-store' })
        if (!cancelled) setOnline(res.ok)
      } catch {
        if (!cancelled) setOnline(false)
      }
    }
    ping()
    // Poll only while visible: the browser's own online/offline events cover
    // the transitions that happen in the background, and a stale indicator on
    // a window nobody is looking at costs nothing. Ping again on the way back
    // so the dot is right by the time it is on screen.
    let timer: number | null = null
    const start = (): void => {
      if (timer === null) timer = window.setInterval(ping, 30_000)
    }
    const stop = (): void => {
      if (timer !== null) { window.clearInterval(timer); timer = null }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') { stop(); return }
      void ping()
      stop(); start()
    }
    if (document.visibilityState !== 'hidden') start()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [setOnline])
}
