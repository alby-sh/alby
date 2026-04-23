import { ipcMain } from 'electron'
import type { AgentManager } from '../agents/agent-manager'

/**
 * IPC for the SSH localhost-port forwarding feature.
 *
 * Reads only — port forwarding lifecycle is fully driven by AgentManager
 * (spawn/exit of launch agents, stdout regex). The renderer never asks
 * to "open this port"; it just renders what main is already doing and
 * subscribes to `ports:change` / `ports:port-opened` push events.
 *
 * See:
 *   - src/main/ssh/port-forwarder.ts (per-agent net.Server + ssh2 forwardOut)
 *   - src/main/ssh/port-detector.ts  (regex parser, no SSH calls)
 *   - src/main/agents/agent-manager.ts (lifecycle hooks)
 */
export function registerPortsIPC(agentManager: AgentManager): void {
  ipcMain.handle('ports:list-by-agent', (_, agentId: string) => {
    return agentManager.listForwardedPorts(agentId)
  })

  ipcMain.handle('ports:list-by-env', (_, envId: string) => {
    return agentManager.listForwardedPortsForEnv(envId)
  })
}
