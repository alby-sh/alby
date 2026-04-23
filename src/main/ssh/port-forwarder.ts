import net from 'net'
import { EventEmitter } from 'events'
import { shell } from 'electron'
import type { Client } from 'ssh2'
import type { ForwardedPort } from '../../shared/types'

/**
 * Per-launch-agent SSH local port forwarder.
 *
 * One instance is owned by AgentManager for the lifetime of a single launch
 * agent (the terminal that runs the env's `launch_command`, identified by a
 * `▶ ` tab_name prefix — see shared/launch-agent.ts). When the launch agent
 * exits/is killed, we call `dispose()` to tear down every forward.
 *
 * Why per-agent and not per-env:
 *   - Stop/Kill semantics naturally close only this launch agent's ports.
 *   - Two launch agents on the same env (rare but possible) get independent
 *     local ports — no shared state to race over.
 *   - The SSH client is shared via the connection pool anyway, so per-agent
 *     vs per-env duplicates no resource other than this small object.
 *
 * SSH client lifecycle is handled via the `getSSHClient` getter rather than a
 * stored reference — when the connection pool reconnects after a network
 * blip, it hands out a brand-new ssh2 Client, and we want subsequent
 * forwardOut calls to use the fresh one. Callers (AgentManager) pass a
 * closure that reads from the pool on every invocation.
 *
 * Local-port choice:
 *   - First try the same number as the remote port, so http://localhost:5000
 *     on the remote becomes http://localhost:5000 here, matching the URL the
 *     framework printed.
 *   - On EADDRINUSE (some other local process is on that port), fall back to
 *     a random free port chosen by the OS via `listen(0)`. The renderer must
 *     therefore always show `local_port`, not `remote_port`.
 */

interface ForwardEntry {
  server: net.Server
  remotePort: number
  localPort: number
  openedAt: string
}

export interface PortForwarderEvents {
  'port-opened': (port: ForwardedPort) => void
  'port-closed': (port: ForwardedPort) => void
  'change': (ports: ForwardedPort[]) => void
}

export class PortForwarder extends EventEmitter {
  private servers = new Map<number, ForwardEntry>()
  /** Outstanding ensurePort calls, keyed by remote port, so concurrent
   *  detections of the same port (a chunk that mentions it twice, or two
   *  chunks back-to-back) collapse into one bind attempt. */
  private inflight = new Map<number, Promise<void>>()
  private disposed = false

  constructor(
    private readonly agentId: string,
    private readonly environmentId: string,
    private readonly getSSHClient: () => Client | undefined,
    /** Invoked once when a port is successfully bound and the user-facing
     *  URL is ready. AgentManager forwards this to the renderer (toast) AND
     *  opens the page in the system browser. */
    private readonly onPortOpened: (port: ForwardedPort) => void,
  ) {
    super()
  }

  /** Forward the given remote port to a local port (same number if free,
   *  else a random one). Idempotent — duplicate calls are no-ops. Errors
   *  are swallowed (logged) because port forwarding is a "nice to have" —
   *  it must never crash the agent that triggered it. */
  async ensurePort(remotePort: number): Promise<void> {
    if (this.disposed) return
    if (this.servers.has(remotePort)) return

    const existing = this.inflight.get(remotePort)
    if (existing) return existing

    const promise = this.bind(remotePort).finally(() => {
      this.inflight.delete(remotePort)
    })
    this.inflight.set(remotePort, promise)
    return promise
  }

