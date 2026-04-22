// Token storage backed by Electron's safeStorage API.
//
// safeStorage encrypts data using a key managed by the OS. On macOS it lives
// under a keychain item owned by the signed app itself ("Alby Safe Storage"),
// which is created silently the first time we call encryptString — no user
// prompt, no suspicious-looking service name surfaced in dialogs.
//
// The encrypted blob is written to userData (a cache file); if the file
// disappears or can't be decrypted we just return null and force a re-login.
import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import path from 'path'

function tokenPath(): string {
  return path.join(app.getPath('userData'), 'auth-token.enc')
}

export async function saveToken(token: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Encryption not available — cannot store auth token securely')
  }
  const encrypted = safeStorage.encryptString(token)
  await fs.mkdir(path.dirname(tokenPath()), { recursive: true })
  await fs.writeFile(tokenPath(), encrypted, { mode: 0o600 })
}

export async function loadToken(): Promise<string | null> {
  try {
    const encrypted = await fs.readFile(tokenPath())
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(encrypted)
  } catch {
    return null
  }
}

export async function clearToken(): Promise<void> {
  try {
    await fs.unlink(tokenPath())
  } catch {
    // already gone
  }
}
