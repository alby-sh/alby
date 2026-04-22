import { Client } from 'ssh2'
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { lookup } from 'dns'
import { createConnection, Socket } from 'net'
import { get as httpsGet } from 'https'
import type {
  SSHPreflightParams,
  SSHPreflightResult,
  SSHPreflightStage,
  EnvironmentPlatform,
} from '../../shared/types'
import { parseSSHConfig } from './config-parser'

const TCP_TIMEOUT_MS = 8000
const SSH_READY_TIMEOUT_MS = 15000
const EXEC_TIMEOUT_MS = 10000

interface ResolvedConfig {
  hostname: string
  user: string
  port: number
  keyPath: string
  keyExists: boolean
}

function resolveConfig(params: SSHPreflightParams): ResolvedConfig {
  const sshHosts = parseSSHConfig()
  const configHost = sshHosts.find((h) => h.alias === params.ssh_host)
  const hostname = configHost?.hostname || params.ssh_host
  const user = params.ssh_user || configHost?.user || 'root'
  const port = params.ssh_port || configHost?.port || 22
  const rawKeyPath = params.ssh_key_path || configHost?.identityFile || null
  const keyPath =
    typeof rawKeyPath === 'string'
      ? rawKeyPath.replace('~', homedir())
      : join(homedir(), '.ssh', 'id_rsa')
  return { hostname, user, port, keyPath, keyExists: existsSync(keyPath) }
}

function fail(
  stage: SSHPreflightStage,
  code: string,
  message: string,
  hint?: string,
  details?: Record<string, string | number | boolean>
): SSHPreflightResult {
  return { ok: false, stage, code, message, hint, details }
}

async function resolveDNS(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // IP literals pass straight through.
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')) {
      resolve(hostname)
      return
    }
    lookup(hostname, (err, address) => {
      if (err) reject(err)
      else resolve(address)
    })
  })
}

async function tcpProbe(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection({ host, port, timeout: TCP_TIMEOUT_MS })
    let settled = false
    const done = (err?: Error): void => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      if (err) reject(err)
      else resolve()
    }
    socket.on('connect', () => done())
    socket.on('timeout', () => done(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    socket.on('error', (err) => done(err))
  })
}

async function getPublicIP(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpsGet('https://api.ipify.org', { timeout: 3000 }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => resolve(body.trim() || null))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

interface ExecResult { code: number; stdout: string; stderr: string }

function execRemote(client: Client, command: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('exec timeout'), { code: 'EEXECTIMEOUT' }))
    }, EXEC_TIMEOUT_MS)
    client.exec(command, (err, channel) => {
      if (err) {
        clearTimeout(timer)
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      channel.on('data', (d: Buffer) => { stdout += d.toString() })
      channel.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
      channel.on('close', (code: number) => {
        clearTimeout(timer)
        resolve({ code: code ?? 0, stdout, stderr })
      })
    })
  })
}

/**
 * Map low-level SSH/net error codes + messages to actionable user hints.
 *
 * The goal is to tell a non-expert *why* the test failed and *what to change*
 * — wrong key, IP not allowlisted on the firewall, wrong port, etc. — instead
 * of dumping a cryptic "Error: read ECONNRESET" at them.
 */
function describeAuthError(
  msg: string,
  keyPath: string,
  keyExists: boolean,
  user: string
): { code: string; message: string; hint: string } {
  const lower = msg.toLowerCase()
  if (lower.includes('cannot parse privatekey') || lower.includes('malformed')) {
    return {
      code: 'KEY_INVALID',
      message: 'Could not parse the SSH private key.',
      hint: `The file at ${keyPath} is not a valid OpenSSH / PEM private key. If it's password-protected, this app doesn't support key passphrases yet — create a passphraseless key or remove the passphrase with \`ssh-keygen -p -f ${keyPath}\`.`,
    }
  }
  if (lower.includes('encrypted') || lower.includes('passphrase')) {
    return {
      code: 'KEY_ENCRYPTED',
      message: 'The private key is passphrase-protected.',
      hint: `Remove the passphrase (\`ssh-keygen -p -f ${keyPath}\`) or generate a new key without one. Key passphrases are not yet supported.`,
    }
  }
  if (!keyExists) {
    return {
      code: 'KEY_MISSING',
      message: `Private key not found at ${keyPath}.`,
      hint: `Create it (\`ssh-keygen -t ed25519 -f ${keyPath}\`) or point the environment to an existing key in the advanced settings.`,
    }
  }
  return {
    code: 'AUTH_FAILED',
    message: 'Authentication failed — the server rejected the SSH key.',
    hint: `Copy the public key to the server: \`ssh-copy-id -i ${keyPath}.pub ${user}@<host>\` (or append \`cat ${keyPath}.pub\` to \`~/.ssh/authorized_keys\` on the server). Also check that you're connecting as the right user (\`${user}\`).`,
  }
}

