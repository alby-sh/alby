import { useRef, useEffect, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

export function useTerminal(agentId: string | null) {
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const initTerminal = useCallback((container: HTMLDivElement | null) => {
    if (!container) return
    containerRef.current = container

    if (termRef.current) {
      termRef.current.dispose()
    }

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
      scrollback: 10000,
      convertEol: true
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(container)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
    })
    resizeObserver.observe(container)

    // Handle user input -> stdin
    if (agentId) {
      term.onData((data) => {
        window.electronAPI.agents.writeStdin(agentId, data)
      })
    }

    return () => {
      resizeObserver.disconnect()
    }
  }, [agentId])

  const writeToTerminal = useCallback((data: string) => {
    termRef.current?.write(data)
  }, [])

  useEffect(() => {
    return () => {
      termRef.current?.dispose()
      termRef.current = null
    }
  }, [])

  return {
    initTerminal,
    writeToTerminal,
    terminal: termRef,
    fit: fitRef
  }
}
