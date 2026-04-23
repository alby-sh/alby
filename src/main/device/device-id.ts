import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { v4 as uuid } from 'uuid'

/**
 * Device identity for cross-device agent visibility.
 *
 * Every Alby install gets a stable UUID (persisted in userData/device.json)
 * that survives app upgrades but is fresh on a clean reinstall. Combined
 * with the machine's `os.hostname()` — shown verbatim in banners like
 * "Running on alberto-macbook.local" — it's the minimum information a
 * teammate's client needs to know "that agent's PTY is on a Mac I can't
 * reach from here, don't let me try to attach".
 *
 * Why not use `os.hostname()` alone?
 *   - Hostnames aren't unique across devices (multiple Macs can be
 *     "alberto-MBP.local" at different times on different networks), and
 *     they can legitimately change (Settings → General → About → Name).
 *     A stable UUID is the only thing the backend can trust for ownership
 *     checks on kill/delete.
 *
 * Why not use the Electron `machineId` / `hardware id`?
 *   - Electron doesn't expose one cross-platform, and rolling our own via
 *     `systeminformation` or `node-machine-id` adds a native dep for no
 *     real benefit: we don't need the identity to survive a factory reset;
 *     we need it to survive app updates (which the userData file does).
 *
 * This module is lazy + memoised — the UUID is read/generated once at
 * module init and reused for the lifetime of the process.
 */

interface DeviceRecord {
  id: string
  /** First hostname we saw when this device file was created; kept for
   *  debugging if the user later renames their Mac. Not exposed. */
  initial_hostname?: string
  created_at?: string
}

let cached: { id: string; name: string } | null = null

/** Path to the device-id persistence file, under Electron's userData dir.
 *  In dev mode userData is redirected to "Alby Dev" (see main/index.ts) so
 *  `npm run dev` and a packaged Alby get distinct device IDs — matches the
 *  rest of Alby's dev-mode isolation. */
function devicePath(): string {
  const base = app.getPath('userData')
  mkdirSync(base, { recursive: true })
  return join(base, 'device.json')
}

/** Read-or-create: if the file exists and parses, return its id; otherwise
 *  mint a fresh one and atomically write it. A corrupted file is replaced
 *  rather than crashing boot — losing the old id just means the owner
 *  identity shifts by one entry, no agent is lost. */
function loadOrCreate(): DeviceRecord {
  const p = devicePath()
  if (existsSync(p)) {
    try {
      const raw = readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw) as DeviceRecord
      if (parsed && typeof parsed.id === 'string' && parsed.id.length > 0) {
        return parsed
      }
    } catch {
      /* fall through to regen */
    }
  }
  const record: DeviceRecord = {
    id: uuid(),
    initial_hostname: os.hostname(),
    created_at: new Date().toISOString(),
  }
  try {
    writeFileSync(p, JSON.stringify(record, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[device-id] could not persist device record:', (err as Error).message)
  }
  return record
}

/** Stable UUID for this install. Call anywhere in main. */
export function getDeviceId(): string {
  if (!cached) {
    const rec = loadOrCreate()
    cached = { id: rec.id, name: os.hostname() || 'unknown-device' }
  }
  return cached.id
}

/** Human-readable label — OS hostname at the time of the call. Read fresh
 *  every time because the user can rename their Mac and we want the new
 *  name to show up in banners without waiting for an app restart. */
export function getDeviceName(): string {
  // Re-read hostname lazily so a mid-session rename is reflected. The id
  // stays cached (loadOrCreate only runs once).
  if (!cached) getDeviceId()
  const live = os.hostname() || cached!.name
  cached!.name = live
  return live
}

/** Convenience: both fields at once, matching the shape agents.ipc passes
 *  through to the cloud. */
export function getDeviceInfo(): { device_id: string; device_name: string } {
  return { device_id: getDeviceId(), device_name: getDeviceName() }
}
