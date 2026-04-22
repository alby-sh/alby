import { useEffect, useRef, useState, useCallback, memo } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  agentId: string
  registerWriter: (agentId: string, writer: (data: string) => void) => void
  visible?: boolean
  // Routines share the renderer path with agents but use a separate IPC namespace
  // for stdin/resize so the main process routes to RoutineManager instead of AgentManager.
  kind?: 'agent' | 'routine'
}

export const TerminalPanel = memo(function TerminalPanel({ agentId, registerWriter, visible = true, kind = 'agent' }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const bufferRef = useRef<string[]>([])
  const readyRef = useRef(false)
  const [isScrolledUp, setIsScrolledUp] = useState(false)
  const [reattachState, setReattachState] = useState<'idle' | 'connecting' | 'failed'>('idle')
  const [reattachMessage, setReattachMessage] = useState<string | null>(null)

  const scrollToBottom = useCallback(() => {
    if (termRef.current) {
      termRef.current.scrollToBottom()
      setIsScrolledUp(false)
    }
  }, [])

  // Register writer immediately — buffer until terminal is ready
  useEffect(() => {
    registerWriter(agentId, (data: string) => {
      if (readyRef.current && termRef.current) {
        termRef.current.write(data)
      } else {
        bufferRef.current.push(data)
      }
    })
  }, [agentId, registerWriter])

  // Listen for main-process reattach events for this agent so we can show a
  // visible "Reconnecting…" overlay instead of a blank pane while ssh+tmux
  // come back up after long idleness.
  useEffect(() => {
    if (kind !== 'agent') return
    const unsub = window.electronAPI.agents.onReattach((data) => {
      if (data.agentId !== agentId) return
      if (data.state === 'connecting') {
        setReattachState('connecting')
        setReattachMessage(null)
      } else if (data.state === 'connected') {
        setReattachState('idle')
        setReattachMessage(null)
      } else {
        setReattachState('failed')
        setReattachMessage(data.message ?? 'Reconnection failed.')
      }
    })
    // Kick a server-side ensure-attached so a stale agent gets reattached as
    // soon as the user opens the tab — fixes "click tab, blank screen" after
    // long idleness or a fresh-install boot.
    window.electronAPI.agents.ensureAttached(agentId).catch(() => { /* ignore */ })
    return unsub
  }, [agentId, kind])

  // Initialize terminal once
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Guards against async work (webgl import, rAF) racing the unmount teardown.
    // Without these a late callback calls methods on a disposed xterm and throws,
    // which — with no error boundary above — would black out the whole MainArea.
    let disposed = false

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Monaco', 'Menlo', monospace",
      theme: {
        background: '#0f0f0f',
        foreground: '#e5e5e5',
        cursor: '#3b82f6',
        selectionBackground: '#3b82f640',
        black: '#1a1a1a',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#3b82f6',
        magenta: '#a855f7',
        cyan: '#06b6d4',
        white: '#e5e5e5'
      },
      cursorBlink: true,
      scrollback: 5000,
      convertEol: true,
      allowProposedApi: true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      window.open(uri, '_blank')
    }))

    // WebGL renderer is loaded lazily per-visible pane via the separate
    // useEffect below. We intentionally don't load it unconditionally here
    // because browsers cap WebGL contexts at ~16 per page; when every agent
    // tab mounted its own WebGL context, xterm started evicting them and
    // newly-opened terminals rendered blank. The lazy path keeps at most
    // MAX_PANES (=4) contexts live at once — one per visible pane.

    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // Batch keystrokes to reduce IPC calls (flush every 8ms or on special keys)
    let stdinBuffer = ''
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flushStdin = () => {
      if (stdinBuffer) {
        if (kind === 'routine') window.electronAPI.routines.writeStdin(agentId, stdinBuffer)
        else window.electronAPI.agents.writeStdin(agentId, stdinBuffer)
        stdinBuffer = ''
      }
      flushTimer = null
    }
    term.onData((data) => {
      stdinBuffer += data
      // Flush immediately for control characters (Enter, Ctrl+C, etc.)
      if (data.length === 1 && data.charCodeAt(0) < 32) {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
        flushStdin()
      } else if (!flushTimer) {
        flushTimer = setTimeout(flushStdin, 8)
      }
    })

    // Always make the wheel navigate xterm's scrollback, never let xterm's
    // default behavior fire. Without this xterm would either:
    //  - convert wheel into arrow-key escape sequences (so Claude Code would
    //    pop up its prompt history when the user tries to scroll up), or
    //  - forward the wheel as a mouse-tracking event to the app, which most
    //    agent CLIs don't actually consume in any useful way.
    // Returning `false` from the custom handler prevents xterm's default.
    term.attachCustomWheelEventHandler((e: WheelEvent) => {
      const t = termRef.current
      if (!t) return false
      // Match macOS native scroll feel: ~3 lines per notch, scaled by deltaY.
      const lines = Math.sign(e.deltaY) * Math.max(1, Math.min(8, Math.round(Math.abs(e.deltaY) / 16)))
      t.scrollLines(lines)
      return false
    })

    // Detect scroll position to show/hide "scroll to bottom" button
    term.onScroll(() => {
      const buffer = term.buffer.active
      setIsScrolledUp(buffer.viewportY < buffer.baseY)
    })

    term.onWriteParsed(() => {
      const buffer = term.buffer.active
      if (buffer.viewportY >= buffer.baseY - 1) setIsScrolledUp(false)
    })

    // Copy without trailing whitespace (like iTerm2) + Shift+Enter → newline.
    // By default xterm sends bare \r for every Enter, so Claude/Gemini/Codex
    // can't tell Shift+Enter apart from plain Enter.
    //
    // We send `backslash` then `\r` as two separate writeStdin calls, with a
    // tiny delay in between. That matches what a user physically typing
    // `\<Enter>` would produce in the PTY, which is Claude Code's documented
    // multi-line escape ("type \ then Enter") AND Gemini / Codex treat the
    // same way. Sending both bytes in one chunk previously tripped a
    // paste-detection heuristic in newer Claude Code that dropped the
    // backslash and submitted bare \r, defeating the whole thing.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && term.hasSelection()) {
        const cleaned = term.getSelection().split('\n').map((l) => l.trimEnd()).join('\n')
        navigator.clipboard.writeText(cleaned)
        term.clearSelection()
        return false // prevent default
      }
      if (
        e.type === 'keydown' &&
        e.key === 'Enter' &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const writer = kind === 'routine'
          ? window.electronAPI.routines.writeStdin
          : window.electronAPI.agents.writeStdin
        writer(agentId, '\\')
        setTimeout(() => writer(agentId, '\r'), 15)
        return false
      }
      return true
    })

    // Debounced fit + resize — avoids flooding IPC during window drag
    let lastCols = 0, lastRows = 0
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const doFit = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        try {
          fit.fit()
          const { cols, rows } = term
          if (cols > 0 && rows > 0 && (cols !== lastCols || rows !== lastRows)) {
            lastCols = cols; lastRows = rows
            if (kind === 'routine') window.electronAPI.routines.resize(agentId, cols, rows)
            else window.electronAPI.agents.resize(agentId, cols, rows)
          }
        } catch { /* ignore */ }
      }, 50)
    }

    const resizeObserver = new ResizeObserver(() => doFit())
    resizeObserver.observe(container)

    // Flush buffered data after terminal is ready
    requestAnimationFrame(() => {
      if (disposed) return
      // Initial fit without debounce
      try {
        fit.fit()
        lastCols = term.cols; lastRows = term.rows
        if (lastCols > 0 && lastRows > 0) {
          if (kind === 'routine') window.electronAPI.routines.resize(agentId, lastCols, lastRows)
          else window.electronAPI.agents.resize(agentId, lastCols, lastRows)
        }
      } catch { /* ignore */ }
      try {
        for (const chunk of bufferRef.current) {
          term.write(chunk)
        }
      } catch { /* ignore */ }
      bufferRef.current = []
      readyRef.current = true
    })

    return () => {
      disposed = true
      readyRef.current = false
      if (flushTimer) clearTimeout(flushTimer)
      if (resizeTimer) clearTimeout(resizeTimer)
      try { resizeObserver.disconnect() } catch { /* ignore */ }
      try { term.dispose() } catch { /* ignore */ }
      termRef.current = null
      fitRef.current = null
    }
  }, [agentId])

  // When visibility changes, refit
  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
          const term = termRef.current
          if (term && term.cols > 0 && term.rows > 0) {
            if (kind === 'routine') window.electronAPI.routines.resize(agentId, term.cols, term.rows)
            else window.electronAPI.agents.resize(agentId, term.cols, term.rows)
          }
        } catch { /* ignore */ }
      })
    }
  }, [visible, agentId, kind])

  // Load WebGL addon lazily, only while this pane is visible. When the pane
  // goes offscreen we dispose the WebGL context so the ~16-per-page browser
  // cap never gets hit even when the user has dozens of tabs open. The DOM
  // renderer (xterm's fallback) handles hidden panes, and since they're not
  // being rendered anyway the slower fallback is invisible.
  useEffect(() => {
    if (!visible) return
    let disposed = false
    let webgl: import('@xterm/addon-webgl').WebglAddon | null = null
    import('@xterm/addon-webgl').then(({ WebglAddon }) => {
      if (disposed || !termRef.current) return
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          try { webgl?.dispose() } catch { /* ignore */ }
          webgl = null
        })
        termRef.current.loadAddon(webgl)
      } catch {
        /* GPU unavailable — DOM renderer takes over silently. */
      }
    }).catch(() => { /* dynamic import failed — DOM renderer takes over silently. */ })
    return () => {
      disposed = true
      if (webgl) {
        try { webgl.dispose() } catch { /* ignore */ }
        webgl = null
      }
    }
  }, [visible])

  // Focus this terminal when its container is clicked
  const handleClick = useCallback(() => {
    termRef.current?.focus()
  }, [])

  // Terminal context menu (right-click → copy/paste)
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const term = termRef.current
    if (!term) return

    const hasSelection = term.hasSelection()

    // Create a simple native-style context menu overlay
    const menu = document.createElement('div')
    menu.className = 'fixed z-50 bg-neutral-900 border border-neutral-700 rounded-lg py-1 shadow-xl min-w-[140px]'
    menu.style.left = `${e.clientX}px`
    menu.style.top = `${e.clientY}px`

    const addItem = (label: string, onClick: () => void, enabled = true) => {
      const item = document.createElement('div')
      item.className = `px-3 h-8 flex items-center text-[13px] rounded mx-1 transition-colors ${enabled ? 'text-neutral-200 hover:bg-neutral-800 cursor-pointer' : 'text-neutral-600 cursor-default'}`
      item.textContent = label
      if (enabled) item.onclick = () => { onClick(); menu.remove() }
      menu.appendChild(item)
    }

    addItem('Copy', () => {
      if (hasSelection) {
        navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
      }
    }, hasSelection)

    addItem('Paste', () => {
      navigator.clipboard.readText().then((text) => {
        if (text) {
          if (kind === 'routine') window.electronAPI.routines.writeStdin(agentId, text)
          else window.electronAPI.agents.writeStdin(agentId, text)
        }
      })
    })

    addItem('Select All', () => { term.selectAll() })

    document.body.appendChild(menu)
    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close) }
    }
    setTimeout(() => document.addEventListener('mousedown', close), 0)
  }, [agentId, kind])

  return (
    <div
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div
        ref={containerRef}
        style={{ position: 'absolute', top: 8, left: 8, right: 8, bottom: 8 }}
      />

      {isScrolledUp && visible && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 w-8 h-8 rounded-full bg-neutral-800 border border-neutral-600 flex items-center justify-center text-neutral-300 hover:bg-neutral-700 hover:text-white shadow-lg transition-all z-10"
          title="Scroll to bottom"
        >
          <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      {reattachState !== 'idle' && visible && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-none">
          <div className="flex flex-col items-center gap-3 max-w-[420px] text-center px-6">
            {reattachState === 'connecting' ? (
              <>
                <svg viewBox="0 0 24 24" className="w-10 h-10 animate-spin" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="#60a5fa" strokeWidth="2" opacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <div className="text-[14px] text-neutral-100 font-medium">Reconnecting to remote…</div>
                <div className="text-[12px] text-neutral-400">Re-establishing SSH and reattaching to the tmux session.</div>
              </>
            ) : (
              <>
                <div className="w-10 h-10 rounded-full bg-red-500/15 text-red-300 flex items-center justify-center text-[20px]">!</div>
                <div className="text-[14px] text-neutral-100 font-medium">Could not reconnect</div>
                <div className="text-[12px] text-neutral-400">{reattachMessage}</div>
                <button
                  type="button"
                  onClick={() => {
                    setReattachState('connecting')
                    setReattachMessage(null)
                    window.electronAPI.agents.ensureAttached(agentId).catch(() => { /* ignore */ })
                  }}
                  className="pointer-events-auto mt-1 h-8 px-3 rounded-md text-[12px] border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 text-neutral-200 transition-colors"
                >
                  Retry
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