async function describeTcpError(
  err: NodeJS.ErrnoException,
  host: string,
  port: number
): Promise<{ code: string; message: string; hint: string }> {
  const code = err.code || 'TCP_ERROR'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      code: 'DNS_NOT_FOUND',
      message: `Hostname "${host}" could not be resolved.`,
      hint: 'Check spelling. If this is a private domain, make sure your DNS / VPN is reachable from this device.',
    }
  }
  if (code === 'ECONNREFUSED') {
    return {
      code: 'TCP_REFUSED',
      message: `Connection refused on ${host}:${port}.`,
      hint: `Something answered but actively rejected you. Verify the SSH daemon is running and listening on port ${port} (\`systemctl status ssh\`), and that you're hitting the right port.`,
    }
  }
  if (code === 'ETIMEDOUT' || code === 'ETIMEOUT') {
    const publicIP = await getPublicIP()
    const ipPart = publicIP
      ? ` Your current public IP is \`${publicIP}\` — add it to the server's firewall allowlist on port ${port}.`
      : ` Add your public IP to the server's firewall allowlist on port ${port}.`
    return {
      code: 'TCP_TIMEOUT',
      message: `Connection to ${host}:${port} timed out.`,
      hint: `Usually a firewall blocking your IP or the wrong port.${ipPart}`,
    }
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return {
      code: 'NET_UNREACHABLE',
      message: `Host ${host} is unreachable from this device.`,
      hint: 'Check your network / VPN. The route to the server is down.',
    }
  }
  return {
    code,
    message: `Network error: ${err.message}`,
    hint: 'Open a terminal and try `ssh -v` with the same details to see the raw error.',
  }
}

/**
 * Run the stage chain: DNS → TCP → SSH handshake → auth → shell → remote_path → git.
 *
 * Each stage returns a granular `stage` + `code` so the UI can explain the
 * failure in terms the user can act on. Success only comes from reaching the
 * last stage with no errors.
 */
export async function runPreflight(params: SSHPreflightParams): Promise<SSHPreflightResult> {
  const cfg = resolveConfig(params)

  // ---- Stage 1: DNS ----
  let resolvedIP: string
  try {
    resolvedIP = await resolveDNS(cfg.hostname)
  } catch (err) {
    const desc = await describeTcpError(err as NodeJS.ErrnoException, cfg.hostname, cfg.port)
    return fail('dns', desc.code, desc.message, desc.hint, { host: cfg.hostname })
  }

  // ---- Stage 2: TCP ----
  try {
    await tcpProbe(cfg.hostname, cfg.port)
  } catch (err) {
    const desc = await describeTcpError(err as NodeJS.ErrnoException, cfg.hostname, cfg.port)
    return fail('tcp', desc.code, desc.message, desc.hint, { host: cfg.hostname, port: cfg.port, resolvedIP })
  }

  // ---- Stages 3-4: SSH handshake + auth ----
  const client = new Client()
  const sshResult = await new Promise<SSHPreflightResult | 'ok'>((resolve) => {
    let settled = false
    const finish = (r: SSHPreflightResult | 'ok'): void => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* ignore */ }
      resolve(r)
    }

    client.on('ready', () => finish('ok'))
    client.on('error', (err) => {
      const msg = err.message || String(err)
      const lower = msg.toLowerCase()
      if (
        lower.includes('all configured authentication methods failed') ||
        lower.includes('authentication') ||
        lower.includes('cannot parse privatekey') ||
        lower.includes('passphrase') ||
        lower.includes('encrypted')
      ) {
        const desc = describeAuthError(msg, cfg.keyPath, cfg.keyExists, cfg.user)
        finish(fail('auth', desc.code, desc.message, desc.hint, { user: cfg.user, keyPath: cfg.keyPath }))
        return
      }
      if (lower.includes('handshake')) {
        finish(
          fail(
            'handshake',
            'HANDSHAKE_FAILED',
            'SSH handshake failed.',
            `The service on port ${cfg.port} answered but did not speak SSH. Are you sure ${cfg.hostname}:${cfg.port} is an SSH server?`
          )
        )
        return
      }
      finish(fail('handshake', 'SSH_ERROR', msg, 'Try `ssh -v` from a terminal for raw output.'))
    })

    const connectConfig: Record<string, unknown> = {
      host: cfg.hostname,
      port: cfg.port,
      username: cfg.user,
      readyTimeout: SSH_READY_TIMEOUT_MS,
    }
    if (params.ssh_auth_method === 'password') {
      if (!params.ssh_password) {
        finish(fail('auth', 'PASSWORD_MISSING', 'Password authentication selected but no password was provided.', 'Type a password in the SSH connection form, or switch to private key.'))
        return
      }
      connectConfig.password = params.ssh_password
    } else if (cfg.keyExists) {
      try {
        connectConfig.privateKey = readFileSync(cfg.keyPath)
      } catch (err) {
        finish(
          fail(
            'auth',
            'KEY_READ',
            `Could not read private key at ${cfg.keyPath}.`,
            `Fix permissions: \`chmod 600 ${cfg.keyPath}\`.`
          )
        )
        return
      }
    } else {
      finish(
        fail(
          'auth',
          'KEY_MISSING',
          `Private key not found at ${cfg.keyPath}.`,
          `Generate one with \`ssh-keygen -t ed25519 -f ${cfg.keyPath}\` and copy the public half to the server (\`ssh-copy-id -i ${cfg.keyPath}.pub ${cfg.user}@${cfg.hostname}\`), or switch to password authentication in the form above.`
        )
      )
      return
    }
    try {
      client.connect(connectConfig as Parameters<Client['connect']>[0])
    } catch (err) {
      finish(fail('handshake', 'SSH_CONNECT', (err as Error).message, undefined))
    }
  })

  if (sshResult !== 'ok') return sshResult

  // Reconnect for subsequent exec probes (first client was ended). This keeps
  // the preflight stateless — we never hand the Client off to the pool.
  return runShellAndPathProbes(
    params.platform,
    params.remote_path,
    cfg,
    params.role === 'operational',
    params.ssh_auth_method === 'password' ? params.ssh_password : undefined,
  )
}

