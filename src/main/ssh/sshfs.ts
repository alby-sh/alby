import { execSync, exec } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { Environment } from '../../shared/types'

const mountPoints: Map<string, string> = new Map()

function getMountDir(): string {
  const dir = join(app.getPath('userData'), 'mounts')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getMountPoint(env: Environment): string | undefined {
  return mountPoints.get(env.id)
}

export function isMounted(env: Environment): boolean {
  const mp = mountPoints.get(env.id)
  if (!mp) return false
  try {
    execSync(`mount | grep "${mp}"`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export async function ensureMounted(env: Environment): Promise<string> {
  if (isMounted(env)) return mountPoints.get(env.id)!

  const mountDir = getMountDir()
  const mountPoint = join(mountDir, env.id)
  mkdirSync(mountPoint, { recursive: true })

  const sshTarget = `${env.ssh_user || 'root'}@${env.ssh_host}:${env.remote_path}`
  const portFlag = env.ssh_port !== 22 ? `-p ${env.ssh_port}` : ''
  const keyFlag = env.ssh_key_path ? `-o IdentityFile=${env.ssh_key_path}` : ''

  const cmd = `sshfs ${sshTarget} "${mountPoint}" ${portFlag} ${keyFlag} -o reconnect,ServerAliveInterval=15,ServerAliveCountMax=3`

  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) {
        reject(new Error(`SSHFS mount failed: ${err.message}`))
      } else {
        mountPoints.set(env.id, mountPoint)
        resolve(mountPoint)
      }
    })
  })
}

export function unmount(env: Environment): void {
  const mp = mountPoints.get(env.id)
  if (!mp) return
  try {
    execSync(`umount "${mp}"`, { stdio: 'pipe' })
  } catch {
    try {
      execSync(`diskutil unmount force "${mp}"`, { stdio: 'pipe' })
    } catch {
      // ignore
    }
  }
  mountPoints.delete(env.id)
}

export function unmountAll(): void {
  for (const [, mp] of mountPoints) {
    try {
      execSync(`umount "${mp}"`, { stdio: 'pipe' })
    } catch {
      // ignore
    }
  }
  mountPoints.clear()
}

export function isSSHFSAvailable(): boolean {
  try {
    execSync('which sshfs', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
