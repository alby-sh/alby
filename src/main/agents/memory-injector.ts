import type { Client } from 'ssh2'
import type { Task, Environment } from '../../shared/types'

function readRemoteFile(conn: Client, path: string): Promise<string | null> {
  return new Promise((resolve) => {
    conn.exec(`cat '${path}' 2>/dev/null`, (err, channel) => {
      if (err) return resolve(null)
      let output = ''
      channel.on('data', (d: Buffer) => {
        output += d.toString()
      })
      channel.stderr.on('data', () => {
        // ignore stderr
      })
      channel.on('close', (code: number) => {
        resolve(code === 0 ? output : null)
      })
    })
  })
}

export async function buildContext(
  task: Task,
  env: Environment,
  sshClient: Client | null
): Promise<string> {
  const parts: string[] = []

  // 1. Read CLAUDE.md from remote server
  if (sshClient) {
    try {
      const claudeMd = await readRemoteFile(sshClient, `${env.remote_path}/CLAUDE.md`)
      if (claudeMd?.trim()) {
        parts.push(`# Project Context (from CLAUDE.md)\n${claudeMd}`)
      }
    } catch {
      // CLAUDE.md not found, skip
    }
  }

  // 2. Task-level context from local DB
  if (task.context_notes?.trim()) {
    parts.push(`# Task Context\n${task.context_notes}`)
  }

  // 3. Task description
  if (task.description?.trim()) {
    parts.push(`# Task Description\n${task.description}`)
  }

  return parts.join('\n\n---\n\n')
}
