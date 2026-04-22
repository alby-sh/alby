import { EventEmitter } from 'events'
import { Client } from 'ssh2'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { Environment } from '../../shared/types'
import { parseSSHConfig } from './config-parser'
import { materializeCredentials, keyPathFor } from '../env/materialize-key'

interface PoolEntry {
  client: Client
  environmentId: string
  connected: boolean
  env: Environment          // stored for auto-reconnect
  reconnectTimer?: ReturnType<typeof setTimeout>
  reconnectAttempt: number
  intentionalClose: boolean // true when user disconnects or app quits
}

const RECONNECT_DELAYS = [2000, 3000, 5000, 8000, 15000, 30000] // progressive backoff

export class ConnectionPool extends EventEmitter {
  private pool: Map<string, PoolEntry> = new Map()
  private quitting = false

  private resolveSSHConfig(env: Environment) {
    const sshHosts = parseSSHConfig()
    const configHost = sshHosts.find((h) => h.alias === env.ssh_host)

    const hostname = configHost?.hostname || env.ssh_host
    const user = env.ssh_user || configHost?.user || 'root'
    const port = env.ssh_port || configHost?.port || 22
    const rawKeyPath = env.ssh_key_path || configHost?.identityFile || null
    const keyPath = typeof rawKeyPath === 'string'
      ? rawKeyPath.replace('~', homedir())
      : join(homedir(), '.ssh', 'id_rsa')

    return { hostname, user, port, keyPath }
  }

  async connect(env: Environment): Promise<Client> {
    // Local environments have no SSH endpoint — refuse upfront so callers
    // (git status pollers, etc.) get a clean error instead of an infinite
    // reconnect loop against an empty hostname.
    if (env.execution_mode !== 'remote') {
      throw new Error(`Cannot SSH-connect to local environment '${env.name}'`)
    }

    const existing = this.pool.get(env.id)
    if (existing?.connected) return existing.client

    // Cancel any pending reconnect — we're connecting now
    if (existing?.reconnectTimer) {
      clearTimeout(existing.reconnectTimer)
      existing.reconnectTimer = undefined
    }

    // Cross-device materialization. If the user turned on "Sync to cloud"
    // for this env on another device, the first connect on THIS device
    // needs to pull the plaintext credentials down. Runs at most once per
    // boot per env (the helper no-ops when the file already exists).
    let materializedPassword: string | null = null
    let materializedKeyPath: string | null = null
    if (env.has_synced_private_key || env.has_synced_password) {
      try {
        const materialized = await materializeCredentials(env)
        materializedPassword = materialized.password
        materializedKeyPath = materialized.keyPath
      } catch (err) {
        console.warn(`[ConnectionPool] Credential materialization failed for ${env.id}: ${(err as Error).message}`)
        // Fall through — connect() will retry with whatever's on disk.
      }
    }

    const { hostname, user, port, keyPath: resolvedKeyPath } = this.resolveSSHConfig(env)
    // Prefer the materialized key path (written under userData/keys) over
    // whatever the env record claimed — the original might have been a path
    // from a different device that doesn't exist here.
    const keyPath = existsSync(keyPathFor(env.id)) ? keyPathFor(env.id) : (materializedKeyPath ?? resolvedKeyPath)
    console.log(
      `[ConnectionPool] Connecting ${env.name} (${env.id}) ` +
        `host=${user}@${hostname}:${port} ` +
        `auth=${env.ssh_auth_method ?? 'key'} ` +
        `password_present=${!!env.ssh_password} ` +
        `key_path=${keyPath}`,
    )
    const client = new Client()

    return new Promise((resolve, reject) => {
      client.on('ready', () => {
        const entry = this.pool.get(env.id)
        const wasReconnect = entry && !entry.connected && entry.reconnectAttempt > 0

        this.pool.set(env.id, {
          client, environmentId: env.id, connected: true,
          env, reconnectAttempt: 0, intentionalClose: false
        })

        if (wasReconnect) {
          console.log(`[ConnectionPool] Reconnected to ${env.ssh_host} (${env.id})`)
          this.emit('reconnected', env.id, client)
        }

        resolve(client)
      })

      client.on('error', (err) => {
        console.error(`[ConnectionPool] SSH error on ${env.ssh_host}:`, err.message)
        const entry = this.pool.get(env.id)
        if (entry) {
          entry.connected = false
          // Don't delete — scheduleReconnect needs the entry
          if (!entry.intentionalClose && !this.quitting) {
            this.scheduleReconnect(env.id)
          }
        } else {
          reject(err)
        }
      })

      client.on('close', () => {
        const entry = this.pool.get(env.id)
        if (!entry) return
        const wasConnected = entry.connected
        entry.connected = false

        if (wasConnected) {
          console.log(`[ConnectionPool] Connection closed: ${env.ssh_host} (${env.id})`)
          this.emit('disconnected', env.id)
        }

        if (!entry.intentionalClose && !this.quitting) {
          this.scheduleReconnect(env.id)
        }
      })

      // Store entry before connecting (so close/error handlers work)
      this.pool.set(env.id, {
        client, environmentId: env.id, connected: false,
        env, reconnectAttempt: 0, intentionalClose: false
      })

      const connectConfig: Record<string, unknown> = {
        host: hostname,
        port,
        username: user,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        readyTimeout: 15000,
      }

      // Auth: password takes precedence when explicitly chosen, otherwise
      // fall back to the on-disk private key resolved above. Password auth
      // with an empty stored secret used to silently fall through to the key
      // path, which surfaced as mysterious "All configured authentication
      // methods failed" errors — reject loudly instead so the user can
      // re-enter their password in the env settings.
      if (env.ssh_auth_method === 'password') {
        const password = env.ssh_password || materializedPassword
        if (!password) {
          const msg = `SSH auth for "${env.name}" is set to password but no password is stored. Open the environment settings and re-enter it.`
          console.error(`[ConnectionPool] ${msg}`)
          this.pool.delete(env.id)
          reject(new Error(msg))
          return
        }
        connectConfig.password = password
      } else if (existsSync(keyPath)) {
        connectConfig.privateKey = readFileSync(keyPath)
      }

      client.connect(connectConfig as Parameters<Client['connect']>[0])
    })
  }

