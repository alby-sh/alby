import { createServer, type Server } from 'http'
import { AddressInfo } from 'net'
import { randomBytes, createHash } from 'crypto'
import { shell } from 'electron'
import { ALBY_BASE_URL as ALBY_BASE } from '../../shared/cloud-constants'

// Wrap fetch with: (a) one transparent retry — Node 20's undici occasionally
// trips Happy-Eyeballs races on the very first connection after sleep / wake,
// surfacing "TypeError: fetch failed" — and (b) a useful error message that
// includes err.cause so we don't lose the underlying ENOTFOUND / ECONNRESET
// when it bubbles up to the renderer.
async function fetchWithRetry(url: string, init: RequestInit, attempts = 2): Promise<Response> {
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      lastErr = err
      const cause = (err as { cause?: { code?: string } }).cause
      console.warn(`[oauth] fetch attempt ${i + 1} failed: ${(err as Error).message}${cause?.code ? ` (${cause.code})` : ''}`)
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  }
  const cause = (lastErr as { cause?: { code?: string; message?: string } }).cause
  const detail = cause?.code || cause?.message || (lastErr as Error).message
  throw new Error(`Could not reach alby.sh — ${detail}. Check your internet connection and try again.`)
}

interface PkceStartResponse {
  session_id: string
  login_url: string
}

interface PkceExchangeResponse {
  ok: boolean
  token?: string
  user?: { id: number; name: string; email: string; avatar_url: string | null }
  error?: string
}

interface OAuthResult {
  token: string
  user: NonNullable<PkceExchangeResponse['user']>
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Run the full PKCE-with-loopback OAuth flow.
 *
 * 1. Generate a random code_verifier + code_challenge (SHA256).
 * 2. POST /api/auth/desktop-pkce/start with the challenge + a random loopback port.
 * 3. Open the returned login_url in the user's default browser.
 * 4. Wait for alby.sh's /desktop-callback page to POST back to our loopback port.
 * 5. Call /api/auth/desktop-pkce/exchange with the code_verifier to receive the
 *    Sanctum token. Reject if the user takes too long.
 *
 * @param provider Optional preset provider hint ('google'|'microsoft'). The browser
 *                 page lets the user pick anyway.
 * @param timeoutMs How long to wait for the user to complete the flow (default 5min).
 */
export async function runOAuthLoopback(
  provider?: 'google' | 'microsoft' | null,
  timeoutMs = 300_000
): Promise<OAuthResult> {
  const codeVerifier = base64url(randomBytes(48))
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())

  const { server, port } = await startLoopbackServer()

  try {
    const startRes = await fetchWithRetry(`${ALBY_BASE}/api/auth/desktop-pkce/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        callback_port: port
      })
    })
    if (!startRes.ok) {
      throw new Error(`PKCE start failed: ${startRes.status}`)
    }
    const startJson = (await startRes.json()) as PkceStartResponse

    let loginUrl = startJson.login_url
    if (provider) {
      // Auto-redirect into the chosen provider — alby.sh's /login page handles a hint.
      const url = new URL(loginUrl)
      url.searchParams.set('provider', provider)
      loginUrl = `${ALBY_BASE}/oauth/${provider}/redirect?desktop_session=${encodeURIComponent(startJson.session_id)}`
    }

    await shell.openExternal(loginUrl)

    // Wait for the loopback callback OR timeout.
    const sessionId = await waitForCallback(server, timeoutMs)
    if (sessionId !== startJson.session_id) {
      throw new Error('PKCE session mismatch')
    }

    const exchangeRes = await fetchWithRetry(`${ALBY_BASE}/api/auth/desktop-pkce/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        session_id: startJson.session_id,
        code_verifier: codeVerifier
      })
    })
    const exchangeJson = (await exchangeRes.json()) as PkceExchangeResponse
    if (!exchangeJson.ok || !exchangeJson.token || !exchangeJson.user) {
      throw new Error(exchangeJson.error || 'PKCE exchange failed')
    }
    return { token: exchangeJson.token, user: exchangeJson.user }
  } finally {
    server.close()
  }
}

function startLoopbackServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ server, port: addr.port })
    })
  })
}

function waitForCallback(server: Server, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Login timed out — please try again'))
    }, timeoutMs)

    server.on('request', async (req, res) => {
      // CORS preflight from the alby.sh page (browsers send OPTIONS before POST).
      const origin = req.headers.origin ?? '*'
      const setCors = (): void => {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
        // Private Network Access (Chrome ≥ 104 / Safari recent). When an HTTPS
        // page (alby.sh) talks to a loopback server on a less-public address
        // (127.0.0.1), the browser adds the `Access-Control-Request-Private-
        // Network: true` header to the preflight and expects a matching
        // `Access-Control-Allow-Private-Network: true` on the response — or it
        // silently blocks the POST. Without this, the /desktop-callback page
        // on alby.sh shows "Could not reach the desktop app…" even though the
        // loopback is listening. See:
        // https://developer.chrome.com/blog/private-network-access-preflight
        res.setHeader('Access-Control-Allow-Private-Network', 'true')
      }

      if (req.method === 'OPTIONS') {
        setCors()
        res.writeHead(204).end()
        return
      }

      if (req.method !== 'POST' || !req.url?.startsWith('/desktop-callback')) {
        setCors()
        res.writeHead(404).end('not found')
        return
      }

      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString() })
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}') as { session_id?: string }
          setCors()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          if (data.session_id) {
            clearTimeout(timer)
            resolve(data.session_id)
          }
        } catch {
          setCors()
          res.writeHead(400).end('bad request')
        }
      })
    })
  })
}

export async function emailRegister(email: string, password: string, name: string): Promise<void> {
  const res = await fetch(`${ALBY_BASE}/api/auth/register-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password, name })
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string; errors?: unknown }
    throw new Error(data.message || JSON.stringify(data.errors || res.status))
  }
}

export async function emailLogin(email: string, password: string): Promise<OAuthResult> {
  const res = await fetch(`${ALBY_BASE}/api/auth/login-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const data = (await res.json()) as PkceExchangeResponse & { error?: string }
  if (!res.ok || !data.ok || !data.token || !data.user) {
    throw new Error(data.error || 'Login failed')
  }
  return { token: data.token, user: data.user }
}

export async function verifyOtp(email: string, code: string): Promise<OAuthResult> {
  const res = await fetch(`${ALBY_BASE}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, code })
  })
  const data = (await res.json()) as PkceExchangeResponse & { error?: string }
  if (!res.ok || !data.ok || !data.token || !data.user) {
    throw new Error(data.error || 'OTP verification failed')
  }
  return { token: data.token, user: data.user }
}

export async function fetchMe(token: string): Promise<{ user: OAuthResult['user']; teams: Array<{ id: string; name: string; slug: string; avatar_url: string | null; role: string }>; current_team_id: string | null }> {
  const res = await fetch(`${ALBY_BASE}/api/me`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  })
  if (!res.ok) throw new Error(`/api/me failed: ${res.status}`)
  return res.json()
}

export async function logout(token: string): Promise<void> {
  await fetch(`${ALBY_BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
  }).catch(() => {})
}
