// Renderer-side error pipe into the Alby detector.
//
// Main-process uncaught exceptions and unhandled rejections are handled by
// `@alby-sh/report` itself (autoRegister is on by default when Alby.init()
// runs in src/main/index.ts). That leaves renderer-side errors, which can't
// call the SDK directly because the renderer is sandboxed. They're forwarded
// here over IPC and we hand them to the same Alby client.
//
// Before this file was a separate Wachey integration with embedded credentials;
// that was removed so the OSS source doesn't ship a third-party API key and so
// error data never leaves the Alby stack.

import { app, ipcMain } from 'electron'
import { Alby } from '@alby-sh/report'

const DEDUP_WINDOW_MS = 60_000
const seen = new Map<string, number>()
let installed = false

interface RendererPayload {
  error: string
  stack?: string
  path?: string
  line?: number
  context?: Record<string, unknown>
}

function shouldReport(key: string): boolean {
  // Skip in dev — we don't want local development noise hitting the dashboard.
  if (!app.isPackaged) return false
  const now = Date.now()
  const last = seen.get(key)
  if (last && now - last < DEDUP_WINDOW_MS) return false
  seen.set(key, now)
  if (seen.size > 200) {
    const cutoff = now - DEDUP_WINDOW_MS
    for (const [k, t] of seen) if (t < cutoff) seen.delete(k)
  }
  return true
}

export function initErrorReporting(): void {
  if (installed) return
  installed = true

  ipcMain.on('errors:report', (_event, payload: RendererPayload) => {
    if (!payload?.error || payload.error.length < 3) return
    const key = `renderer|${payload.error}|${payload.path ?? ''}|${payload.line ?? ''}`
    if (!shouldReport(key)) return

    // Rebuild a synthetic Error so the SDK produces a proper exception event
    // with stack frames, instead of a plain captureMessage. Renderer already
    // sends us the stack string verbatim.
    const err = new Error(payload.error)
    if (payload.stack) err.stack = payload.stack

    Alby.captureException(err, {
      tags: { source: 'renderer' },
      extra: {
        path: payload.path,
        line: payload.line,
        ...payload.context,
      },
    })
  })
}
