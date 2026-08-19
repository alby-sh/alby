/**
 * Pauses CSS animations while the window is not visible.
 *
 * The main process sets `webContents.backgroundThrottling = false` so terminal
 * output and the heartbeat timers keep running while Alby sits in the
 * background (see main/index.ts). That flag is deliberate, but it also tells
 * Chromium to keep *compositing* — so every `animate-spin` / `animate-pulse`
 * in the sidebar and the tab strip carries on producing frames at 60 fps even
 * when the window is minimised or fully covered by another app.
 *
 * With several agents working, that is a handful of infinite animations
 * repainting around the clock: the GPU helper burns CPU and WindowServer burns
 * more compositing the frames nobody can see.
 *
 * Timers are untouched here — only the pixels stop. `animation-play-state`
 * (rather than `animation: none`) keeps each animation's progress, so the
 * spinners resume mid-sweep instead of snapping back when the window returns.
 */
const HIDDEN_ATTR = 'data-window-hidden'

export function installRenderThrottle(): void {
  const root = document.documentElement

  const sync = (): void => {
    if (document.visibilityState === 'hidden') {
      root.setAttribute(HIDDEN_ATTR, 'true')
    } else {
      root.removeAttribute(HIDDEN_ATTR)
    }
  }

  document.addEventListener('visibilitychange', sync)
  sync()
}
