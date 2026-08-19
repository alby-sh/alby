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

/**
 * Render terminals on the GPU via @xterm/addon-webgl.
 *
 * Off. The addon draws glyphs from a texture atlas it builds itself, and when
 * that atlas stops agreeing with the grid the result is text drawn doubled or
 * on top of itself — legible again after a resize forces a rebuild, wrong again
 * as soon as more is typed. Nothing in this codebase ever called
 * clearTextureAtlas, which is the documented way to keep the two in step.
 *
 * It also attaches asynchronously and re-lays out the viewport when it does,
 * which is why the panel carried a fit at rAF, another 80 ms later, and further
 * re-measures on top: each was an attempt to land after an event with no fixed
 * timing. On a cold start, competing with every SSH connection the app opens at
 * once, it lost anyway and the pane kept the geometry it had before.
 *
 * xterm's DOM renderer has neither problem. It costs more per frame on heavy
 * output, which is a real trade and the reason this is a flag rather than a
 * deletion — but a terminal that renders wrong is not worth the frames.
 */
export const USE_WEBGL_RENDERER = false
