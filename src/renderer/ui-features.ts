/**
 * Entry points hidden from the main shell.
 *
 * Both features stay wired up underneath — this only decides whether the
 * normal sidebar-plus-main-area shell offers a way in.
 *
 * ISSUES_UI is deliberately *not* consulted by IssuerShell. A workspace role of
 * `issuer` has exactly one capability, `report_issue`, and IssuerShell is the
 * whole interface those users get; gating it here would drop them into the
 * developer shell — sidebar, terminals, SSH to production — which is the one
 * thing that role exists to prevent. Same reasoning for `viewer` and `analyst`,
 * whose capabilities are mostly issue-shaped.
 *
 * TASKS_UI hides the tab and the tree rows, not the records. Every agent hangs
 * off a task through `agents.task_id`, so tasks keep being created and used as
 * the container they always were — they just stop being something to look at.
 */
export const SHOW_ISSUES_UI = false
export const SHOW_TASKS_UI = false
