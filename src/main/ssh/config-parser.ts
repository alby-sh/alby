import SSHConfig from 'ssh-config'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { SSHHost, CustomSSHHost } from '../../shared/types'
import type Database from 'better-sqlite3'

export function parseSSHConfig(): SSHHost[] {
  const configPath = join(homedir(), '.ssh', 'config')
  if (!existsSync(configPath)) return []

  const raw = readFileSync(configPath, 'utf-8')
  const config = SSHConfig.parse(raw)
  const hosts: SSHHost[] = []

  for (const section of config) {
    if (section.type !== 1) continue // only Host directives
    const param = section.param
    if (param !== 'Host') continue

    const alias = section.value as string
    if (!alias || alias === '*') continue

    const computed = config.compute(alias)
    hosts.push({
      alias,
      hostname: (computed['HostName'] as string) || alias,
      user: (computed['User'] as string) || 'root',
      port: parseInt(computed['Port'] as string) || 22,
      identityFile: Array.isArray(computed['IdentityFile'])
        ? computed['IdentityFile'][0]
        : (computed['IdentityFile'] as string) || null,
      isCustom: false
    })
  }

  return hosts
}

export function getCustomHosts(db: Database.Database): SSHHost[] {
  const rows = db
    .prepare('SELECT * FROM custom_ssh_hosts ORDER BY alias')
    .all() as CustomSSHHost[]

  return rows.map((row) => ({
    alias: row.alias,
    hostname: row.hostname,
    user: row.user,
    port: row.port,
    identityFile: row.identity_file,
    isCustom: true
  }))
}

export function getAllHosts(db: Database.Database): SSHHost[] {
  const sshHosts = parseSSHConfig()
  const customHosts = getCustomHosts(db)
  return [...sshHosts, ...customHosts]
}
