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

    // Wheel handling has two modes depending on which buffer is active:
    //  - Primary buffer (plain shell / terminal session): scroll xterm's
    //    native scrollback with `scrollLines` — the user is reading past
    //    output that xterm stored in memory.
    //  - Alternate buffer (Claude Code / Gemini / Codex / vim / less …):
    //    the app owns the viewport and manages its own history; xterm's
    //    scrollback is empty here because nothing is spooled. Translate
    //    the wheel into PageUp/PageDown keypresses so the TUI can do its
    //    own scrolling (Claude maps these to "scroll conversation",
    //    Gemini / Codex likewise). This is what finally makes "scroll up
    //    to re-read" work inside an AI-agent session.
    term.attachCustomWheelEventHandler((e: WheelEvent) => {
      const t = termRef.current
      if (!t) return false
      const dir = Math.sign(e.deltaY)
      if (!dir) return false
      if (t.buffer.active.type === 'alternate') {
        // PageUp = \x1b[5~ , PageDown = \x1b[6~ — universal DEC / VT
        // control sequences every TUI understands. We send 1–3 depending
        // on how hard the user flicked the wheel, so the momentum still
        // feels right.
        const pages = Math.max(1, Math.min(3, Math.round(Math.abs(e.deltaY) / 60)))
        const seq = dir > 0 ? '\x1b[6~' : '\x1b[5~'
        const writer = kind === 'routine'
          ? window.electronAPI.routines.writeStdin
          : window.electronAPI.agents.writeStdin
        for (let i = 0; i < pages; i++) writer(agentId, seq)
        return false
      }
      // Primary buffer — scroll xterm's own scrollback. Match macOS feel:
      // ~3 lines per notch, scaled by deltaY.
      const lines = dir * Math.max(1, Math.min(8, Math.round(Math.abs(e.deltaY) / 16)))
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
    // Neither bare \r, bare \n, ESC+\r, nor bracketed-paste bytes coax
    // Claude Code v2.1+ into inserting a newline — all four get interpreted
    // as "submit". The only reliable approach left is to simulate the user
    // literally typing `\` and then Enter, with a delay long enough between
    // them that Claude's paste-detection heuristic can't group them. 80ms
    // is roughly the low end of human typing cadence; any shorter and the
    // two bytes get treated as a paste and the backslash is dropped.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'c' && term.hasSelection()) {
        const cleaned = term.getSelection().split('\n').map((l) => l.trimEnd()).join('\n')
        navigator.clipboard.writeText(cleaned)
        term.clearSelection()
        return false // prevent default
      }

      // macOS-native navigation shortcuts (Cmd + arrow). xterm.js doesn't
      // intercept the Meta modifier by default — it just drops it and passes
      // the plain arrow byte to the pty, which is why the user's Cmd+Left
      // was "doing nothing visible". Translate them ourselves:
      //   Cmd+Left  → Ctrl-A  (readline beginning-of-line; works in bash,
      //               zsh, Claude's prompt editor, Python REPL, Node, …)
      //   Cmd+Right → Ctrl-E  (readline end-of-line; same support matrix)
      //   Cmd+Up    → scroll viewport to the top. In the alternate buffer
      //               (Claude / Gemini / Codex / vim / less …) send a burst
      //               of PageUp so the TUI scrolls its own history — mirrors
      //               how the wheel handler behaves.
      //   Cmd+Down  → symmetric: scroll to bottom, or burst PageDown.
      if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        const writer = kind === 'routine'
          ? window.electronAPI.routines.writeStdin
          : window.electronAPI.agents.writeStdin
        if (e.key === 'ArrowLeft') { void writer(agentId, '\x01'); return false }
        if (e.key === 'ArrowRight') { void writer(agentId, '\x05'); return false }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const alt = term.buffer.active.type === 'alternate'
          const isUp = e.key === 'ArrowUp'
          if (alt) {
            const seq = isUp ? '\x1b[5~' : '\x1b[6~'
            for (let i = 0; i < 8; i++) void writer(agentId, seq)
          } else {
            if (isUp) term.scrollToTop()
            else term.scrollToBottom()
          }
          return false
        }
      }
      if (
        e.key === 'Enter' &&
        e.shiftKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        // Return false for EVERY Shift+Enter variant (keydown/keypress/keyup)
        // to stop xterm's _keyPress from firing its own \r via
        // coreService.triggerDataEvent. Without this, the extra \r lands at
        // the pty a few ms after our byte and turns "newline" into
        // "newline + submit" in Claude Code.
        if (e.type === 'keydown') {
          const writer = kind === 'routine'
            ? window.electronAPI.routines.writeStdin
            : window.electronAPI.agents.writeStdin
          // Bare LF — Claude Code / Gemini / Codex treat CR as submit and
          // LF as "insert newline". Nothing visible ever hits the display,
          // so there's no backslash flash like with the `\<Enter>` trick.
          void writer(agentId, '\n')
        }
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

  // When visibility changes, refit + refocus. The refit has to run twice:
  // once on the current RAF so xterm picks up the revealed container size,
  // and once ~80 ms later because the WebGL renderer re-attaches
  // asynchronously and clobbers the viewport layout if we only fit once.
  // Without the double-fit, Claude / Gemini sessions coming back from
  // behind a different tab had a broken wheel-scroll hit-box (dead pixels
  // along the right / bottom edges) — fitting twice fixes that.
  useEffect(() => {
    if (!visible || !fitRef.current || !termRef.current) return
    const doFit = (): void => {
      try {
        fitRef.current?.fit()
        const term = termRef.current
        if (term && term.cols > 0 && term.rows > 0) {
          if (kind === 'routine') window.electronAPI.routines.resize(agentId, term.cols, term.rows)
          else window.electronAPI.agents.resize(agentId, term.cols, term.rows)
        }
      } catch { /* ignore */ }
    }
    const raf = requestAnimationFrame(doFit)
    const t = setTimeout(doFit, 80)
    // Refocus the terminal so keyboard input (arrows / esc / ctrl-c) goes
    // there instead of whatever DOM element the user was on before
    // switching tabs.
    termRef.current.focus()
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
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