async function runShellAndPathProbes(
  platform: EnvironmentPlatform,
  remotePath: string,
  cfg: ResolvedConfig,
  requireGit: boolean,
  password?: string,
): Promise<SSHPreflightResult> {
  const client = new Client()

  const connected = await new Promise<boolean>((resolve) => {
    client.on('ready', () => resolve(true))
    client.on('error', () => resolve(false))
    try {
      const cc: Record<string, unknown> = {
        host: cfg.hostname,
        port: cfg.port,
        username: cfg.user,
        readyTimeout: SSH_READY_TIMEOUT_MS,
      }
      if (password) {
        cc.password = password
      } else if (cfg.keyExists) {
        cc.privateKey = readFileSync(cfg.keyPath)
      }
      client.connect(cc as Parameters<Client['connect']>[0])
    } catch {
      resolve(false)
    }
  })

  if (!connected) {
    return fail('handshake', 'RECONNECT', 'Lost SSH connection after auth.', 'Retry — the server may be overloaded.')
  }

  try {
    // ---- Stage 5: Shell probe ----
    if (platform === 'windows') {
      const probe = await execRemote(client, 'powershell -NoProfile -Command "Write-Output hi"').catch((err) => ({
        code: 1,
        stdout: '',
        stderr: (err as Error).message,
      }))
      if (probe.code !== 0 || !probe.stdout.includes('hi')) {
        return fail(
          'shell',
          'PWSH_MISSING',
          'PowerShell is not available on the server.',
          'This app drives Windows deploy targets via PowerShell. Install PowerShell 5.1+ or enable OpenSSH to use the default shell — see https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse',
          { stderr: probe.stderr.slice(0, 200) }
        )
      }
    } else {
      const probe = await execRemote(client, 'bash -l -c "echo hi"').catch((err) => ({
        code: 1,
        stdout: '',
        stderr: (err as Error).message,
      }))
      if (probe.code !== 0 || !probe.stdout.includes('hi')) {
        return fail(
          'shell',
          'BASH_MISSING',
          'Could not run a bash login shell on the server.',
          'Install bash or fix ~/.bash_profile / ~/.bashrc — the preflight runs `bash -l -c "echo hi"` and expects exit 0.',
          { stderr: probe.stderr.slice(0, 200) }
        )
      }
    }

    // ---- Stage 6: remote_path ----
    if (remotePath) {
      const cmd = platform === 'windows'
        ? `powershell -NoProfile -Command "if (Test-Path '${remotePath.replace(/'/g, "''")}') { 'ok' } else { 'missing' }"`
        : `bash -l -c 'if [ -d "${remotePath.replace(/"/g, '\\"')}" ]; then echo ok; else echo missing; fi'`
      const probe = await execRemote(client, cmd).catch(() => ({ code: 1, stdout: '', stderr: '' }))
      const out = probe.stdout.trim()
      if (!out.includes('ok')) {
        return fail(
          'path',
          'PATH_MISSING',
          `Remote path "${remotePath}" does not exist or is not a directory.`,
          platform === 'windows'
            ? `Create it on the server: \`New-Item -ItemType Directory -Path '${remotePath}'\`.`
            : `Create it on the server: \`mkdir -p "${remotePath}"\` (you may need \`sudo\`).`
        )
      }
    }

    // ---- Stage 7: git ----
    // Operational envs NEED git (we pull/push on them). Deploy envs also need
    // it for the standard "git pull + run scripts" pipeline — surface the
    // warning either way.
    if (requireGit || remotePath) {
      const cmd = platform === 'windows'
        ? 'powershell -NoProfile -Command "git --version"'
        : 'bash -l -c "git --version"'
      const probe = await execRemote(client, cmd).catch(() => ({ code: 127, stdout: '', stderr: '' }))
      if (probe.code !== 0) {
        return fail(
          'git',
          'GIT_MISSING',
          'Git is not installed on the server.',
          platform === 'windows'
            ? 'Install Git for Windows: https://git-scm.com/download/win — it must be on PATH for the SSH session.'
            : 'Install git: `apt-get install -y git` (Debian/Ubuntu) or `yum install -y git` (RHEL).'
        )
      }
    }
  } finally {
    try { client.end() } catch { /* ignore */ }
  }

  return {
    ok: true,
    message: 'Connection verified.',
    details: { host: cfg.hostname, port: cfg.port, user: cfg.user },
  }
}
