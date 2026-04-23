/** Tab-name prefix that marks an agent as the env's "launch command" runner.
 *  Set by LaunchPlayButton (renderer) right after spawning a 'terminal' agent
 *  for the env's `launch_command`. The prefix itself is the only state we
 *  persist for launch agents — no DB column, no `agent_kind` field — so any
 *  code in main or renderer that needs to recognise a launch agent must
 *  import these helpers instead of hardcoding the marker.
 *
 *  Used today by:
 *   - renderer/components/layout/Sidebar.tsx → LaunchPlayButton render + Stop
 *   - main/agents/agent-manager.ts → port-forwarding lifecycle
 */
export const LAUNCH_TAB_PREFIX = '▶ '

export const isLaunchTabName = (name: string | null | undefined): boolean =>
  !!name && name.startsWith(LAUNCH_TAB_PREFIX)
