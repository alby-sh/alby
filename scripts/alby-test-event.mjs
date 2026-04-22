// One-shot smoke test that fires a single captureMessage through the
// Alby SDK so we can confirm end-to-end delivery. Run with:
//   ALBY_ENVIRONMENT=Local node scripts/alby-test-event.mjs
// This script is *not* part of the app boot path — it only exists so we
// can exercise the SDK from plain Node, outside the Electron main process
// (which can't run from a shell without the Electron binary).
import { Alby } from '@alby-sh/report'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const pkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
)

Alby.init({
  dsn: 'https://SJfWXxRA26eVC61FtzscYgQMpEmC9IDWpXrWCB48@alby.sh/ingest/v1/a196e207-a35e-414b-8858-a31b07eec06c',
  environment: process.env.ALBY_ENVIRONMENT ?? 'Local',
  release: pkg.version,
  debug: true,
})

Alby.captureMessage('Alby detector test event', 'info')

// Make sure the event leaves the process before exit.
await Alby.flush(5000)
console.log('[alby] test event flushed')
