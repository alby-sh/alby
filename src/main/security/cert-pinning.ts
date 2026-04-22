// TLS-level guardrails for outbound HTTPS / WSS traffic from the Electron
// default session. Two layers:
//
//   1. Hostname allowlist (active in packaged builds). A connection to a host
//      not in ALBY_HOST_ALLOWLIST is rejected — even if someone patches the
//      URL constants elsewhere, they can't silently redirect traffic to a
//      different backend without also editing this allowlist in a fork.
//
//   2. SPKI pin set (scaffolded, OFF by default). When turned on, the server's
//      Subject Public Key Info hash must match one of the pins we ship. This
//      defends against MITM even with a user-trusted CA (corporate proxy,
//      installed malware root).
//
// Pinning is deliberately shipped disabled because Let's Encrypt / Cloudflare
// Universal SSL rotate leaf keys automatically — a stale pin would brick the
// app until the next update. To turn it on:
//
//   a. Replace the pinned hosts so they point at a cert/key you control (e.g.
//      an internal ACME with stable keypair, or a custom CA).
//   b. Use a real ASN.1 parser (node-forge, @peculiar/asn1-schema) in
//      spkiPinFromDer — the hand-rolled approach was intentionally not shipped.
//   c. Populate PINS_SHA256 below with the base64 SHA-256 of the SPKI for the
//      current keypair AND a backup keypair (so rotation doesn't need a
//      release).
//   d. Flip ENFORCE_SPKI to true and ship a beta release. Watch pin-failure
//      telemetry for a week before promoting.

import { session, app } from 'electron'
import { ALBY_HOST_ALLOWLIST } from '../../shared/cloud-constants'

const ENFORCE_SPKI = false
const PINS_SHA256: Record<string, readonly string[]> = {
  // 'alby.sh':    ['BASE64_PIN_PRIMARY=', 'BASE64_PIN_BACKUP='],
  // 'ws.alby.sh': ['BASE64_PIN_PRIMARY=', 'BASE64_PIN_BACKUP='],
}

export function installCertPinning(): void {
  // In dev we may be pointing at a staging backend or running under a proxy —
  // pinning would block those. Only enforce in packaged builds.
  if (!app.isPackaged) return

  session.defaultSession.setCertificateVerifyProc((req, callback) => {
    const host = req.hostname

    // Layer 1: hostname allowlist. Exact match OR subdomain of an allowlisted
    // root (so api.alby.sh passes if alby.sh is listed).
    const allowed = ALBY_HOST_ALLOWLIST.some(
      (h) => host === h || host.endsWith(`.${h}`)
    )
    if (!allowed) {
      console.warn(`[cert-pin] blocked ${host}: not in allowlist`)
      callback(-2) // net::ERR_FAILED
      return
    }

    // Chromium's own chain validation has to pass first. verificationResult
    // is 'net::OK' only when the system trust store accepts the chain.
    if (req.verificationResult !== 'net::OK') {
      callback(-2)
      return
    }

    // Layer 2: SPKI pinning. Fail closed when enabled without a real parser
    // implementation, rather than silently accepting.
    if (ENFORCE_SPKI) {
      const pins = PINS_SHA256[host]
      if (pins && pins.length > 0) {
        // TODO: parse req.certificate.data (PEM) into DER, extract the SPKI
        // SEQUENCE with a real ASN.1 library, sha256-it, and compare to
        // `pins`. Until that's in place, fail closed for pinned hosts.
        console.error(`[cert-pin] SPKI enforcement requested for ${host} but parser is not implemented — failing closed`)
        callback(-2)
        return
      }
    }

    callback(0) // net::OK
  })
}