  private async bind(remotePort: number): Promise<void> {
    // Guard against the race where dispose() ran while we were queued.
    if (this.disposed) return

    const handler = (socket: net.Socket): void => {
      // Per-connection: ask SSH to open a "direct-tcpip" channel to the
      // remote 127.0.0.1:remotePort, then pipe both directions. If SSH is
      // gone (pool not connected, sleep-killed socket, …), close the
      // local socket cleanly so the user's HTTP client gets a normal
      // connection-refused style error instead of hanging.
      const client = this.getSSHClient()
      if (!client) {
        socket.destroy()
        return
      }
      const srcPort = socket.remotePort ?? 0
      try {
        client.forwardOut('127.0.0.1', srcPort, '127.0.0.1', remotePort, (err, stream) => {
          if (err) {
            console.warn(`[PortForwarder ${this.agentId}] forwardOut failed for :${remotePort}:`, err.message)
            try { socket.destroy() } catch { /* ignore */ }
            return
          }
          // ssh2 stream is a Duplex — pipe in both directions. Errors on
          // either side close the pair; ssh2 occasionally emits 'error'
          // late (e.g. when the remote app shuts down mid-request) so we
          // attach handlers on both ends.
          socket.on('error', () => { try { stream.end() } catch { /* ignore */ } })
          stream.on('error', () => { try { socket.destroy() } catch { /* ignore */ } })
          socket.pipe(stream).pipe(socket)
        })
      } catch (err) {
        console.warn(`[PortForwarder ${this.agentId}] forwardOut throw for :${remotePort}:`, (err as Error).message)
        try { socket.destroy() } catch { /* ignore */ }
      }
    }

    let server: net.Server | null = null
    let localPort = 0

    // Try the matching local port first (so the URL announced by the
    // framework "just works" here too). Fallback to OS-chosen random port
    // on EADDRINUSE / EACCES / any other listen error.
    for (const candidate of [remotePort, 0]) {
      const attempt = net.createServer(handler)
      try {
        localPort = await listenOnce(attempt, candidate, '127.0.0.1')
        server = attempt
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (candidate === remotePort && (code === 'EADDRINUSE' || code === 'EACCES')) {
          // expected — close this attempt and fall through to candidate=0
          try { attempt.close() } catch { /* ignore */ }
          continue
        }
        try { attempt.close() } catch { /* ignore */ }
        console.warn(`[PortForwarder ${this.agentId}] listen failed for :${remotePort}:`, (err as Error).message)
        return
      }
    }
    if (!server) return

    // dispose() may have run while we were awaiting listen — drop the
    // newly-bound server in that case so we don't leak the socket.
    if (this.disposed) {
      try { server.close() } catch { /* ignore */ }
      return
    }

    // Crash-safety: if the local server itself errors out later (rare —
    // OS-level ENFILE etc), drop the entry so a re-detect can re-bind.
    server.on('error', (err) => {
      console.warn(`[PortForwarder ${this.agentId}] local server error on :${localPort}:`, err.message)
    })
    server.on('close', () => {
      const entry = this.servers.get(remotePort)
      if (entry?.server === server) this.servers.delete(remotePort)
    })

    const entry: ForwardEntry = {
      server,
      remotePort,
      localPort,
      openedAt: new Date().toISOString(),
    }
    this.servers.set(remotePort, entry)

    const port: ForwardedPort = {
      agent_id: this.agentId,
      environment_id: this.environmentId,
      remote_port: remotePort,
      local_port: localPort,
      opened_at: entry.openedAt,
    }

    console.log(`[PortForwarder ${this.agentId}] forwarding :${remotePort} → 127.0.0.1:${localPort}`)
    this.onPortOpened(port)
    this.emit('port-opened', port)
    this.emit('change', this.list())

    // User explicitly asked for the page to auto-open after the forward
    // is in place. We pop the URL into the system browser via electron's
    // `shell.openExternal` — this respects the OS default browser and
    // ensures the user doesn't have to click anything to see their app.
    try {
      shell.openExternal(`http://localhost:${localPort}`).catch((err) => {
        console.warn(`[PortForwarder ${this.agentId}] openExternal failed:`, (err as Error).message)
      })
    } catch (err) {
      console.warn(`[PortForwarder ${this.agentId}] openExternal threw:`, (err as Error).message)
    }
  }

  list(): ForwardedPort[] {
    return [...this.servers.values()].map((e) => ({
      agent_id: this.agentId,
      environment_id: this.environmentId,
      remote_port: e.remotePort,
      local_port: e.localPort,
      opened_at: e.openedAt,
    }))
  }

  /** Close every local server. Called from AgentManager when the launch
   *  agent exits (process exited, user clicked Stop, SSH dropped past
   *  recovery). After this the instance is dead — do not reuse. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const closed = this.list()
    for (const [, entry] of this.servers) {
      try { entry.server.close() } catch { /* ignore */ }
    }
    this.servers.clear()
    for (const port of closed) this.emit('port-closed', port)
    this.emit('change', [])
  }

  isDisposed(): boolean {
    return this.disposed
  }
}

/** Wrap net.Server.listen in a one-shot promise. Resolves with the actual
 *  bound port (which may differ from `port` when 0 was passed). Rejects on
 *  the first 'error' event; callers detect EADDRINUSE on `err.code`. */
function listenOnce(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const addr = server.address()
      if (typeof addr === 'object' && addr) resolve(addr.port)
      else resolve(port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
