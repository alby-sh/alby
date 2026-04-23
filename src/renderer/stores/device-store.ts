import { create } from 'zustand'
import { useEffect } from 'react'

/**
 * This install's device identity (UUID + hostname), fetched once from the
 * main process at app boot and cached here so sidebar rows can compare
 * `agent.device_id === ours` synchronously on every render.
 *
 * The id is stable per installation (main/device/device-id.ts persists it
 * in userData). Fresh installs get a new id — which is fine, their agents
 * just start tagged with that new id and stay attributable to the new
 * device going forward.
 */

interface DeviceState {
  id: string | null
  name: string | null
  initialized: boolean
  load: () => Promise<void>
}

export const useDeviceStore = create<DeviceState>((set) => ({
  id: null,
  name: null,
  initialized: false,

  load: async () => {
    try {
      const info = (await (window as unknown as {
        electronAPI?: { device?: { info: () => Promise<{ device_id: string; device_name: string }> } }
      }).electronAPI?.device?.info?.()) as { device_id: string; device_name: string } | undefined
      if (info) {
        set({ id: info.device_id, name: info.device_name, initialized: true })
      } else {
        set({ initialized: true })
      }
    } catch {
      set({ initialized: true })
    }
  },
}))

/** Mount once, near the app root, so the device id is ready before any
 *  sidebar render tries to consult it. One IPC call at boot, no polling —
 *  the hostname changes rarely enough that a refresh-on-rename isn't worth
 *  the round-trips. */
export function useDeviceBootstrap(): void {
  const load = useDeviceStore((s) => s.load)
  const initialized = useDeviceStore((s) => s.initialized)
  useEffect(() => {
    if (!initialized) void load()
  }, [initialized, load])
}

/**
 * Convenience selector for sidebar / MainArea: given an agent row, does
 * its PTY live on a DIFFERENT Mac than this one, and is it a local (not
 * remote-tmux) agent? When true the UI must render a read-only banner
 * and block attach / kill / delete — those are enforced again in the main
 * process's IPC guards, this is just the visual half.
 *
 * Legacy agents without `device_id` (spawned before 0.8.3 shipped) return
 * false — they predate the ownership field, and we don't have enough
 * info to classify them as "foreign", so we fall back to the old
 * behaviour (interactive on every client).
 */
export function isForeignLocalAgent(agent: {
  device_id?: string | null
  execution_mode?: 'local' | 'remote' | null
}, ourDeviceId: string | null): boolean {
  if (!ourDeviceId) return false
  if (agent.execution_mode !== 'local') return false
  if (!agent.device_id) return false
  return agent.device_id !== ourDeviceId
}
