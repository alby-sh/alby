// Backend endpoints. These are hardcoded by design — the app is meant to work
// with the official Alby backend, not against a forked one. Previously the
// base URL was read from process.env.ALBY_BASE_URL with alby.sh as fallback;
// that indirection was removed so someone trying to point this build at a
// different server has to patch the source, not just flip an env var.
//
// Keep this file free of imports from main/ or renderer/ — it's consumed from
// both sides.

export const ALBY_BASE_URL = 'https://alby.sh'
export const HEALTH_URL = `${ALBY_BASE_URL}/api/health`
export const BROADCASTING_AUTH_URL = `${ALBY_BASE_URL}/broadcasting/auth`

// Reverb appears as a Pusher-compatible endpoint. Served from ws.alby.sh
// (Cloudflare grey-cloud / direct-to-origin) because the browser otherwise
// negotiates HTTP/2 with CF and that breaks the WS upgrade — CF advertises
// SETTINGS_ENABLE_CONNECT_PROTOCOL but can't proxy h2 Extended CONNECT down
// to Reverb's h1-only upgrade handshake.
export const REVERB_KEY = '219edcdfc6beb1329880c9a783cd111b'
export const REVERB_HOST = 'ws.alby.sh'
export const REVERB_PORT = 443
export const REVERB_SCHEME: 'https' | 'http' = 'https'

// Hostname allowlist used by the TLS cert-pinning hook in the main process.
// Any outbound TLS from Electron to a host NOT on this list is blocked when
// the app is packaged — so a forked UI can't silently redirect traffic to a
// look-alike backend by patching one of the URL constants above.
export const ALBY_HOST_ALLOWLIST: readonly string[] = [
  'alby.sh',
  'ws.alby.sh',
  // GitHub + its asset/API hosts, needed by electron-updater + gh release assets.
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
]
