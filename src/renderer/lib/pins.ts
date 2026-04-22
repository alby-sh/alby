import type { Environment } from '../../shared/types'
import type { EnvTabKey, StackTabKey } from '../stores/app-store'

/** Full pin key format stored in the app-store. */
export function pinKey(kind: 'env' | 'stack', id: string, tab: string): string {
  return `${kind}:${id}:${tab}`
}
export function containerKeyForEnv(envId: string): string {
  return `env:${envId}`
}
export function containerKeyForStack(stackId: string): string {
  return `stack:${stackId}`
}

/** Which tabs can be pinned at all (Settings is always excluded — it opens a
 *  modal, not a tab view). Used by EnvTabsView / StackTabsView to decide
 *  whether to render a pin icon next to a tab header. */
export const PINNABLE_ENV_TABS: readonly EnvTabKey[] = [
  'sessions',
  'files',
  'routines',
  'github',
  'deploy',
  'terminals',
]
export const PINNABLE_STACK_TABS: readonly StackTabKey[] = [
  // Overview is intentionally excluded — clicking the stack header already
  // lands there, pinning it would just duplicate the default action.
  'issues',
  'tasks',
]

/** Which pinned tabs open as expandable sub-menus in the sidebar. Everything
 *  else renders as a single leaf row that just routes to the tab view. */
export const EXPANDABLE_ENV_TABS: ReadonlySet<EnvTabKey> = new Set<EnvTabKey>([
  'sessions',
  'files',
  'routines',
  'terminals',
])
export const EXPANDABLE_STACK_TABS: ReadonlySet<StackTabKey> = new Set<StackTabKey>([
  // Issues + Tasks explicitly stay as leaves per product call — the list
  // view in the main area handles sorting/filtering and we don't want to
  // duplicate it cramped inside the sidebar.
])

/** Per-env default pins applied when the user hasn't customized pinning yet
 *  for that env. Operational envs land on Sessions; deploy envs surface a
 *  Terminals shortcut since that's the closest analog (they have no AI
 *  sessions). Empty array disables defaults entirely. */
export function defaultPinsForEnv(env: Pick<Environment, 'role'>): EnvTabKey[] {
  if (env.role === 'deploy') return ['terminals']
  return ['sessions']
}

/** Stacks default-pin Issues so new errors are one click away — the stack
 *  header click still lands on Overview for discovery, but the user sees
 *  the issues count in the sidebar without any setup. */
export function defaultPinsForStack(): StackTabKey[] {
  return ['issues']
}

/** Compute the effective ordered pin list for a container. When the user
 *  hasn't touched pinning yet (missing key), we overlay the defaults; after
 *  the first toggle/reorder, pinOrder is authoritative — including an empty
 *  array meaning "explicitly cleared, don't re-add Sessions". */
export function effectivePins(
  pinOrder: Record<string, string[]>,
  containerKey: string,
  defaults: string[],
): string[] {
  const stored = pinOrder[containerKey]
  return stored ?? defaults
}
