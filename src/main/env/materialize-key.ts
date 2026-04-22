// Cross-device credential materialization.
//
// When the user enables "Sync to cloud" on an environment's password or
// private key, the plaintext travels once to alby.sh, gets envelope-encrypted
// with the user's per-user KEK (AES-256-GCM via EncryptionService), and
// lives on the backend until another device pulls it back down. This module
// is the client-side half of that pull.
//
// Private keys are written to `<userData>/keys/<env-id>` with `chmod 600` —
// we intentionally don't touch `~/.ssh/` so the app's key vault is visible
// only to Alby. Passwords stay in memory on the local SSH connection pool;
// they never hit disk.

import { app } from 'electron'
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'fs'
import { dirname, join } from 'path'
import type { Environment } from '../../shared/types'
import { cloudClient } from '../cloud/cloud-client'

interface MaterializedCredentials {
  /** Absolute path to the private key on this device, or null if the env
   * has no synced key. */
  keyPath: string | null
  /** The plaintext password, if one is synced. Caller should keep this in
   * memory only (e.g., stash onto a cloned Environment for the ssh2 client). */
  password: string | null
}

function keysDir(): string {
  return join(app.getPath('userData'), 'keys')
}

export function keyPathFor(envId: string): string {
  return join(keysDir(), envId)
}

/**
 * If the env has synced credentials and this device doesn't already have
 * them locally, fetch + write them. Safe to call multiple times — the key
 * file is only rewritten when missing, so concurrent connect() calls don't
 * thrash the filesystem.
 */
export async function materializeCredentials(env: Environment): Promise<MaterializedCredentials> {
  const out: MaterializedCredentials = { keyPath: null, password: null }

  const needsKey = !!env.has_synced_private_key && !existsSync(keyPathFor(env.id))
  const needsPassword = !!env.has_synced_password && !env.ssh_password

  if (!needsKey && !needsPassword) {
    // Nothing to do — but still hand back the well-known key path when the
    // env has a synced key, so callers can use it without re-checking.
    if (env.has_synced_private_key) out.keyPath = keyPathFor(env.id)
    return out
  }

  const creds = await cloudClient.getEnvironmentCredentials(env.id)

  if (env.has_synced_private_key && creds.ssh_private_key) {
    const path = keyPathFor(env.id)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    // Write atomically-ish: write then chmod. ssh2 requires the trailing
    // newline on OpenSSH keys; most clients include one but be defensive.
    const body = creds.ssh_private_key.endsWith('\n')
      ? creds.ssh_private_key
      : creds.ssh_private_key + '\n'
    writeFileSync(path, body, { mode: 0o600 })
    chmodSync(path, 0o600) // belt-and-suspenders for umask edge cases
    out.keyPath = path
  } else if (env.has_synced_private_key) {
    // Server says we have one but the decrypt returned null — surface as
    // a clear error rather than silently falling back to no key.
    throw new Error('Cloud-synced private key could not be materialized. Re-upload it from the device where it was created.')
  }

  if (env.has_synced_password && creds.ssh_password) {
    out.password = creds.ssh_password
  }

  return out
}