  private scheduleReconnect(envId: string): void {
    const entry = this.pool.get(envId)
    if (!entry || entry.intentionalClose || this.quitting) return
    if (entry.reconnectTimer) return // already scheduled

    const attempt = entry.reconnectAttempt
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)]

    console.log(`[ConnectionPool] Scheduling reconnect for ${envId} in ${delay}ms (attempt ${attempt + 1})`)

    entry.reconnectTimer = setTimeout(async () => {
      const current = this.pool.get(envId)
      if (!current || current.connected || current.intentionalClose || this.quitting) return

      current.reconnectTimer = undefined
      current.reconnectAttempt++

      try {
        await this.connect(current.env)
      } catch (err) {
        console.error(`[ConnectionPool] Reconnect attempt ${current.reconnectAttempt} failed for ${envId}:`, (err as Error).message)
        // scheduleReconnect is called again from the error/close handler
      }
    }, delay)
  }

  /** Force an immediate reconnect attempt for all disconnected environments */
  reconnectAll(): void {
    for (const [envId, entry] of this.pool) {
      if (!entry.connected && !entry.intentionalClose) {
        // Clear existing timer and try immediately
        if (entry.reconnectTimer) {
          clearTimeout(entry.reconnectTimer)
          entry.reconnectTimer = undefined
        }
        entry.reconnectAttempt = 0
        this.connect(entry.env).catch(() => {})
      }
    }
  }

  /**
   * Force-close and reconnect ALL connections (even ones that appear "connected").
   * Used after system wake from sleep when TCP sockets may be silently dead.
   */
  forceReconnectAll(): void {
    for (const [envId, entry] of this.pool) {
      if (entry.intentionalClose) continue
      // Kill the old connection
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer)
        entry.reconnectTimer = undefined
      }
      try { entry.client.destroy() } catch { /* ignore */ }
      entry.connected = false
      entry.reconnectAttempt = 0
      // Reconnect
      this.connect(entry.env).catch(() => {})
    }
  }

  getOrCreate(env: Environment): Promise<Client> {
    return this.connect(env)
  }

  get(environmentId: string): Client | undefined {
    const entry = this.pool.get(environmentId)
    return entry?.connected ? entry.client : undefined
  }

  // Force a fresh reconnect for a single env. Used when a long-idle session
  // shows the pool entry as 'connected' but the underlying TCP is silently
  // dead — happens often after 6-8 h sleep.
  async forceReconnect(env: Environment): Promise<Client> {
    const entry = this.pool.get(env.id)
    if (entry) {
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer)
        entry.reconnectTimer = undefined
      }
      try { entry.client.destroy() } catch { /* ignore */ }
      entry.connected = false
      entry.reconnectAttempt = 0
    }
    return this.connect(env)
  }

  isConnected(environmentId: string): boolean {
    return this.pool.get(environmentId)?.connected ?? false
  }

  disconnect(environmentId: string): void {
    const entry = this.pool.get(environmentId)
    if (entry) {
      entry.intentionalClose = true
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer)
        entry.reconnectTimer = undefined
      }
      entry.client.end()
      this.pool.delete(environmentId)
    }
  }

  closeAll(): void {
    this.quitting = true
    for (const [id, entry] of this.pool) {
      entry.intentionalClose = true
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer)
      }
      entry.client.end()
      this.pool.delete(id)
    }
  }
}
