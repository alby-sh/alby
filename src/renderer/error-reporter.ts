// Renderer-side bridge to the main-process error reporter. Picks up:
//   - synchronous errors caught by window.onerror
//   - unhandled promise rejections
//   - errors thrown out of React (forwarded by ErrorBoundary.onError)
//
// Forwards everything to main via electronAPI.errors.report — main owns
// dedup and hands the event to the Alby detector SDK.

interface ReportPayload {
  error: string
  stack?: string
  path?: string
  line?: number
  context?: Record<string, unknown>
}

function describe(err: unknown): ReportPayload {
  if (err instanceof Error) {
    return {
      error: err.message || err.name || String(err),
      stack: err.stack ?? undefined,
    }
  }
  if (typeof err === 'string') return { error: err }
  try {
    return { error: JSON.stringify(err) }
  } catch {
    return { error: String(err) }
  }
}

export function reportRendererError(err: unknown, context?: Record<string, unknown>): void {
  try {
    const payload = describe(err)
    if (context) payload.context = context
    window.electronAPI.errors.report(payload)
  } catch {
    // Reporting must never throw.
  }
}

export function installRendererErrorHooks(): void {
  window.addEventListener('error', (e) => {
    reportRendererError(e.error || e.message, {
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    reportRendererError(e.reason)
  })
}
