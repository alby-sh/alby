/**
 * Pure regex-based detection of localhost URLs in a stdout chunk from a
 * remote launch agent. Returns the *unique* set of port numbers the chunk
 * announces, in first-seen order.
 *
 * No SSH calls, no polling — we just sniff the bytes that already pass
 * through main/agents/remote-agent.ts on their way to the renderer. Most
 * dev frameworks (dotnet, node, vite, flask, fastapi, rails, …) print an
 * "http://localhost:PORT" / "http://127.0.0.1:PORT" / "http://0.0.0.0:PORT"
 * banner at boot, so we cover the common case without parsing framework-
 * specific log formats.
 *
 *  Conscious non-goals:
 *   - We do not strip ANSI: launch processes typically print the URL line
 *     in plain text, and even when colored, the regex still matches because
 *     ANSI escapes don't appear inside the host:port substring.
 *   - We don't try to detect non-HTTP listeners. If a developer needs to
 *     forward a raw TCP port, they can rely on the URL pattern by writing
 *     a `console.log('listening at http://localhost:5000')` themselves.
 */

/** Min/max port we'll actually forward. Below 1024 = privileged / system,
 *  > 65535 invalid; both filtered out as parsing noise. */
const MIN_PORT = 1024
const MAX_PORT = 65535

/** Common infra ports we never auto-forward — exposing the remote DB / cache
 *  to the user's localhost is a footgun (collides with the user's own local
 *  Postgres / Redis, leaks credentials, etc). The user can still SSH-tunnel
 *  these manually if they really want to. */
const PORT_DENYLIST = new Set<number>([
  3306,  // MySQL / MariaDB
  5432,  // Postgres
  6379,  // Redis
  11211, // Memcached
  27017, // MongoDB
  5672,  // RabbitMQ AMQP
  9200,  // Elasticsearch
  9300,  // Elasticsearch transport
])

// Match http(s)://(localhost|127.0.0.1|0.0.0.0|::1|[::]):PORT with optional path.
// Capturing group #1 is the port number. Case-insensitive on the scheme +
// host so "HTTP://Localhost:5000" still matches.
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1?\]):(\d{2,5})\b/gi

export function detectPortsInChunk(text: string): number[] {
  if (!text || text.length < 12) return [] // too short to contain "http://x:NN"

  const seen = new Set<number>()
  const out: number[] = []

  // exec-loop instead of matchAll → tiny perf edge on hot path, and lets us
  // bail early if a chunk turns out to be megabytes of noise.
  let match: RegExpExecArray | null
  URL_PATTERN.lastIndex = 0
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const port = Number(match[1])
    if (!Number.isFinite(port)) continue
    if (port < MIN_PORT || port > MAX_PORT) continue
    if (PORT_DENYLIST.has(port)) continue
    if (seen.has(port)) continue
    seen.add(port)
    out.push(port)
  }
  return out
}
